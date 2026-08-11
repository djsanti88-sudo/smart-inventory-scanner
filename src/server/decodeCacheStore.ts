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
   *  "gpt_ladder" (the GPT-5.5 ladder rung), "paid_ai" (the legacy Gemini/OpenAI fast/escalation/
   *  deep-fallback path), or "paid_rung" (the Go-UPC or Fetch V2 ladder rung - PAY-ONCE rule, owner
   *  2026-07-14: persists on a verified win AND on a paid suggestion, e.g. goupc_inferred, since the
   *  paid call already happened either way). A free-rung result (tire corpus / Turso retail / Plan D)
   *  is never persisted at all (see pipeline.ts's classifySourceTier), so this field is always present
   *  whenever `kind` is "result". NOT yet stored by the Turso backend (schema unchanged by this fix -
   *  documented debt); the file-fallback backend persists it as a normal JSON property.
   */
  sourceTier?: "paid_ai" | "gpt_ladder" | "paid_rung";
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Turso/libsql (production)
// ---------------------------------------------------------------------------
type TursoClient = { execute: (stmt: { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LibsqlClientModule = { createClient: (config: { url: string; authToken: string }) => any };

let _tursoClient: TursoClient | null | "unavailable" = null;
let _tursoTableReady = false;

const DDL = "CREATE TABLE IF NOT EXISTS decode_cache (code TEXT PRIMARY KEY, kind TEXT, payload TEXT, tier TEXT, created_at INTEGER)";

async function getTursoClient(): Promise<TursoClient | null> {
  if (_tursoClient === "unavailable") return null;
  if (_tursoClient) return _tursoClient;
  const url = process.env.TURSO_DATABASE_URL;
  const token = process.env.TURSO_AUTH_TOKEN;
  if (!url || !token) { _tursoClient = "unavailable"; return null; }
  try {
    const { createClient } = (await import("@libsql/client")) as unknown as LibsqlClientModule;
    _tursoClient = createClient({ url, authToken: token }) as TursoClient;
    return _tursoClient;
  } catch {
    console.warn("[decode-cache-store] Turso client unavailable.");
    _tursoClient = "unavailable";
    return null;
  }
}

async function ensureTursoTable(client: TursoClient): Promise<boolean> {
  if (_tursoTableReady) return true;
  try {
    await client.execute({ sql: DDL, args: [] });
    _tursoTableReady = true;
    return true;
  } catch {
    console.warn("[decode-cache-store] Turso table unavailable.");
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
    const raw = JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ cacheFile(), "utf8"));
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
        sql: "SELECT code, kind, payload, tier, created_at FROM decode_cache WHERE code = ?",
        args: [key],
      });
      const row = result.rows[0];
      if (!row) return null;
      const entry: PersistedDecode = {
        code: String(row.code),
        kind: row.kind === "no_result_receipt" ? "no_result_receipt" : "result",
        payload: String(row.payload ?? ""),
        tier: String(row.tier ?? ""),
        createdAt: Number(row.created_at) || 0,
      };
      return entry;
    }
    const store = readFileStore();
    const entry = store[key];
    return isValidEntry(entry) ? entry : null;
  } catch {
    console.warn("[decode-cache-store] Turso read failed.");
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
          "INSERT INTO decode_cache (code, kind, payload, tier, created_at) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(code) DO UPDATE SET kind=excluded.kind, payload=excluded.payload, tier=excluded.tier, created_at=excluded.created_at",
        args: [normalized.code, normalized.kind, normalized.payload, normalized.tier, normalized.createdAt],
      });
      return;
    }
    const store = readFileStore();
    store[key] = normalized;
    writeFileStore(store);
  } catch {
    console.warn("[decode-cache-store] Turso write failed.");
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
  } catch {
    console.warn("[decode-cache-store] Turso delete failed.");
    // best-effort; never throw - a failed purge must never break the dispute call that triggered it
  }
}

/** Test-only: reset in-memory Turso client/table-ready state between test cases. */
export function __resetForTest(): void {
  _tursoClient = null;
  _tursoTableReady = false;
}
