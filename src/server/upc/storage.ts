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
}

const USAGE_FILE = ".go-upc-usage.json";
const MISS_FILE = ".go-upc-miss-cache.json";
const ARCHIVE_SUBDIR = "decode-archive";

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
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
export function fileLadderStorage(dir: string): LadderStorage {
  const usagePath = join(dir, USAGE_FILE);
  const missPath = join(dir, MISS_FILE);
  const archiveDir = join(dir, ARCHIVE_SUBDIR);

  function ensureDir(target: string): void {
    if (!existsSync(target)) mkdirSync(target, { recursive: true });
  }

  return {
    async readUsage(): Promise<UsageState> {
      return readJson<UsageState>(usagePath, { month: currentMonth(), used: 0 });
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

/**
 * Turso-backed LadderStorage over an injected client (never constructs its own connection --
 * callers/tests inject the client so unit tests never touch a live database).
 *  - goupc_usage: one row per month, upserted (`month` PK, `used` counter).
 *  - goupc_miss_cache: one row per canonical GTIN, upserted (`canonical` PK, `missed_at`, `ttl_days`).
 *  - decode_archive: append-only INSERT, never UPDATE/DELETE (purge-proof evidence trail).
 * `CREATE TABLE IF NOT EXISTS` runs once per adapter instance (memoized), lazily on first call.
 */
export function tursoLadderStorage(client: TursoClientLike): LadderStorage {
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
        return { month: currentMonth(), used: 0 };
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
