// Persistent decode cache (L2). The in-memory decodeCache (src/decoding/decodeCache.ts) is L1 and
// stays exactly as-is: fast, but per-process and gone on every serverless cold start. On Vercel every
// new instance re-runs free resolution and paid decode for a code someone already scanned minutes ago on a
// different instance. This module is the durable layer consulted on an L1 miss (see route.ts):
//   - "result" entries replay a prior verified/suggested decode with zero provider work.
//   - NO-CANDIDATE ROWS ARE ABOLISHED (owner ruling 2026-08-20): a failed decode stores NOTHING.
//     Every rescan of an unresolved code re-runs the decode path. Do not reintroduce "no_result_receipt"
//     rows, cooldowns, or any other negative-result memory here - legacy rows of that kind read back as
//     a plain miss below.
//
// Backing store: Turso/libsql when TURSO_DATABASE_URL + TURSO_AUTH_TOKEN are configured (same client
// construction pattern as src/server/retail-knowledge/retailKnowledgeIndex.ts), else a best-effort JSON
// file next to the local decode usage files. Every exported function is corruption-
// and failure-tolerant: a broken file, a bad row shape, or a dead Turso connection degrades to a null
// read / a swallowed write - it NEVER throws and never crashes the decode route.
import fs from "node:fs";
import path from "node:path";
import { createTursoClient, tursoCredentialsFromEnv, type TursoClient } from "@/server/db/tursoClient";

export interface PersistedDecode {
  code: string;
  kind: "result";
  payload: string; // JSON string of the route's cached decode response
  /** Diagnostic-only: decision.status ("verified"/"suggested").
   *  Disambiguated from `sourceTier` below, which answers a different question ("which stage paid for
   *  this"), not "what did the resolver decide". */
  tier: string;
  /** The one paid source that produced this positive result. */
  sourceTier?: "gpt_5_4_mini";
  createdAt: number;
}

function asSourceTier(v: unknown): PersistedDecode["sourceTier"] {
  return v === "gpt_5_4_mini" ? v : undefined;
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
    if (!hasSourceTier) {
      // Two cold instances can both see "no column" and race the ALTER; the loser's "duplicate
      // column" error means the migration ALREADY SUCCEEDED, so it must not fail this request's
      // cache read/write (deep-review 2026-08-19, Codex finding 6: treating it as failure turned a
      // paid cache hit into a miss that could be repurchased). Any other ALTER error still fails.
      try {
        await client.execute({ sql: SOURCE_TIER_COLUMN_DDL, args: [] });
      } catch (e) {
        if (!/duplicate column/i.test((e as Error).message)) throw e;
      }
    }
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
    e.kind === "result" && // legacy "no_result_receipt" entries read back as a miss (owner 2026-08-20)
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
      // Legacy "no_result_receipt" rows are a plain MISS (owner ruling 2026-08-20: no-candidate rows
      // are abolished; a failed search stores nothing and every rescan re-runs the decode path).
      if (row.kind === "no_result_receipt") return null;
      const sourceTier = asSourceTier(row.source_tier);
      const entry: PersistedDecode = {
        code: String(row.code),
        kind: "result",
        payload: String(row.payload ?? ""),
        tier: String(row.tier ?? ""),
        ...(sourceTier ? { sourceTier } : {}),
        createdAt: Number(row.created_at) || 0,
      };
      return entry;
    }
    const store = readFileStore();
    const entry = store[key];
    if (!isValidEntry(entry)) return null;
    const sourceTier = asSourceTier((entry as { sourceTier?: unknown }).sourceTier);
    return { ...entry, ...(sourceTier ? { sourceTier } : { sourceTier: undefined }) };
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
