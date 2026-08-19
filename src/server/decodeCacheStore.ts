// Persistent decode cache (L2). The in-memory decodeCache (src/services/ai/decodeCache.ts) is L1 and
// stays exactly as-is: fast, but per-process and gone on every serverless cold start. On Vercel every
// new instance re-runs the WHOLE free+paid ladder for a code someone already scanned minutes ago on a
// different instance. This module is the durable layer consulted on an L1 miss (see route.ts):
//   - "result" entries replay a prior verified/suggested decode with zero provider work.
//   - "no_result_receipt" entries are PERMANENT (owner rule: no auto-retry) - written only when the
//     ladder genuinely exhausted itself (the paid GPT rung ran and found nothing, or was blocked by its
//     own dollar budget), never for a transient skip (no key, e2e, non-public code, request timeout).
//     Only a request with forceRetry:true bypasses AND overwrites a receipt.
//
// Backing store: Turso/libsql when TURSO_DATABASE_URL + TURSO_AUTH_TOKEN are configured (same client
// construction pattern as src/server/retail-knowledge/retailKnowledgeIndex.ts), else a best-effort JSON
// file next to .ai-lookup-usage.json / .gpt-ladder-usage.json. Every exported function is corruption-
// and failure-tolerant: a broken file, a bad row shape, or a dead Turso connection degrades to a null
// read / a swallowed write - it NEVER throws and never crashes the decode route.
import fs from "node:fs";
import path from "node:path";
import { createTursoClient, tursoCredentialsFromEnv, type TursoClient } from "@/server/db/tursoClient";

export interface PersistedDecode {
  code: string;
  kind: "result" | "no_result_receipt";
  payload: string; // JSON string of the route's cached decode response
  /** Diagnostic-only, never read back for decision logic: decision.status ("verified"/"suggested") for a
   *  "result" entry, or the ladder-exhaustion reason ("gpt_none"; historical rows may carry
   *  "gpt_info_only" from before that tier was deleted, owner order 2026-07-06) for a
   *  "no_result_receipt" entry. Disambiguated from `sourceTier` below, which is result-only and answers
   *  a different question ("which stage paid for this"), not "what did the ladder decide". */
  tier: string;
  /** Result-only (never set on a "no_result_receipt"): which PAID stage produced this "result" -
   *  "gpt_ladder" (the GPT-5.5 ladder rung), "paid_ai" (historical rows from the retired legacy
   *  Gemini/OpenAI path), or "paid_rung" (the Go-UPC or Fetch V2 ladder rung - PAY-ONCE rule, owner
   *  2026-07-14: persists on a verified win AND on a paid suggestion, e.g. goupc_inferred, since the
   *  paid call already happened either way). A free suggestion that paid rungs failed to beat persists
   *  WITHOUT a sourceTier (pay-once marker lives in the payload). pipeline.ts reads this back to keep
   *  "a bare free title must not overwrite an identity the app already bought" honest, so BOTH
   *  backends must persist it: the file backend as a JSON property, Turso in the `source_tier`
   *  column (added 2026-08-19 as an idempotent ALTER; before that Turso dropped it and the rule was
   *  silently inverted in production).
   */
  sourceTier?: "paid_ai" | "gpt_ladder" | "paid_rung";
  createdAt: number;
}

// A NULL column (rows written before the source_tier ALTER) and an unrecognized string both read back
// as undefined, i.e. "unknown tier", exactly the pre-column behavior for that row.
const SOURCE_TIERS = ["paid_ai", "gpt_ladder", "paid_rung"] as const;
function asSourceTier(v: unknown): PersistedDecode["sourceTier"] {
  return SOURCE_TIERS.find((tier) => tier === v);
}

// ---------------------------------------------------------------------------
// Turso/libsql (production)
// ---------------------------------------------------------------------------
let _tursoClient: TursoClient | null | "unavailable" = null;
let _tursoTableReady = false;

const DDL = "CREATE TABLE IF NOT EXISTS decode_cache (code TEXT PRIMARY KEY, kind TEXT, payload TEXT, tier TEXT, created_at INTEGER)";
// Additive, idempotent schema step: rows written before 2026-08-19 simply read back with a NULL
// source_tier (= "unknown", treated exactly like the pre-fix behavior for that row). Rollback is
// ignoring the column; nothing else depends on it.
const SOURCE_TIER_COLUMN_DDL = "ALTER TABLE decode_cache ADD COLUMN source_tier TEXT";

async function getTursoClient(): Promise<TursoClient | null> {
  if (_tursoClient === "unavailable") return null;
  if (_tursoClient) return _tursoClient;
  const creds = tursoCredentialsFromEnv();
  if (!creds) { _tursoClient = "unavailable"; return null; }
  try {
    _tursoClient = await createTursoClient(creds);
    return _tursoClient;
  } catch (e) {
    console.warn("[decode-cache-store] Failed to create Turso client:", (e as Error).message);
    _tursoClient = "unavailable";
    return null;
  }
}

