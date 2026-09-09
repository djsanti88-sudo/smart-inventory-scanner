import "server-only";
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
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
const MANIFEST_FILENAME = "knowledge.generated.manifest.json";
const DB_PATH = join(process.cwd(), "src", "decoding", "server", "knowledge", DB_FILENAME);
const GZ_PATH = join(process.cwd(), "src", "decoding", "server", "knowledge", GZ_FILENAME);
const MANIFEST_PATH = join(process.cwd(), "src", "decoding", "server", "knowledge", MANIFEST_FILENAME);
const TMP_DB_PATH = join(tmpdir(), DB_FILENAME);

// Build-prevention item 4 ("Never Again" package, fail-loud provisioning): a fresh git worktree
// carries no local knowledge.generated.db. Without this guard, resolveDbPath silently fell back to
// whatever copy happened to already sit in os.tmpdir() from a totally unrelated, possibly ancient
// session -- which manufactured phantom test failures that looked like real regressions (confirmed
// pattern: a real stale June-29 temp copy coexisted with fresh copies on this machine). A temp copy
// older than this bound is refused with a loud, actionable error instead of being served silently.
export const TEMP_DB_STALENESS_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

type BetterSqlite3Database = import("better-sqlite3").Database;

let _db: BetterSqlite3Database | null | "missing" = null;
let _warnedStaleTempOnce = false;

type ResolveDbPathPaths = { dbPath: string; gzPath: string; tmpDbPath: string };

/** Resolve the DB file path: prefer uncompressed, decompress .gz to /tmp if needed. */
function resolveDbPath(paths: ResolveDbPathPaths = { dbPath: DB_PATH, gzPath: GZ_PATH, tmpDbPath: TMP_DB_PATH }): string | null {
  const { dbPath, gzPath, tmpDbPath } = paths;

  // 1. Uncompressed DB exists (local dev, or already decompressed)
  if (existsSync(dbPath)) return dbPath;

  // 2. Already decompressed to /tmp from a prior cold start (Vercel) OR left over from some
  //    unrelated prior process/worktree (local dev/test) -- these two cases must be told apart.
  if (existsSync(tmpDbPath)) {
    const ageMs = Date.now() - statSync(tmpDbPath).mtimeMs;
    if (ageMs > TEMP_DB_STALENESS_MS) {
      const ageDays = (ageMs / (24 * 60 * 60 * 1000)).toFixed(1);
      throw new Error(
        `[knowledge-db] Refusing to use a STALE temp DB copy at ${tmpDbPath} (${ageDays} days old, ` +
          `> 7 day staleness bound). This looks like a leftover copy from an unrelated worktree or ` +
          `session, not a legitimate Vercel gz-decompress cache. A fresh worktree/checkout needs its ` +
          `own corpus DB provisioned -- run: node scripts/provision-worktree.mjs (or npm run ` +
          `build:knowledge-db to regenerate from source). Refusing to silently serve stale data that ` +
          `would produce phantom test failures.`,
      );
    }
    if (!_warnedStaleTempOnce) {
      console.warn(
        `[knowledge-db] Using a temp DB copy at ${tmpDbPath} (${(ageMs / (60 * 60 * 1000)).toFixed(1)}h old). ` +
          `If this worktree should have its own corpus DB, run: node scripts/provision-worktree.mjs`,
      );
      _warnedStaleTempOnce = true;
    }
    return tmpDbPath;
  }

  // 3. Compressed .gz exists (Vercel bundle) — decompress to /tmp
  if (existsSync(gzPath)) {
    try {
      console.log("[knowledge-db] Decompressing .gz to /tmp...");
      const t0 = performance.now();
      const compressed = readFileSync(gzPath);
      const decompressed = gunzipSync(compressed);
      // Ensure the temp dir exists (it always does on Linux/Vercel, but be safe)
      mkdirSync(dirname(tmpDbPath), { recursive: true });
      writeFileSync(tmpDbPath, decompressed);
      const ms = Math.round(performance.now() - t0);
      console.log(`[knowledge-db] Decompressed ${(compressed.length / 1024 / 1024).toFixed(0)}MB -> ${(decompressed.length / 1024 / 1024).toFixed(0)}MB in ${ms}ms`);
      return tmpDbPath;
    } catch (e) {
      console.warn("[knowledge-db] Failed to decompress .gz:", (e as Error).message);
      return null;
    }
  }

  return null;
}

