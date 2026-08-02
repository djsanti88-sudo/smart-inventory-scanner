import "server-only";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";

// Ladder storage seam. SERVER-SIDE ONLY.
//
// The Go-UPC rung needs three durable stores: a monthly usage counter (Task 5),
// a negative miss-cache keyed by canonical GTIN (Task 7), and an append-only raw
// decode archive (Task 2). Tasks 2, 5, and 7 consume ONLY this interface -- never
// fs directly -- so the Turso adapter (Task 21) swaps in without touching rung logic.
//
// The file-backed adapter is for local dev + Vercel preview only. Vercel production
// MUST NOT ship on it: function-instance file writes are ephemeral there (the
// "Knowledge DB dead on Vercel" lesson). Production uses the Turso adapter.

/** Monthly Go-UPC usage counter. `month` is a `YYYY-MM` key. */
export interface UsageState {
  month: string;
  used: number;
}

/** A negative-cache entry: a canonical GTIN that Go-UPC returned a genuine miss for. */
export interface MissEntry {
  canonical: string;
  missedAt: string;
  ttlDays: number;
}

/** One archived paid-decode response (raw JSON + provenance). Purge-proof evidence. */
export interface DecodeArchiveEntry {
  code: string;
  canonicalGtin: string;
  provider: "go-upc" | "fetchv2" | "gpt-5.5";
  httpStatus?: number;
  raw: unknown;
  sourceUrls?: string[];
  fetchedAt: string;
}

/**
 * A4 (owner-ratified 2026-07-15, "trace every non-decode"): one append-only outcome row per decode
 * request, recorded at the runDecodePipeline OUTER choke point so it sees every exit -- Plan D's
 * verified early return, an escalation/free-ladder win, a full paid-ladder win, a total all-rung
 * miss, AND a cap_blocked request (see AM-5). Never used to decide truth or gate behavior; it is a
 * trace record only, append-only like DecodeArchiveEntry above.
 */
export interface DecodeOutcomeEntry {
  code: string;
  /** `canonicalGtin(code) ?? code`. */
  canonicalGtin: string;
  /** The rung that settled the ladder, or null for a total miss / cap block. */
  settledBy: string | null;
  /** The decision status (e.g. "verified" / "suggested" / "needs_review"), or "cap_blocked". A
   *  cached/replayed hit is recorded with its status prefixed "cached:" so replays are
   *  distinguishable from a fresh compute in the rollup. */
  status: string;
  reasons: Array<{ rung: string; reason: string }>;
  durationMs: number;
  /** `classifySourceTier` output, or null when the outcome did not come from a paid stage. */
  sourceTier: string | null;
  createdAt: string;
}

/**
 * Async on every method: the Turso adapter (Task 21) is a network client, so the interface is
 * honestly async everywhere rather than faking sync via a hidden write-queue / read-through cache
 * (that would be a data-race risk across concurrent function instances). The file adapter's fs
 * calls stay synchronous internally; they are simply wrapped in an `async` function, which resolves
 * immediately and costs nothing extra in practice.
 */
export interface LadderStorage {
  readUsage(): Promise<UsageState>;
  writeUsage(s: UsageState): Promise<void>;
  /**
   * Atomically increment the usage counter for `month` and return the NEW total.
   * This is the counter that enforces the Go-UPC monthly spend cap, so it must never be a
   * JS-side read-modify-write: two concurrent serverless instances doing readUsage() then
   * writeUsage(used+1) can both read the same `used`, and one increment is silently lost,
   * which means the cap can be overrun. Implementations must perform the increment as a
   * single atomic operation (in-SQL `used = used + 1` for Turso).
   */
  incrementUsage(month: string): Promise<number>;
  readMissCache(key: string): Promise<MissEntry | null>;
  writeMissCache(key: string, e: MissEntry): Promise<void>;
  appendArchive(entry: DecodeArchiveEntry): Promise<void>;
  /**
   * A4: append one decode outcome trace row. Same append-only contract as appendArchive (JSONL for
   * the file adapter, INSERT-only for Turso -- never UPDATE/DELETE). Best-effort by convention at the
   * call site (pipeline.ts wraps this in a fire-and-forget try/catch); the interface itself just
   * appends and lets a genuine storage failure reject normally.
   */
  appendOutcome(entry: DecodeOutcomeEntry): Promise<void>;
  /**
   * Generic atomic get/increment over an arbitrary string key, backing the daily AI-lookup spend
   * cap (see src/services/security/aiSpendGuard.ts's chargeDailySlot/readDailyUsed). Same atomicity
   * contract as incrementUsage: never a JS-side read-modify-write, so concurrent serverless
   * instances can never lose an increment to a race. `get`/`set` are the read/write halves callers
   * outside the ladder module use (a read-only peek must never touch `increment`).
   */
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  increment(key: string): Promise<number>;
  /**
   * Atomically add `delta` (may be any integer, not just 1) to the counter at `key` and return the
   * NEW total. Same atomicity contract as `increment`: the Turso adapter computes the sum IN SQL
   * (`value = CAST(value AS INTEGER) + ?`), never a JS-side read-modify-write, so concurrent
   * serverless instances writing to the SAME key can never lose an update to a race. Backs the GPT
   * ladder dollar guard's per-call spend deltas (see recordGptLadderSpend in aiSpendGuard.ts), which
   * previously used get-then-set and could undercount concurrent spend.
   */
  incrementBy(key: string, delta: number): Promise<number>;
}

