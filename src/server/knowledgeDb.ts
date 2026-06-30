import "server-only";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Shared SQLite knowledge database accessor. SERVER-SIDE ONLY.
// Opens the generated DB lazily on first query, caches the connection for the process lifetime
// (Fluid Compute reuses instances). Read-only: the DB is generated at build time.
//
// Falls back to null if the DB file doesn't exist (the callers fall back to JSON).
// This dual-mode means tests work with or without the DB, and development doesn't require
// running the build script first.

const DB_PATH = join(process.cwd(), "src", "server", "knowledge.generated.db");

type BetterSqlite3Database = import("better-sqlite3").Database;

let _db: BetterSqlite3Database | null | "missing" = null;

/** Get the shared read-only SQLite connection, or null if the DB file doesn't exist. */
export function getKnowledgeDb(): BetterSqlite3Database | null {
  if (_db === "missing") return null;
  if (_db) return _db;

  if (!existsSync(DB_PATH)) {
    console.warn("[knowledge-db] SQLite DB not found at", DB_PATH, "— falling back to JSON indexes");
    _db = "missing";
    return null;
  }

  try {
    // Dynamic require so the import doesn't fail at build-time type checking
    // when better-sqlite3 native bindings aren't available in the build env.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3");
    _db = new Database(DB_PATH, { readonly: true, fileMustExist: true }) as BetterSqlite3Database;
    // Performance tuning for read-only workload (no WAL — requires write access)
    (_db as BetterSqlite3Database).pragma("cache_size = -8000"); // 8MB page cache
    (_db as BetterSqlite3Database).pragma("mmap_size = 268435456"); // 256MB mmap for large file
    console.log("[knowledge-db] SQLite DB opened (read-only):", DB_PATH);
    return _db as BetterSqlite3Database;
  } catch (e) {
    console.warn("[knowledge-db] Failed to open SQLite DB:", (e as Error).message, "— falling back to JSON");
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
