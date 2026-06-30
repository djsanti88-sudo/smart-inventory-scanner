import "server-only";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Shared SQLite knowledge database accessor. SERVER-SIDE ONLY.
//
// Two modes:
//   1. LOCAL DEV: opens knowledge.generated.db directly (uncompressed, fast).
//   2. VERCEL PRODUCTION: the function bundle contains knowledge.generated.db.gz (~125MB).
//      On the first cold start, this module decompresses it to /tmp and opens from there.
//      Fluid Compute reuses instances, so subsequent requests use the cached connection.
//
// Read-only. The DB is generated at build time by scripts/build-knowledge-db.mjs.

const DB_FILENAME = "knowledge.generated.db";
const GZ_FILENAME = "knowledge.generated.db.gz";
const DB_PATH = join(process.cwd(), "src", "server", DB_FILENAME);
const GZ_PATH = join(process.cwd(), "src", "server", GZ_FILENAME);
const TMP_DB_PATH = join(tmpdir(), DB_FILENAME);

type BetterSqlite3Database = import("better-sqlite3").Database;

let _db: BetterSqlite3Database | null | "missing" = null;

/** Resolve the DB file path: prefer uncompressed, decompress .gz to /tmp if needed. */
function resolveDbPath(): string | null {
  // 1. Uncompressed DB exists (local dev, or already decompressed)
  if (existsSync(DB_PATH)) return DB_PATH;

  // 2. Already decompressed to /tmp from a prior cold start
  if (existsSync(TMP_DB_PATH)) return TMP_DB_PATH;

  // 3. Compressed .gz exists (Vercel bundle) — decompress to /tmp
  if (existsSync(GZ_PATH)) {
    try {
      console.log("[knowledge-db] Decompressing .gz to /tmp...");
      const t0 = performance.now();
      const compressed = readFileSync(GZ_PATH);
      const decompressed = gunzipSync(compressed);
      // Ensure /tmp exists (it always does on Linux/Vercel, but be safe)
      mkdirSync(tmpdir(), { recursive: true });
      writeFileSync(TMP_DB_PATH, decompressed);
      const ms = Math.round(performance.now() - t0);
      console.log(`[knowledge-db] Decompressed ${(compressed.length / 1024 / 1024).toFixed(0)}MB -> ${(decompressed.length / 1024 / 1024).toFixed(0)}MB in ${ms}ms`);
      return TMP_DB_PATH;
    } catch (e) {
      console.warn("[knowledge-db] Failed to decompress .gz:", (e as Error).message);
      return null;
    }
  }

  return null;
}

/** Get the shared read-only SQLite connection, or null if no DB is available. */
export function getKnowledgeDb(): BetterSqlite3Database | null {
  if (_db === "missing") return null;
  if (_db) return _db;

  const dbPath = resolveDbPath();
  if (!dbPath) {
    console.warn("[knowledge-db] No SQLite DB found (checked .db, /tmp, .db.gz). Run: npm run build:knowledge-db");
    _db = "missing";
    return null;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3");
    _db = new Database(dbPath, { readonly: true, fileMustExist: true }) as BetterSqlite3Database;
    (_db as BetterSqlite3Database).pragma("cache_size = -8000");
    (_db as BetterSqlite3Database).pragma("mmap_size = 268435456");
    console.log("[knowledge-db] SQLite DB opened (read-only):", dbPath);
    return _db as BetterSqlite3Database;
  } catch (e) {
    console.warn("[knowledge-db] Failed to open SQLite DB:", (e as Error).message);
    _db = "missing";
    return null;
  }
}

/** Close the DB and reset the singleton. Used by tests to force re-open on next query. */
export function __resetKnowledgeDbForTests(): void {
  if (_db && _db !== "missing") {
    try { (_db as BetterSqlite3Database).close(); } catch { /* ignore */ }
  }
  _db = null;
}