const USAGE_FILE = ".go-upc-usage.json";
const MISS_FILE = ".go-upc-miss-cache.json";
const ARCHIVE_SUBDIR = "decode-archive";
const OUTCOMES_SUBDIR = "decode-outcomes";
const KV_FILE = ".ladder-kv.json";

function currentMonth(now: () => Date): string {
  return now().toISOString().slice(0, 7); // YYYY-MM
}

/** Read + JSON.parse a file, returning `fallback` on missing file or corrupt JSON (never throws). */
function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (err) {
    console.warn(`[ladderStorage] corrupt JSON at ${path}, using default:`, err);
    return fallback;
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value), "utf8");
}

/**
 * File-backed LadderStorage under `dir`:
 *  - usage  -> `<dir>/.go-upc-usage.json`         (JSON `{ month, used }`)
 *  - miss   -> `<dir>/.go-upc-miss-cache.json`     (JSON map `{ [canonical]: MissEntry }`)
 *  - archive-> `<dir>/decode-archive/<YYYY-MM>.jsonl` (append-only JSONL, bucketed by entry month)
 * The dir is created lazily on first write. Reads of corrupt data degrade to defaults with a warn.
 */
export function fileLadderStorage(dir: string, options?: { now?: () => Date }): LadderStorage {
  const now = options?.now ?? (() => new Date());
  const usagePath = join(dir, USAGE_FILE);
  const missPath = join(dir, MISS_FILE);
  const archiveDir = join(dir, ARCHIVE_SUBDIR);
  const outcomesDir = join(dir, OUTCOMES_SUBDIR);
  const kvPath = join(dir, KV_FILE);

  function ensureDir(target: string): void {
    if (!existsSync(target)) mkdirSync(target, { recursive: true });
  }

  return {
    async readUsage(): Promise<UsageState> {
      return readJson<UsageState>(usagePath, { month: currentMonth(now), used: 0 });
    },

    async writeUsage(s: UsageState): Promise<void> {
      ensureDir(dir);
      writeJson(usagePath, s);
    },

    async incrementUsage(month: string): Promise<number> {
      // Single-process file adapter: a plain read-modify-write is safe here (no concurrent
      // instances share this file the way serverless Turso callers do).
      ensureDir(dir);
      const current = readJson<UsageState>(usagePath, { month, used: 0 });
      const used = current.month === month ? current.used + 1 : 1;
      writeJson(usagePath, { month, used });
      return used;
    },

    async readMissCache(key: string): Promise<MissEntry | null> {
      const map = readJson<Record<string, MissEntry>>(missPath, {});
      return map[key] ?? null;
    },

    async writeMissCache(key: string, e: MissEntry): Promise<void> {
      ensureDir(dir);
      const map = readJson<Record<string, MissEntry>>(missPath, {});
      map[key] = e;
      writeJson(missPath, map);
    },

    async appendArchive(entry: DecodeArchiveEntry): Promise<void> {
      ensureDir(archiveDir);
      const month = entry.fetchedAt.slice(0, 7); // YYYY-MM from fetchedAt
      const monthFile = join(archiveDir, `${month}.jsonl`);
      appendFileSync(monthFile, JSON.stringify(entry) + "\n", "utf8");
    },

    async appendOutcome(entry: DecodeOutcomeEntry): Promise<void> {
      ensureDir(outcomesDir);
      const month = entry.createdAt.slice(0, 7); // YYYY-MM from createdAt
      const monthFile = join(outcomesDir, `${month}.jsonl`);
      appendFileSync(monthFile, JSON.stringify(entry) + "\n", "utf8");
    },

    async get(key: string): Promise<string | null> {
      const map = readJson<Record<string, string>>(kvPath, {});
      return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
    },

    async set(key: string, value: string): Promise<void> {
      ensureDir(dir);
      const map = readJson<Record<string, string>>(kvPath, {});
      map[key] = value;
      writeJson(kvPath, map);
    },

    async increment(key: string): Promise<number> {
      // Single-process file adapter: same read-modify-write-inside-one-synchronous-block safety
      // as incrementUsage above (no concurrent instances share this file the way serverless Turso
      // callers do - Node's event loop never interleaves mid-synchronous-fs-call).
      ensureDir(dir);
      const map = readJson<Record<string, string>>(kvPath, {});
      const n = Number(map[key] ?? "0") + 1;
      map[key] = String(n);
      writeJson(kvPath, map);
      return n;
    },

    async incrementBy(key: string, delta: number): Promise<number> {
      // Same single-process read-modify-write-inside-one-synchronous-block safety as increment()
      // above. This IS the documented dev/no-storage fallback (see the module header comment); a
      // genuine concurrent race here is not a concern for a single-process file adapter.
      ensureDir(dir);
      const map = readJson<Record<string, string>>(kvPath, {});
      const n = Number(map[key] ?? "0") + delta;
      map[key] = String(n);
      writeJson(kvPath, map);
      return n;
    },
  };
}