/** Test-only hook: exercise resolveDbPath with injected paths, isolated from module singletons. */
export function __resolveDbPathForTests(paths: ResolveDbPathPaths): string | null {
  _warnedStaleTempOnce = false;
  return resolveDbPath(paths);
}

// Generation-mismatch detection (DT2-1, 2026-08-13): scripts/build-knowledge-db.mjs writes its
// two paired outputs (.db and .db.gz) with two independent renameSync calls. A crash between them
// (OOM during gzip, killed CI job, power loss) can leave the .db and .db.gz describing DIFFERENT
// corpus generations -- resolveDbPath above prefers the uncompressed .db locally while Vercel
// production ships only the .gz, so without this check, local dev and production would silently
// serve different data indefinitely. The generator also writes a small manifest
// (knowledge.generated.manifest.json) recording a sha256 fingerprint (db_sha256) of the finalized,
// uncompressed DB content; decompressed .gz bytes are identical to the .db bytes at generation
// time, so the SAME field verifies whichever path resolveDbPath actually picked.
type KnowledgeDbVerifyPaths = ResolveDbPathPaths & { manifestPath: string };
type ResolveAndVerifyResult = { status: "ok"; path: string } | { status: "mismatch" } | { status: "missing" };

function sha256File(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

function readManifestDbSha256(manifestPath: string): string | null {
  try {
    if (!existsSync(manifestPath)) return null;
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    return typeof parsed?.db_sha256 === "string" && parsed.db_sha256 ? parsed.db_sha256 : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the DB path (see resolveDbPath) and, when a manifest is present, verify the resolved
 * file's content actually matches the manifest's recorded generation fingerprint before it is
 * trusted. A totally absent corpus (no db, no gz) stays the normal "missing" case -- never an
 * error. A manifest that is simply absent (older build, or before this feature existed) also does
 * NOT block opening the DB -- there is nothing to verify against, so the file is trusted as before.
 * Only an ACTUAL fingerprint mismatch is treated as an error, and even then this never throws: the
 * caller degrades to "missing" (corpus disabled for this process) so a broken generation pair can
 * never silently serve wrong data, but also never blocks scanning (TOP-LEVEL LAW: decode/corpus
 * failures only ever skip a rung with an honest reason, never crash the app).
 */
function resolveAndVerifyDbPath(paths: KnowledgeDbVerifyPaths): ResolveAndVerifyResult {
  const resolved = resolveDbPath(paths);
  if (!resolved) return { status: "missing" };

  const expected = readManifestDbSha256(paths.manifestPath);
  if (!expected) return { status: "ok", path: resolved }; // no manifest to verify against

  const actual = sha256File(resolved);
  if (!actual) return { status: "ok", path: resolved }; // couldn't hash (fs hiccup): don't block on it

  if (actual !== expected) {
    console.error(
      `[knowledge-db] MISMATCH DETECTED: ${resolved} does not match the generation fingerprint recorded in ` +
        `${paths.manifestPath}. This usually means a crashed/interrupted "npm run build:knowledge-db" left the ` +
        `.db and .db.gz pair out of sync (see DT2-1). Disabling the knowledge corpus for this process rather ` +
        `than silently serving a mismatched generation. Fix: rerun npm run build:knowledge-db. This never blocks ` +
        `scanning - the decoder skips this free source with an honest reason.`,
    );
    return { status: "mismatch" };
  }
  return { status: "ok", path: resolved };
}

/** Test-only hook: exercise resolveAndVerifyDbPath with injected paths, isolated from module singletons. */
export function __resolveAndVerifyDbPathForTests(paths: KnowledgeDbVerifyPaths): ResolveAndVerifyResult {
  _warnedStaleTempOnce = false;
  return resolveAndVerifyDbPath(paths);
}

/** Get the shared read-only SQLite connection, or null if no DB is available. */
export function getKnowledgeDb(): BetterSqlite3Database | null {
  if (_db === "missing") return null;
  if (_db) return _db;

  const verified = resolveAndVerifyDbPath({ dbPath: DB_PATH, gzPath: GZ_PATH, tmpDbPath: TMP_DB_PATH, manifestPath: MANIFEST_PATH });
  if (verified.status === "missing") {
    console.warn("[knowledge-db] No SQLite DB found (checked .db, /tmp, .db.gz). Run: npm run build:knowledge-db");
    _db = "missing";
    return null;
  }
  if (verified.status === "mismatch") {
    // Already logged loudly inside resolveAndVerifyDbPath. Degrade to "missing" -- never crash.
    _db = "missing";
    return null;
  }

  const dbPath = verified.path;
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
  _warnedStaleTempOnce = false;
}
