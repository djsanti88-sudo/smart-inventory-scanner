import "server-only";

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTursoClient, tursoCredentialsFromEnv, type TursoClient } from "@/decoding/server/tursoClient";

export interface DecodeOutcomeEntry {
  code: string;
  canonicalGtin: string;
  settledBy: string | null;
  status: string;
  reasons: Array<{ step: string; reason: string }>;
  durationMs: number;
  sourceTier: string | null;
  createdAt: string;
}

/** Shared atomic counters plus append-only decode observability. */
export interface DecodeStorage {
  appendOutcome(entry: DecodeOutcomeEntry): Promise<void>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  increment(key: string): Promise<number>;
  incrementBy(key: string, delta: number): Promise<number>;
  incrementIfBelow(key: string, limit: number): Promise<{ value: number; granted: boolean }>;
}

const KV_FILE = ".decode-kv.json";
const OUTCOMES_SUBDIR = "decode-outcomes";

function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch (error) {
    console.warn(`[decode-storage] corrupt JSON at ${file}, using default:`, error);
    return fallback;
  }
}

function ensureDirectory(directory: string): void {
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
}

/** Local/dev adapter. Synchronous read-modify-write keeps each operation atomic within one process. */
export function fileDecodeStorage(directory: string): DecodeStorage {
  const kvFile = join(directory, KV_FILE);
  const outcomesDirectory = join(directory, OUTCOMES_SUBDIR);

  const readCounters = () => readJson<Record<string, string>>(kvFile, {});
  const writeCounters = (values: Record<string, string>) => {
    ensureDirectory(directory);
    writeFileSync(kvFile, JSON.stringify(values), "utf8");
  };

  return {
    async appendOutcome(entry) {
      ensureDirectory(outcomesDirectory);
      appendFileSync(join(outcomesDirectory, `${entry.createdAt.slice(0, 7)}.jsonl`), `${JSON.stringify(entry)}\n`, "utf8");
    },

    async get(key) {
      const values = readCounters();
      return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
    },

    async set(key, value) {
      const values = readCounters();
      values[key] = value;
      writeCounters(values);
    },

    async increment(key) {
      const values = readCounters();
      const next = Number(values[key] ?? "0") + 1;
      values[key] = String(next);
      writeCounters(values);
      return next;
    },

    async incrementBy(key, delta) {
      const values = readCounters();
      const next = Number(values[key] ?? "0") + delta;
      values[key] = String(next);
      writeCounters(values);
      return next;
    },

    async incrementIfBelow(key, limit) {
      const values = readCounters();
      const current = Number(values[key] ?? "0");
      if (!(current < limit)) return { value: current, granted: false };
      const next = current + 1;
      values[key] = String(next);
      writeCounters(values);
      return { value: next, granted: true };
    },
  };
}

export type TursoClientLike = TursoClient;

const TABLE_KV = "decode_kv";
const TABLE_OUTCOMES = "decode_outcomes";

/** Production adapter. All counter arithmetic and quota decisions execute atomically in SQL. */
export function tursoDecodeStorage(client: TursoClientLike): DecodeStorage {
  let tablesReady: Promise<void> | null = null;

  function ensureTables(): Promise<void> {
    if (!tablesReady) {
      const pending = (async () => {
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
      tablesReady = pending;
      void pending.catch(() => {
        if (tablesReady === pending) tablesReady = null;
      });
    }
    return tablesReady;
  }

  return {
    async appendOutcome(entry) {
      await ensureTables();
      await client.execute({
        sql: `INSERT INTO ${TABLE_OUTCOMES}
          (code, canonical_gtin, settled_by, status, reasons, duration_ms, source_tier, created_at)
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

    async get(key) {
      await ensureTables();
      const result = await client.execute({ sql: `SELECT value FROM ${TABLE_KV} WHERE key = ?`, args: [key] });
      return result.rows.length ? String(result.rows[0].value) : null;
    },

    async set(key, value) {
      await ensureTables();
      await client.execute({
        sql: `INSERT INTO ${TABLE_KV} (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        args: [key, value],
      });
    },

    async increment(key) {
      await ensureTables();
      const result = await client.execute({
        sql: `INSERT INTO ${TABLE_KV} (key, value) VALUES (?, '1')
          ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1
          RETURNING CAST(value AS INTEGER) AS value`,
        args: [key],
      });
      return Number(result.rows[0].value);
    },

    async incrementBy(key, delta) {
      await ensureTables();
      const result = await client.execute({
        sql: `INSERT INTO ${TABLE_KV} (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + ?
          RETURNING CAST(value AS INTEGER) AS value`,
        args: [key, String(delta), delta],
      });
      return Number(result.rows[0].value);
    },

    async incrementIfBelow(key, limit) {
      await ensureTables();
      const result = await client.execute({
        sql: `INSERT INTO ${TABLE_KV} (key, value)
          SELECT ?, '1' WHERE ? > 0
          ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1
            WHERE CAST(${TABLE_KV}.value AS INTEGER) < ?
          RETURNING CAST(value AS INTEGER) AS value`,
        args: [key, limit, limit],
      });
      if (result.rows.length) return { value: Number(result.rows[0].value), granted: true };

      // The conditional statement already denied authoritatively. This read is display-only; if it
      // fails, preserve the denial with a conservative at-limit value.
      try {
        const current = await client.execute({ sql: `SELECT value FROM ${TABLE_KV} WHERE key = ?`, args: [key] });
        return { value: current.rows.length ? Number(current.rows[0].value) : 0, granted: false };
      } catch {
        return { value: limit, granted: false };
      }
    },
  };
}

let cachedTursoStorage: DecodeStorage | null = null;
// Missing credentials are stable for a warm instance. Client construction errors may be transient,
// so they fall back only for the current request and are retried on the next one.
let tursoUnavailable = false;

async function getTursoDecodeStorage(): Promise<DecodeStorage | null> {
  if (tursoUnavailable) return null;
  if (cachedTursoStorage) return cachedTursoStorage;
  const credentials = tursoCredentialsFromEnv();
  if (!credentials) {
    tursoUnavailable = true;
    return null;
  }
  try {
    cachedTursoStorage = tursoDecodeStorage(await createTursoClient(credentials));
    return cachedTursoStorage;
  } catch (error) {
    console.warn("[decode-storage] Turso unavailable, using local file storage:", (error as Error).message);
    return null;
  }
}

export async function decodeStorage(directory: string = process.cwd()): Promise<DecodeStorage> {
  return (await getTursoDecodeStorage()) ?? fileDecodeStorage(process.env.DECODE_STORAGE_DIR || directory);
}

export function __resetDecodeStorageSelectorForTests(): void {
  cachedTursoStorage = null;
  tursoUnavailable = false;
}