// ---------------------------------------------------------------------------
// Turso adapter (Task 21) -- production. Mirrors retailKnowledgeIndex.ts's Turso
// detection/client pattern: TURSO_DATABASE_URL + TURSO_AUTH_TOKEN, lazy @libsql/client
// import, memoized client. Tables are created (CREATE TABLE IF NOT EXISTS) on first use
// per client instance so a fresh Turso DB self-provisions without a separate migration step.
// ---------------------------------------------------------------------------

/** Minimal shape of the `@libsql/client` client actually used here (same seam as retailKnowledgeIndex's TursoClient). */
export type TursoClientLike = {
  execute: (stmt: { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }>;
};

const TABLE_USAGE = "goupc_usage";
const TABLE_MISS_CACHE = "goupc_miss_cache";
const TABLE_ARCHIVE = "decode_archive";
const TABLE_KV = "ladder_kv";
const TABLE_OUTCOMES = "decode_outcomes";

/**
 * Turso-backed LadderStorage over an injected client (never constructs its own connection --
 * callers/tests inject the client so unit tests never touch a live database).
 *  - goupc_usage: one row per month, upserted (`month` PK, `used` counter).
 *  - goupc_miss_cache: one row per canonical GTIN, upserted (`canonical` PK, `missed_at`, `ttl_days`).
 *  - decode_archive: append-only INSERT, never UPDATE/DELETE (purge-proof evidence trail).
 * `CREATE TABLE IF NOT EXISTS` runs once per adapter instance (memoized), lazily on first call.
 */
export function tursoLadderStorage(client: TursoClientLike, options?: { now?: () => Date }): LadderStorage {
  const now = options?.now ?? (() => new Date());
  let ensured: Promise<void> | null = null;

  async function ensureTables(): Promise<void> {
    if (!ensured) {
      ensured = (async () => {
        await client.execute({
          sql: `CREATE TABLE IF NOT EXISTS ${TABLE_USAGE} (month TEXT PRIMARY KEY, used INTEGER NOT NULL)`,
          args: [],
        });
        await client.execute({
          sql: `CREATE TABLE IF NOT EXISTS ${TABLE_MISS_CACHE} (canonical TEXT PRIMARY KEY, missed_at TEXT NOT NULL, ttl_days INTEGER NOT NULL)`,
          args: [],
        });
        await client.execute({
          sql: `CREATE TABLE IF NOT EXISTS ${TABLE_ARCHIVE} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT NOT NULL,
            canonical_gtin TEXT NOT NULL,
            provider TEXT NOT NULL,
            http_status INTEGER,
            raw TEXT NOT NULL,
            source_urls TEXT,
            fetched_at TEXT NOT NULL
          )`,
          args: [],
        });
        await client.execute({
          sql: `CREATE TABLE IF NOT EXISTS ${TABLE_KV} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
          args: [],
        });
        await client.execute({
          sql: `CREATE TABLE IF NOT EXISTS ${TABLE_OUTCOMES} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT NOT NULL,
            canonical_gtin TEXT NOT NULL,
            settled_by TEXT,
            status TEXT NOT NULL,
            reasons TEXT NOT NULL,
            duration_ms INTEGER NOT NULL,
            source_tier TEXT,
            created_at TEXT NOT NULL
          )`,
          args: [],
        });
      })();
    }
    return ensured;
  }

  return {
    async readUsage(): Promise<UsageState> {
      await ensureTables();
      const result = await client.execute({
        sql: `SELECT month, used FROM ${TABLE_USAGE} ORDER BY month DESC LIMIT 1`,
        args: [],
      });
      if (result.rows.length === 0) {
        return { month: currentMonth(now), used: 0 };
      }
      const row = result.rows[0];
      return { month: row.month as string, used: Number(row.used) };
    },

    async writeUsage(s: UsageState): Promise<void> {
      await ensureTables();
      await client.execute({
        sql: `INSERT INTO ${TABLE_USAGE} (month, used) VALUES (?, ?)
              ON CONFLICT(month) DO UPDATE SET used = excluded.used`,
        args: [s.month, s.used],
      });
    },

    async incrementUsage(month: string): Promise<number> {
      await ensureTables();
      // Atomic in-SQL increment: `used = used + 1` is computed BY THE DATABASE, never by
      // reading the current value in JS first. This is what makes concurrent serverless
      // instances safe -- the monthly Go-UPC spend cap can never lose an increment to a race.
      const result = await client.execute({
        sql: `INSERT INTO ${TABLE_USAGE} (month, used) VALUES (?, 1)
              ON CONFLICT(month) DO UPDATE SET used = used + 1
              RETURNING used`,
        args: [month],
      });
      return Number(result.rows[0].used);
    },

    async readMissCache(key: string): Promise<MissEntry | null> {
      await ensureTables();
      const result = await client.execute({
        sql: `SELECT canonical, missed_at, ttl_days FROM ${TABLE_MISS_CACHE} WHERE canonical = ?`,
        args: [key],
      });
      if (result.rows.length === 0) return null;
      const row = result.rows[0];
      return {
        canonical: row.canonical as string,
        missedAt: row.missed_at as string,
        ttlDays: Number(row.ttl_days),
      };
    },

    async writeMissCache(key: string, e: MissEntry): Promise<void> {
      await ensureTables();
      await client.execute({
        sql: `INSERT INTO ${TABLE_MISS_CACHE} (canonical, missed_at, ttl_days) VALUES (?, ?, ?)
              ON CONFLICT(canonical) DO UPDATE SET missed_at = excluded.missed_at, ttl_days = excluded.ttl_days`,
        args: [key, e.missedAt, e.ttlDays],
      });
    },

    async appendArchive(entry: DecodeArchiveEntry): Promise<void> {
      await ensureTables();
      // Append-only: plain INSERT, no upsert/update/delete -- purge-proof evidence trail.
      await client.execute({
        sql: `INSERT INTO ${TABLE_ARCHIVE} (code, canonical_gtin, provider, http_status, raw, source_urls, fetched_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
          entry.code,
          entry.canonicalGtin,
          entry.provider,
          entry.httpStatus ?? null,
          JSON.stringify(entry.raw),
          entry.sourceUrls ? JSON.stringify(entry.sourceUrls) : null,
          entry.fetchedAt,
        ],
      });
    },

    async appendOutcome(entry: DecodeOutcomeEntry): Promise<void> {
      await ensureTables();
      // Append-only: plain INSERT, no upsert/update/delete -- same purge-proof contract as appendArchive.
      await client.execute({
        sql: `INSERT INTO ${TABLE_OUTCOMES} (code, canonical_gtin, settled_by, status, reasons, duration_ms, source_tier, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          entry.code,
          entry.canonicalGtin,
          entry.settledBy,
          entry.status,
          JSON.stringify(entry.reasons),
          entry.durationMs,
          entry.sourceTier,
          entry.createdAt,
        ],
      });
    },

    async get(key: string): Promise<string | null> {
      await ensureTables();
      const result = await client.execute({
        sql: `SELECT value FROM ${TABLE_KV} WHERE key = ?`,
        args: [key],
      });
      if (result.rows.length === 0) return null;
      return result.rows[0].value as string;
    },

    async set(key: string, value: string): Promise<void> {
      await ensureTables();
      await client.execute({
        sql: `INSERT INTO ${TABLE_KV} (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        args: [key, value],
      });
    },

    async increment(key: string): Promise<number> {
      await ensureTables();
      // Atomic in-SQL increment, same contract as incrementUsage: the database computes
      // `value + 1`, never a JS-side read-then-write, so concurrent serverless instances can
      // never lose an increment to a race (the "232/200 while ~27 paid calls happened" bug).
      const result = await client.execute({
        sql: `INSERT INTO ${TABLE_KV} (key, value) VALUES (?, '1')
              ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1
              RETURNING CAST(value AS INTEGER) AS value`,
        args: [key],
      });
      return Number(result.rows[0].value);
    },

    async incrementBy(key: string, delta: number): Promise<number> {
      await ensureTables();
      // Atomic in-SQL delta increment, same contract as increment() above but for an arbitrary
      // integer delta (not just +1): the database computes `value + delta`, never a JS-side
      // read-then-write, so two concurrent GPT ladder spend calls on the same day's key can never
      // lose an update to a race (the get-then-set bug this method replaces in recordGptLadderSpend).
      const result = await client.execute({
        sql: `INSERT INTO ${TABLE_KV} (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + ?
              RETURNING CAST(value AS INTEGER) AS value`,
        args: [key, String(delta), delta],
      });
      return Number(result.rows[0].value);
    },
  };
}

// ---------------------------------------------------------------------------
// Selector: mirrors retailKnowledgeIndex.ts's getTursoClient detection exactly --
// TURSO_DATABASE_URL + TURSO_AUTH_TOKEN both set -> Turso; otherwise the file adapter.
// A Turso client-construction failure falls back to the file adapter (loud warn, never throws),
// same fail-open posture as the retail knowledge index.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LibsqlClientModule = { createClient: (config: { url: string; authToken: string }) => any };

let _cachedTursoStorage: LadderStorage | null = null;
let _cachedTursoUnavailable = false;

async function getTursoLadderStorage(): Promise<LadderStorage | null> {
  if (_cachedTursoUnavailable) return null;
  if (_cachedTursoStorage) return _cachedTursoStorage;
  const url = process.env.TURSO_DATABASE_URL;
  const token = process.env.TURSO_AUTH_TOKEN;
  if (!url || !token) {
    _cachedTursoUnavailable = true;
    return null;
  }
  try {
    const { createClient } = (await import("@libsql/client")) as unknown as LibsqlClientModule;
    const client = createClient({ url, authToken: token }) as TursoClientLike;
    _cachedTursoStorage = tursoLadderStorage(client);
    console.log("[ladderStorage] Turso client connected:", url);
    return _cachedTursoStorage;
  } catch (e) {
    console.warn("[ladderStorage] Failed to create Turso client, falling back to file storage:", (e as Error).message);
    _cachedTursoUnavailable = true;
    return null;
  }
}

/**
 * Select the LadderStorage backend: Turso when TURSO_DATABASE_URL + TURSO_AUTH_TOKEN are set
 * (production), else the file adapter rooted at `dir` (default `process.cwd()`; local dev + preview).
 */
export async function ladderStorage(dir: string = process.cwd()): Promise<LadderStorage> {
  const turso = await getTursoLadderStorage();
  if (turso) return turso;
  return fileLadderStorage(dir);
}

/** For tests: reset the memoized Turso client/selector state so each test re-detects env vars. */
export function __resetLadderStorageSelectorForTests(): void {
  _cachedTursoStorage = null;
  _cachedTursoUnavailable = false;
}