async function ensureTursoTable(client: TursoClient): Promise<boolean> {
  if (_tursoTableReady) return true;
  try {
    await client.execute({ sql: DDL, args: [] });
    const columns = await client.execute({ sql: "PRAGMA table_info(decode_cache)", args: [] });
    const hasSourceTier = columns.rows.some((r) => String(r.name) === "source_tier");
    if (!hasSourceTier) await client.execute({ sql: SOURCE_TIER_COLUMN_DDL, args: [] });
    _tursoTableReady = true;
    return true;
  } catch (e) {
    console.warn("[decode-cache-store] Failed to ensure decode_cache table:", (e as Error).message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// File fallback (local dev / no Turso configured)
// ---------------------------------------------------------------------------
function cacheFile(): string {
  return process.env.DECODE_CACHE_FILE || path.resolve(".decode-cache.json");
}

type FileShape = Record<string, PersistedDecode>;

function isValidEntry(v: unknown): v is PersistedDecode {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.code === "string" &&
    (e.kind === "result" || e.kind === "no_result_receipt") &&
    typeof e.payload === "string" &&
    typeof e.tier === "string" &&
    typeof e.createdAt === "number"
  );
}

function readFileStore(): FileShape {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(), "utf8"));
    if (raw && typeof raw === "object") return raw as FileShape;
  } catch {
    // no file yet / unreadable / corrupted JSON -> treat as empty, self-heals on next write
  }
  return {};
}

function writeFileStore(store: FileShape): void {
  try {
    fs.writeFileSync(cacheFile(), JSON.stringify(store));
  } catch {
    // best-effort persistence (e.g. read-only serverless FS, impossible path); L1 in-memory still
    // covers repeats within this process
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Read a persisted decode for a code. Returns null on a genuine miss OR any storage failure/corruption. */
export async function getPersistedDecode(code: string): Promise<PersistedDecode | null> {
  const key = (code ?? "").trim();
  if (!key) return null;
  try {
    const client = await getTursoClient();
    if (client) {
      const ready = await ensureTursoTable(client);
      if (!ready) return null;
      const result = await client.execute({
        sql: "SELECT code, kind, payload, tier, source_tier, created_at FROM decode_cache WHERE code = ?",
        args: [key],
      });
      const row = result.rows[0];
      if (!row) return null;
      const sourceTier = asSourceTier(row.source_tier);
      const entry: PersistedDecode = {
        code: String(row.code),
        kind: row.kind === "no_result_receipt" ? "no_result_receipt" : "result",
        payload: String(row.payload ?? ""),
        tier: String(row.tier ?? ""),
        ...(sourceTier ? { sourceTier } : {}),
        createdAt: Number(row.created_at) || 0,
      };
      return entry;
    }
    const store = readFileStore();
    const entry = store[key];
    return isValidEntry(entry) ? entry : null;
  } catch (e) {
    console.warn("[decode-cache-store] getPersistedDecode failed:", (e as Error).message);
    return null;
  }
}

/** Upsert a persisted decode entry by code. Best-effort: never throws, even on total storage failure. */
export async function persistDecode(entry: PersistedDecode): Promise<void> {
  const key = (entry.code ?? "").trim();
  if (!key) return;
  const normalized: PersistedDecode = { ...entry, code: key };
  try {
    const client = await getTursoClient();
    if (client) {
      const ready = await ensureTursoTable(client);
      if (!ready) return;
      await client.execute({
        sql:
          "INSERT INTO decode_cache (code, kind, payload, tier, source_tier, created_at) VALUES (?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(code) DO UPDATE SET kind=excluded.kind, payload=excluded.payload, tier=excluded.tier, source_tier=excluded.source_tier, created_at=excluded.created_at",
        args: [normalized.code, normalized.kind, normalized.payload, normalized.tier, normalized.sourceTier ?? null, normalized.createdAt],
      });
      return;
    }
    const store = readFileStore();
    store[key] = normalized;
    writeFileStore(store);
  } catch (e) {
    console.warn("[decode-cache-store] persistDecode failed:", (e as Error).message);
    // best-effort; never throw - a broken persistent cache must never break a live decode
  }
}

/**
 * Delete a persisted decode entry by code (catalog revocation round, design §4 "independent replay
 * layers below the master rung"): when a shop disputes a catalog entry, this L2 cache is a second
 * place the SAME pre-dispute (possibly wrong) decode result could keep replaying from even after
 * the master catalogEntries doc has been demoted - so the dispute handler purges it here too.
 * Best-effort like every other export in this module: never throws, a missing/absent entry or a
 * storage failure is silently treated as "nothing to delete" so a cache-purge hiccup can never fail
 * the dispute itself.
 */
export async function deletePersistedDecode(code: string): Promise<void> {
  const key = (code ?? "").trim();
  if (!key) return;
  try {
    const client = await getTursoClient();
    if (client) {
      const ready = await ensureTursoTable(client);
      if (!ready) return;
      await client.execute({ sql: "DELETE FROM decode_cache WHERE code = ?", args: [key] });
      return;
    }
    const store = readFileStore();
    if (key in store) {
      delete store[key];
      writeFileStore(store);
    }
  } catch (e) {
    console.warn("[decode-cache-store] deletePersistedDecode failed:", (e as Error).message);
    // best-effort; never throw - a failed purge must never break the dispute call that triggered it
  }
}

/** Test-only: reset in-memory Turso client/table-ready state between test cases. */
export function __resetForTest(): void {
  _tursoClient = null;
  _tursoTableReady = false;
}
