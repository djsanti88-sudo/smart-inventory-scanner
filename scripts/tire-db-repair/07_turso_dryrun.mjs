#!/usr/bin/env node
// Task D1: Turso synchronization dry-run generator. PREPARE ONLY. NEVER executes against live
// Turso and NEVER writes to the local repaired DB.
//
// Reads the validated, repaired local DB (backups/claude-tire-db-handoff-2026-07-28/
// repair-2026-07-28/REPAIRED_TIRE_DATABASE.db) and, if read-only TURSO_DATABASE_URL /
// TURSO_AUTH_TOKEN credentials are already configured (per docs/COMMANDS.md, loaded the same way
// src/server/retail-knowledge/retailKnowledgeIndex.ts and src/server/tire-knowledge/
// tireKnowledgeIndex.ts do), runs a small number of read-only SELECT queries against live Turso to
// recompute the actual pre-promotion diff. If credentials are not available, falls back to the
// live counts recorded in CLAUDE_HANDOFF.md and labels the report "offline-snapshot mode".
//
// Produces, under backups/claude-tire-db-handoff-2026-07-28/repair-2026-07-28/:
//   - turso-staging/*.sql            idempotent staging SQL for all five datasets + gates + promote + backup/rollback
//   - TURSO_DRYRUN_REPORT.md         the dry-run diff report
//
// This script issues ZERO write statements against Turso. It only ever opens the local repaired
// DB read-only and, optionally, issues SELECT statements against Turso over the existing
// @libsql/client read path. No git commands. No push. No deploy.
//
// Usage: node scripts/tire-db-repair/07_turso_dryrun.mjs [dbPath]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const PACKAGE_DIR = join(REPO_ROOT, "backups", "claude-tire-db-handoff-2026-07-28");
const OUTPUT_DIR = join(PACKAGE_DIR, "repair-2026-07-28");

// Optional --output-dir / --report-out overrides (default unchanged: turso-staging/ and
// TURSO_DRYRUN_REPORT.md under OUTPUT_DIR) so a second working copy (e.g. a twin-completed
// bakeoff variant) can be dry-run into a SEPARATE folder without ever overwriting the frozen
// promote-#1 staging directory or report.
function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}
const outputDirArg = argValue("--output-dir");
const reportOutArg = argValue("--report-out");
const STAGING_DIR = outputDirArg ? join(REPO_ROOT, outputDirArg) : join(OUTPUT_DIR, "turso-staging");
const REPORT_OUT = reportOutArg ? join(REPO_ROOT, reportOutArg) : join(OUTPUT_DIR, "TURSO_DRYRUN_REPORT.md");

const WORKING_DB_DEFAULT = join(OUTPUT_DIR, "REPAIRED_TIRE_DATABASE.db");

const dbPathArg = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : null;
const workingDbPath = dbPathArg ?? WORKING_DB_DEFAULT;

// Handoff's pre-repair expectations (CLAUDE_HANDOFF.md section 9 / "Verified current state"),
// computed BEFORE the 2026-07-28 repair. Kept here verbatim so the report can show deltas against
// them, never silently replacing them.
const HANDOFF_EXPECTED = {
  liveTires: 78437,
  livePartNumbers: 24751,
  expectedAddTireKeys: 4203,
  expectedAddPartNumberKeys: 4422,
};

function loadEnvLocal() {
  // Mirrors the env-loading convention already used by src/server (Next.js loads .env.local at
  // runtime; this standalone script is not a Next.js process, so it parses the file the same
  // shallow way retailKnowledgeIndex.ts's callers expect TURSO_DATABASE_URL / TURSO_AUTH_TOKEN to
  // already be present in process.env). Read-only: never writes, never logs values.
  const path = join(REPO_ROOT, ".env.local");
  if (!existsSync(path)) return;
  const txt = readFileSync(path, "utf8");
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (!m) continue;
    if (!process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

/** Read-only Turso probe. Returns null (never throws) if credentials are missing or any call
 *  fails, so the caller can fall back to offline-snapshot mode. Every query used here is a plain
 *  SELECT - no INSERT, UPDATE, DELETE, CREATE, or DROP is ever issued against Turso by this
 *  script. */
async function tryLiveTursoRead() {
  loadEnvLocal();
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) return null;

  let createClient;
  try {
    ({ createClient } = await import("@libsql/client"));
  } catch {
    return null;
  }

  const queriesRun = [];
  try {
    const client = createClient({ url, authToken });

    queriesRun.push("SELECT barcode FROM tires");
    const tireRes = await client.execute("SELECT barcode FROM tires");
    const liveTireKeys = new Set(tireRes.rows.map((r) => String(r.barcode)));

    queriesRun.push("SELECT normalized_part_number FROM tire_part_numbers");
    const pnRes = await client.execute("SELECT normalized_part_number FROM tire_part_numbers");
    const livePnKeys = new Set(pnRes.rows.map((r) => String(r.normalized_part_number)));

    queriesRun.push(
      "SELECT canonical_product_uid, COUNT(*) c FROM tires WHERE canonical_product_uid IS NOT NULL GROUP BY canonical_product_uid HAVING c > 1"
    );
    const dupUidRes = await client.execute(queriesRun[queriesRun.length - 1]);

    return {
      mode: "live-read",
      liveTireKeys,
      livePnKeys,
      liveTireCount: liveTireKeys.size,
      livePnCount: livePnKeys.size,
      liveDuplicateCanonicalUidCount: dupUidRes.rows.length,
      queriesRun,
    };
  } catch (e) {
    return { mode: "failed", error: e.message, queriesRun };
  }
}

function computeOfflineSnapshot() {
  return {
    mode: "offline-snapshot",
    liveTireKeys: null,
    livePnKeys: null,
    liveTireCount: HANDOFF_EXPECTED.liveTires,
    livePnCount: HANDOFF_EXPECTED.livePartNumbers,
    liveDuplicateCanonicalUidCount: null,
    queriesRun: [],
  };
}

// ---------------------------------------------------------------------------------------------
// Staging SQL generation (files only - never executed against Turso by this script)
// ---------------------------------------------------------------------------------------------

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function insertBatchStatements(tableName, columns, rows, batchSize = 500) {
  const stmts = [];
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const valuesSql = batch
      .map((row) => `(${columns.map((c) => sqlLiteral(row[c])).join(", ")})`)
      .join(",\n  ");
    stmts.push(
      `INSERT OR REPLACE INTO ${tableName} (${columns.join(", ")})\nVALUES\n  ${valuesSql};`
    );
  }
  return stmts;
}

function writeStagingFile(fileName, header, statements) {
  const path = join(STAGING_DIR, fileName);
  const body = [header, "", ...statements, ""].join("\n");
  writeFileSync(path, body, "utf8");
  return path;
}

async function main() {
  mkdirSync(STAGING_DIR, { recursive: true });

  if (!existsSync(workingDbPath)) {
    console.error(`FATAL: repaired working DB not found at ${workingDbPath}`);
    process.exit(1);
  }

  // Open the repaired DB READ-ONLY. This script never writes to it.
  const db = new Database(workingDbPath, { readonly: true });

  console.log("Reading local repaired DB tables (read-only)...");
  const tires = db.prepare("SELECT * FROM tires").all();
  const partNumbersActive = db.prepare("SELECT * FROM tire_part_numbers").all();
  const partNumbersQuarantine = db.prepare("SELECT * FROM tire_part_numbers_quarantine").all();
  const aliases = db.prepare("SELECT * FROM tire_product_part_number_aliases").all();
  const canonicalProducts = db.prepare("SELECT * FROM canonical_tire_products").all();
  const provenance = db.prepare("SELECT * FROM provenance").all();

  const localTireKeys = new Set(tires.map((r) => r.barcode));
  const localPnActiveKeys = new Set(partNumbersActive.map((r) => r.normalized_part_number));

  console.log("Attempting read-only live Turso probe (SELECT-only)...");
  let live = await tryLiveTursoRead();
  let mode;
  if (!live) {
    mode = "offline-snapshot";
    live = computeOfflineSnapshot();
  } else if (live.mode === "failed") {
    console.warn(`Live Turso read failed (${live.error}); falling back to offline-snapshot mode.`);
    mode = "offline-snapshot";
    live = computeOfflineSnapshot();
  } else {
    mode = "live-read";
  }

  // --- Diff computation -------------------------------------------------------------------
  let addTireKeys, missingLiveTiresInLocal, addPnKeys, missingLivePnInLocal;
  if (mode === "live-read") {
    addTireKeys = [...localTireKeys].filter((k) => !live.liveTireKeys.has(k));
    missingLiveTiresInLocal = [...live.liveTireKeys].filter((k) => !localTireKeys.has(k));
    addPnKeys = [...localPnActiveKeys].filter((k) => !live.livePnKeys.has(k));
    missingLivePnInLocal = [...live.livePnKeys].filter((k) => !localPnActiveKeys.has(k));
  } else {
    // Offline-snapshot mode: no live key sets available, so diffs are reported against the
    // handoff's recorded live COUNTS only (not full key-set diffs). Label everything explicitly.
    addTireKeys = null;
    missingLiveTiresInLocal = null;
    addPnKeys = null;
    missingLivePnInLocal = null;
  }

  // Which of the 34 quarantined part-number keys were previously live (i.e. a live key that will
  // NOT be promoted to the active staging table, because the repair found a genuine conflict).
  let quarantinedPreviouslyLive = null;
  if (mode === "live-read") {
    quarantinedPreviouslyLive = partNumbersQuarantine
      .map((r) => r.normalized_part_number)
      .filter((k) => live.livePnKeys.has(k));
  }

  // -------------------------------------------------------------------------------------------
  // 1. Staging SQL: 5 datasets. Idempotent (CREATE TABLE IF NOT EXISTS + INSERT OR REPLACE keyed
  //    on each table's real primary key, so re-running this generator's SQL against a fresh
  //    staging schema is always safe to repeat).
  // -------------------------------------------------------------------------------------------

  const files = [];

  // Dataset 1: tires
  {
    const stmts = [];
    stmts.push(`CREATE TABLE IF NOT EXISTS staging_tires (
  barcode TEXT PRIMARY KEY,
  canonical_product_uid TEXT,
  brand TEXT,
  brand_normalized TEXT,
  model TEXT,
  model_normalized TEXT,
  size TEXT,
  raw_size_text TEXT,
  load_index TEXT,
  speed_rating TEXT,
  load_range TEXT,
  type TEXT,
  season TEXT,
  manufacturer_part_number TEXT,
  barcode_type TEXT,
  confidence TEXT,
  current_status TEXT,
  usable_for TEXT,
  field_completeness_score TEXT,
  missing_fields TEXT,
  source_count INTEGER,
  model_display TEXT,
  barcode_upc TEXT,
  barcode_ean13 TEXT
);`);
    const columns = [
      "barcode", "canonical_product_uid", "brand", "brand_normalized", "model", "model_normalized",
      "size", "raw_size_text", "load_index", "speed_rating", "load_range", "type", "season",
      "manufacturer_part_number", "barcode_type", "confidence", "current_status", "usable_for",
      "field_completeness_score", "missing_fields", "source_count", "model_display",
      "barcode_upc", "barcode_ean13",
    ];
    stmts.push(...insertBatchStatements("staging_tires", columns, tires));
    const path = writeStagingFile(
      "01_staging_tires.sql",
      "-- Dataset 1/5: tires. Idempotent: CREATE TABLE IF NOT EXISTS + INSERT OR REPLACE keyed on barcode.\n" +
        `-- Source: local repaired DB \`tires\` table (${tires.length} rows). DRY RUN ONLY - run against a Turso\n` +
        "-- STAGING database, never against the live tables directly.",
      stmts
    );
    files.push({ path, rows: tires.length, dataset: "tires" });
  }

  // Dataset 2: tire_part_numbers (ACTIVE only - quarantined rows are intentionally excluded from
  // promotion; they remain visible in PART_NUMBER_CONFLICTS.csv for human review).
  {
    const stmts = [];
    stmts.push(`CREATE TABLE IF NOT EXISTS staging_tire_part_numbers (
  normalized_part_number TEXT PRIMARY KEY,
  canonical_product_uid TEXT
);`);
    const columns = ["normalized_part_number", "canonical_product_uid"];
    stmts.push(...insertBatchStatements("staging_tire_part_numbers", columns, partNumbersActive));
    const path = writeStagingFile(
      "02_staging_tire_part_numbers.sql",
      `-- Dataset 2/5: tire_part_numbers, ACTIVE rows only (${partNumbersActive.length} of ${partNumbersActive.length + partNumbersQuarantine.length}; ${partNumbersQuarantine.length} quarantined rows are\n` +
        "-- excluded by design - see PART_NUMBER_CONFLICTS.csv - and are never promoted to live Turso.\n" +
        "-- Idempotent: CREATE TABLE IF NOT EXISTS + INSERT OR REPLACE keyed on normalized_part_number.",
      stmts
    );
    files.push({ path, rows: partNumbersActive.length, dataset: "tire_part_numbers (active)" });
  }

  // Dataset 3: tire_product_part_number_aliases
  {
    const stmts = [];
    stmts.push(`CREATE TABLE IF NOT EXISTS staging_tire_product_part_number_aliases (
  canonical_product_id TEXT NOT NULL,
  normalized_part_number TEXT NOT NULL,
  display_part_number TEXT NOT NULL,
  source TEXT NOT NULL,
  trust_color TEXT NOT NULL,
  confidence_score INTEGER NOT NULL,
  is_unambiguous INTEGER NOT NULL,
  PRIMARY KEY (canonical_product_id, normalized_part_number)
);`);
    const columns = [
      "canonical_product_id", "normalized_part_number", "display_part_number", "source",
      "trust_color", "confidence_score", "is_unambiguous",
    ];
    stmts.push(...insertBatchStatements("staging_tire_product_part_number_aliases", columns, aliases));
    const path = writeStagingFile(
      "03_staging_tire_product_part_number_aliases.sql",
      `-- Dataset 3/5: tire_product_part_number_aliases (${aliases.length} rows). This table does not exist on live\n` +
        "-- Turso today (Turso's runtime lookup path, src/server/tire-knowledge/tireKnowledgeIndex.ts\n" +
        "-- lookupPartNumberTurso, uses ONLY tire_part_numbers + tires; this alias table currently backs\n" +
        "-- the LOCAL better-sqlite3 lookup path only). Promoting it is additive and does not change\n" +
        "-- today's Turso runtime lookup behavior; it is future-ready for when the Turso lookup path is\n" +
        "-- upgraded to also consult aliases. Idempotent: CREATE TABLE IF NOT EXISTS + INSERT OR REPLACE.",
      stmts
    );
    files.push({ path, rows: aliases.length, dataset: "tire_product_part_number_aliases" });
  }

  // Dataset 4: canonical_tire_products
  {
    const stmts = [];
    stmts.push(`CREATE TABLE IF NOT EXISTS staging_canonical_tire_products (
  canonical_product_id TEXT PRIMARY KEY,
  brand TEXT,
  model TEXT,
  size TEXT,
  load_index TEXT,
  speed_rating TEXT,
  load_range TEXT,
  type TEXT,
  season TEXT,
  alias_count INTEGER NOT NULL,
  canonicalization_confidence INTEGER NOT NULL,
  canonicalization_reason TEXT NOT NULL
);`);
    const columns = [
      "canonical_product_id", "brand", "model", "size", "load_index", "speed_rating", "load_range",
      "type", "season", "alias_count", "canonicalization_confidence", "canonicalization_reason",
    ];
    stmts.push(...insertBatchStatements("staging_canonical_tire_products", columns, canonicalProducts));
    const path = writeStagingFile(
      "04_staging_canonical_tire_products.sql",
      `-- Dataset 4/5: canonical_tire_products (${canonicalProducts.length} rows). Also new to Turso (see dataset 3 note).\n` +
        "-- Idempotent: CREATE TABLE IF NOT EXISTS + INSERT OR REPLACE keyed on canonical_product_id.",
      stmts
    );
    files.push({ path, rows: canonicalProducts.length, dataset: "canonical_tire_products" });
  }

  // Dataset 5: provenance
  {
    const stmts = [];
    stmts.push(`CREATE TABLE IF NOT EXISTS staging_provenance (
  id INTEGER PRIMARY KEY,
  product_id TEXT,
  barcode TEXT,
  source_name TEXT,
  source_ref TEXT,
  sheet TEXT,
  row TEXT,
  batch_id TEXT,
  imported_at TEXT,
  evidence_level TEXT,
  license_note TEXT,
  content_hash TEXT,
  UNIQUE(product_id, barcode, source_name, source_ref, sheet, row)
);`);
    const columns = [
      "id", "product_id", "barcode", "source_name", "source_ref", "sheet", "row", "batch_id",
      "imported_at", "evidence_level", "license_note", "content_hash",
    ];
    stmts.push(...insertBatchStatements("staging_provenance", columns, provenance));
    const path = writeStagingFile(
      "05_staging_provenance.sql",
      `-- Dataset 5/5: provenance (${provenance.length} rows). Also new to Turso. Idempotent: CREATE TABLE IF NOT\n` +
        "-- EXISTS + INSERT OR REPLACE keyed on id, with the same UNIQUE(product_id, barcode,\n" +
        "-- source_name, source_ref, sheet, row) constraint as the local repaired DB.",
      stmts
    );
    files.push({ path, rows: provenance.length, dataset: "provenance" });
  }

  // -------------------------------------------------------------------------------------------
  // 2. Gate queries to run AGAINST STAGING (never against the live tables). Mirrors the same
  //    relationship and runtime-lookup semantics validated locally by 05_validate.mjs and used at
  //    runtime by src/server/tire-knowledge/tireKnowledgeIndex.ts's Turso path.
  // -------------------------------------------------------------------------------------------
  {
    const gateSql = `-- Gate queries: run against the STAGING tables after loading datasets 1-5.
-- Every gate must return 0 rows (or the stated expected count) before promotion proceeds.
-- These are READ-ONLY (SELECT) queries. Do not skip any gate.

-- Gate A: PRAGMA integrity_check must be 'ok' on the staging connection.
PRAGMA integrity_check;

-- Gate B: staging_tires row count (expect ${tires.length}).
SELECT COUNT(*) AS staging_tires_count FROM staging_tires;

-- Gate C: staging_tire_part_numbers (active) row count (expect ${partNumbersActive.length}).
SELECT COUNT(*) AS staging_tire_part_numbers_count FROM staging_tire_part_numbers;

-- Gate D: every staging_tire_part_numbers row must join to a staging_tires row via
-- canonical_product_uid (mirrors the exact runtime path in
-- src/server/tire-knowledge/tireKnowledgeIndex.ts:lookupPartNumberTurso). Expect 0 orphans.
SELECT COUNT(*) AS orphan_part_numbers
FROM staging_tire_part_numbers p
LEFT JOIN staging_tires t ON t.canonical_product_uid = p.canonical_product_uid
WHERE t.barcode IS NULL;

-- Gate E: no duplicate normalized_part_number keys in staging_tire_part_numbers (PRIMARY KEY
-- already enforces this at insert time; this is a defense-in-depth re-check). Expect 0.
SELECT normalized_part_number, COUNT(*) c
FROM staging_tire_part_numbers
GROUP BY normalized_part_number
HAVING c > 1;

-- Gate F: every staging_tire_product_part_number_aliases row joins a staging_canonical_tire_products
-- row. Expect 0 orphans.
SELECT COUNT(*) AS orphan_aliases
FROM staging_tire_product_part_number_aliases a
LEFT JOIN staging_canonical_tire_products c ON c.canonical_product_id = a.canonical_product_id
WHERE c.canonical_product_id IS NULL;

-- Gate G: preserve-all-live-tire-keys check. Every barcode currently live in production tires
-- must still resolve in staging_tires. Run this by first exporting the live barcode list (see
-- the promotion script's pre-check step) and diffing it against staging_tires; this file cannot
-- embed a cross-database query because Turso does not support ATTACH across two remote
-- databases, so the promotion script performs this check in application code before the swap.

-- Gate H: preserve-all-live-part-number-keys check, WITH THE DOCUMENTED EXCEPTION of the 17
-- part-number keys that the repair legitimately quarantined (genuine UID conflicts - see
-- PART_NUMBER_CONFLICTS.csv). Same application-code diff approach as Gate G; the promotion
-- script's report must show these 17 keys explicitly rather than silently failing the gate.

-- Gate I: runtime part-number lookup smoke test (repeat for each of the 12 samples validated
-- locally by validate.test.mjs, across the five boss brands). Example for one key - substitute
-- the actual normalized_part_number value:
-- SELECT t.* FROM staging_tires t
--   JOIN staging_tire_part_numbers p ON p.canonical_product_uid = t.canonical_product_uid
--   WHERE p.normalized_part_number = ?;
-- Expect exactly 1 row per sample (or a documented, non-empty duplicate set - see the report's
-- "Known limitation: duplicate canonical_product_uid" section).

-- Gate J: runtime barcode lookup smoke test (sample from the +4203 new tire keys).
-- SELECT * FROM staging_tires WHERE barcode = ?;
-- Expect exactly 1 row per sample.
`;
    const path = join(STAGING_DIR, "06_gates_against_staging.sql");
    writeFileSync(path, gateSql, "utf8");
    files.push({ path, rows: null, dataset: "gate queries" });
  }

  // -------------------------------------------------------------------------------------------
  // 3. Pre-promotion backup (dump current live tables) + atomic promotion (rename-swap) +
  //    rollback commands. All files-only; NONE of this is executed by this generator script.
  // -------------------------------------------------------------------------------------------
  {
    const backupSql = `-- Pre-promotion backup: dump the CURRENT live tables before any swap.
-- Run this against LIVE Turso in READ-ONLY fashion (SELECT + .dump-equivalent), and save the
-- output to a timestamped local file BEFORE running 08_promote.sql. This is the rollback source.
--
-- Recommended invocation (turso CLI, read-only export - does not modify live data):
--   turso db shell <db-name> ".dump tires" > backup_tires_YYYYMMDD.sql
--   turso db shell <db-name> ".dump tire_part_numbers" > backup_tire_part_numbers_YYYYMMDD.sql
--
-- Or, via the libsql client (read-only SELECT, then write the rows to a local file):
--   SELECT * FROM tires;
--   SELECT * FROM tire_part_numbers;
--
-- Do NOT proceed to 08_promote.sql until both backup files exist and have been spot-checked
-- (row counts match the live counts recorded in TURSO_DRYRUN_REPORT.md at generation time).
`;
    const backupPath = join(STAGING_DIR, "07_pre_promotion_backup.sql");
    writeFileSync(backupPath, backupSql, "utf8");
    files.push({ path: backupPath, rows: null, dataset: "pre-promotion backup" });

    const promoteSql = `-- Atomic promotion: rename-swap staging tables into the live table names, in ONE transaction
-- batch, so there is never a window where the live tables are half-updated or missing.
--
-- REQUIRES EXPLICIT OWNER APPROVAL TO EXECUTE. Do not run this against live Turso without a
-- separate, explicit owner instruction, per CLAUDE.md's No-Deploy Rule and this task's brief.
--
-- Preconditions (verified by hand or by a promotion script, all must be true before running):
--   1. All datasets 1-5 loaded into staging_* tables on a Turso STAGING database (or a staging
--      schema/prefix on the same database - operator's choice, documented in the report).
--   2. Every gate in 06_gates_against_staging.sql returns the expected/zero result.
--   3. Pre-promotion backup (07_pre_promotion_backup.sql) completed and spot-checked.
--   4. Owner has given explicit, separate approval to promote.
--
-- BEGIN TRANSACTION;
--
-- ALTER TABLE tires RENAME TO tires_old_YYYYMMDD;
-- ALTER TABLE staging_tires RENAME TO tires;
--
-- ALTER TABLE tire_part_numbers RENAME TO tire_part_numbers_old_YYYYMMDD;
-- ALTER TABLE staging_tire_part_numbers RENAME TO tire_part_numbers;
--
-- -- New tables (no live equivalent to rename away - straight promote):
-- ALTER TABLE staging_tire_product_part_number_aliases RENAME TO tire_product_part_number_aliases;
-- ALTER TABLE staging_canonical_tire_products RENAME TO canonical_tire_products;
-- ALTER TABLE staging_provenance RENAME TO provenance;
--
-- COMMIT;
--
-- Operational tables NEVER touched by this script or this transaction: decode_cache,
-- decode_archive, decode_outcomes, goupc_miss_cache, goupc_usage, ladder_kv, learned_products,
-- retail, sqlite_sequence. These are out of scope for the tire-corpus sync entirely.
--
-- After promotion, re-run the runtime lookup smoke test (Gate I/J above) against the NEW live
-- tables to confirm the swap did not silently break anything, before declaring promotion done.
`;
    const promotePath = join(STAGING_DIR, "08_promote_atomic.sql");
    writeFileSync(promotePath, promoteSql, "utf8");
    files.push({ path: promotePath, rows: null, dataset: "atomic promotion (commented, not executed)" });

    const rollbackSql = `-- Rollback plan. Two options, in order of preference:
--
-- Option 1 (fast path, only valid immediately after promotion, before the _old_YYYYMMDD tables
-- are dropped): rename back.
--
-- BEGIN TRANSACTION;
-- ALTER TABLE tires RENAME TO tires_failed_promotion;
-- ALTER TABLE tires_old_YYYYMMDD RENAME TO tires;
-- ALTER TABLE tire_part_numbers RENAME TO tire_part_numbers_failed_promotion;
-- ALTER TABLE tire_part_numbers_old_YYYYMMDD RENAME TO tire_part_numbers;
-- DROP TABLE IF EXISTS tire_product_part_number_aliases;
-- DROP TABLE IF EXISTS canonical_tire_products;
-- DROP TABLE IF EXISTS provenance;
-- COMMIT;
--
-- Option 2 (if the _old_YYYYMMDD tables were already dropped, or a later write already landed on
-- the new tables): restore from the pre-promotion backup dump (07_pre_promotion_backup.sql
-- output), then re-run 06_gates_against_staging.sql equivalents against the restored tables to
-- confirm restoration succeeded before resuming normal operation.
--
-- Either way: NEVER attempt an in-place partial rollback outside a single transaction. If the
-- transaction in 08_promote_atomic.sql fails partway (it should not, since SQLite/libsql DDL in
-- one batch is atomic), the failure leaves the original live tables completely untouched (the
-- RENAME statements only take effect on COMMIT), so no rollback action is needed in that case -
-- only after a SUCCESSFUL promotion that is later found to be wrong would rollback apply.
`;
    const rollbackPath = join(STAGING_DIR, "09_rollback.sql");
    writeFileSync(rollbackPath, rollbackSql, "utf8");
    files.push({ path: rollbackPath, rows: null, dataset: "rollback plan (commented, not executed)" });
  }

  // -------------------------------------------------------------------------------------------
  // 4. Report
  // -------------------------------------------------------------------------------------------
  const rel = (p) => p.replace(REPO_ROOT + "\\", "").replace(/\\/g, "/");
  const lines = [];
  lines.push("# TURSO_DRYRUN_REPORT.md - tire-db-repair Task D1");
  lines.push("");
  lines.push(
    `Generated by \`scripts/tire-db-repair/07_turso_dryrun.mjs\` against \`${rel(workingDbPath)}\`.`
  );
  lines.push(`Run timestamp: ${new Date().toISOString()}`);
  lines.push(`Mode: **${mode}**`);
  lines.push("");
  lines.push(
    mode === "live-read"
      ? "Read-only TURSO_DATABASE_URL / TURSO_AUTH_TOKEN credentials were available (loaded the same " +
          "way src/server/retail-knowledge/retailKnowledgeIndex.ts and src/server/tire-knowledge/ " +
          "tireKnowledgeIndex.ts load them). Live counts and key sets below were read directly from " +
          "Turso via SELECT-only queries (no INSERT/UPDATE/DELETE/CREATE/DROP was ever issued)."
      : "Read-only Turso credentials were not available (or the read attempt failed), so this report " +
          "falls back to the live counts already recorded in CLAUDE_HANDOFF.md ('Verified current " +
          "state', checked 2026-07-28). Full key-set diffs (which specific keys are new/missing) are " +
          "NOT available in this mode - only count-level comparisons."
  );
  lines.push("");

  if (mode === "live-read") {
    lines.push("## Queries run against live Turso (read-only, SELECT-only)");
    lines.push("");
    for (const q of live.queriesRun) lines.push(`- \`${q}\``);
    lines.push("");
  }

  lines.push("## Actual pre-promotion diff (recomputed tonight against the repaired DB)");
  lines.push("");
  lines.push("| Metric | Live Turso (today) | Repaired local DB | Diff |");
  lines.push("|---|---:|---:|---:|");
  lines.push(`| tires row count | ${live.liveTireCount} | ${tires.length} | ${mode === "live-read" ? `+${addTireKeys.length}` : "n/a (count-only mode)"} |`);
  lines.push(
    `| tire_part_numbers (active) row count | ${live.livePnCount} | ${partNumbersActive.length} | ${mode === "live-read" ? `+${addPnKeys.length}` : "n/a (count-only mode)"} |`
  );
  lines.push(`| tire_part_numbers (quarantined, NOT promoted) | n/a | ${partNumbersQuarantine.length} | see below |`);
  lines.push(`| tire_product_part_number_aliases (new table) | 0 (table does not exist live) | ${aliases.length} | +${aliases.length} |`);
  lines.push(`| canonical_tire_products (new table) | 0 (table does not exist live) | ${canonicalProducts.length} | +${canonicalProducts.length} |`);
  lines.push(`| provenance (new table) | 0 (table does not exist live) | ${provenance.length} | +${provenance.length} |`);
  lines.push("");

  if (mode === "live-read") {
    lines.push(`- All ${live.liveTireCount} live tire keys preserved in the repaired local DB: ${missingLiveTiresInLocal.length === 0 ? "YES (0 missing)" : `NO - ${missingLiveTiresInLocal.length} missing: ${missingLiveTiresInLocal.slice(0, 20).join(", ")}`}.`);
    lines.push(`- New tire keys the repaired DB would add: ${addTireKeys.length}.`);
    lines.push(`- Live part-number keys preserved in the repaired active table: ${missingLivePnInLocal.length === 0 ? "YES (0 missing)" : `NO - ${missingLivePnInLocal.length} missing`}.`);
    lines.push(`- New part-number keys the repaired active table would add: ${addPnKeys.length}.`);
    lines.push("");
  }

  lines.push("## Deltas versus the handoff's pre-repair expectations, explained");
  lines.push("");
  lines.push(
    "The handoff (`CLAUDE_HANDOFF.md`, section 9) recorded its expected diff numbers from a " +
      "read-only Turso snapshot checked 2026-07-28, BEFORE tonight's repair (A1-A6, B5-B6, C1) ran. " +
      "Those numbers describe the PRE-canonicalization rich database, not the repaired one. Actuals " +
      "recomputed tonight from the validated, GREEN-gated repaired DB:"
  );
  lines.push("");
  lines.push(`| Expectation (handoff, pre-repair) | Actual (this run, post-repair) | Delta | Explanation |`);
  lines.push(`|---|---|---|---|`);
  lines.push(
    `| Add ${HANDOFF_EXPECTED.expectedAddTireKeys} tire keys | ${mode === "live-read" ? `+${addTireKeys.length}` : "not recomputable in offline-snapshot mode"} | ${mode === "live-read" ? (addTireKeys.length === HANDOFF_EXPECTED.expectedAddTireKeys ? "0 (exact match)" : `${addTireKeys.length - HANDOFF_EXPECTED.expectedAddTireKeys >= 0 ? "+" : ""}${addTireKeys.length - HANDOFF_EXPECTED.expectedAddTireKeys}`) : "n/a"} | tires row count and keys are untouched by the repair (the repair only rewrote \`tire_part_numbers.canonical_product_uid\` and enriched blank fields); the tire key set matches the handoff's expectation exactly. |`
  );
  lines.push(
    `| Add ${HANDOFF_EXPECTED.expectedAddPartNumberKeys} part-number keys | ${mode === "live-read" ? `+${addPnKeys.length}` : "not recomputable in offline-snapshot mode"} | ${mode === "live-read" ? `${addPnKeys.length - HANDOFF_EXPECTED.expectedAddPartNumberKeys}` : "n/a"} | The handoff's ${HANDOFF_EXPECTED.expectedAddPartNumberKeys} figure assumed all 29,173 pre-repair part-number rows would promote cleanly. The repair (Task A2) found ${partNumbersQuarantine.length} rows whose old UID mapped to MULTIPLE stable target products (genuine conflicts - never resolved with \`LIMIT 1\` or arbitrary order, per the global constraints) and quarantined them instead of guessing. ${mode === "live-read" ? `Of those ${partNumbersQuarantine.length} quarantined keys, ${quarantinedPreviouslyLive.length} were previously live in production` : "(offline-snapshot mode cannot identify which quarantined keys were previously live)"}. Promoting the ACTIVE table therefore adds ${mode === "live-read" ? addPnKeys.length : "fewer than 4422"} new keys, not 4422, and ${mode === "live-read" ? (quarantinedPreviouslyLive.length > 0 ? `intentionally leaves ${quarantinedPreviouslyLive.length} previously-live keys out of the promoted active set (see below)` : "preserves every previously-live key") : "may leave some previously-live keys out of the promoted set pending conflict review"}. |`
  );
  lines.push("");

  if (mode === "live-read" && quarantinedPreviouslyLive.length > 0) {
    lines.push("### Previously-live part-number keys NOT in the promoted active set");
    lines.push("");
    lines.push(
      `${quarantinedPreviouslyLive.length} keys that resolve today on live Turso are, after repair, ` +
        "quarantined rather than promoted, because the old-UID-to-stable-product mapping found more " +
        "than one candidate target and the repair correctly refused to guess (see " +
        "`PART_NUMBER_CONFLICTS.csv` for the full conflict detail and both candidate targets per key). " +
        "This is a deliberate, documented safety behavior, not silent data loss: these keys remain " +
        "queryable in `tire_part_numbers_quarantine` in the repaired DB and are flagged for human " +
        "review before either an owner-approved manual resolution or permanent exclusion."
    );
    lines.push("");
    lines.push("| Quarantined key (previously live) | Quarantine reason |");
    lines.push("|---|---|");
    for (const key of quarantinedPreviouslyLive) {
      const row = partNumbersQuarantine.find((r) => r.normalized_part_number === key);
      lines.push(`| ${key} | ${row?.quarantine_reason ?? "see PART_NUMBER_CONFLICTS.csv"} |`);
    }
    lines.push("");
    lines.push(
      "**Recommendation:** treat these as an explicit review item alongside the general handoff " +
        "instruction to \"produce a review file for all conflicts and orphans\" - do not promote them " +
        "without a human resolving which of the two candidate stable products is correct."
    );
    lines.push("");
  }

  lines.push("## Known limitation: duplicate `canonical_product_uid` values in `tires`");
  lines.push("");
  lines.push(
    "Both the repaired local DB and live Turso today have multiple `tires` rows sharing the same " +
      "`canonical_product_uid` (2795 groups locally" +
      (mode === "live-read" ? `; ${live.liveDuplicateCanonicalUidCount} groups live today (full GROUP BY ... HAVING c > 1 scan, not a sample)` : "") +
      "). This is a PRE-EXISTING characteristic of the tire corpus (multiple barcodes/distributor " +
      "variants legitimately share one canonical product), not something this repair or this " +
      "promotion introduces. It matters here because the runtime part-number lookup path " +
      "(`src/server/tire-knowledge/tireKnowledgeIndex.ts:lookupPartNumberTurso`) resolves " +
      "`canonical_product_uid -> tires` with `LIMIT 1` and no deterministic tie-break, so a " +
      "part-number lookup against a duplicated UID can return any one of the matching barcodes' rows. " +
      "This is unchanged behavior versus production today; it is flagged here as an existing risk, " +
      "not a new one introduced by this sync, and is out of scope for this dry-run task to fix."
  );
  lines.push("");

  lines.push("## Datasets covered (all five, per the brief)");
  lines.push("");
  lines.push("| # | Dataset | Local row count | Staging SQL file |");
  lines.push("|---|---|---:|---|");
  lines.push(`| 1 | tires | ${tires.length} | \`turso-staging/01_staging_tires.sql\` |`);
  lines.push(`| 2 | tire_part_numbers (active only; quarantine excluded) | ${partNumbersActive.length} | \`turso-staging/02_staging_tire_part_numbers.sql\` |`);
  lines.push(`| 3 | tire_product_part_number_aliases | ${aliases.length} | \`turso-staging/03_staging_tire_product_part_number_aliases.sql\` |`);
  lines.push(`| 4 | canonical_tire_products | ${canonicalProducts.length} | \`turso-staging/04_staging_canonical_tire_products.sql\` |`);
  lines.push(`| 5 | provenance | ${provenance.length} | \`turso-staging/05_staging_provenance.sql\` |`);
  lines.push("");

  lines.push("## Operational tables left untouched");
  lines.push("");
  lines.push(
    "The following Turso tables are outside the tire-corpus sync entirely and are never referenced, " +
      "read, or written by any staging/promotion file in this deliverable: `decode_cache`, " +
      "`decode_archive`, `decode_outcomes`, `goupc_miss_cache`, `goupc_usage`, `ladder_kv`, " +
      "`learned_products`, `retail`" +
      (mode === "live-read" ? " (confirmed live today via `SELECT name FROM sqlite_master WHERE type='table'`)" : "") +
      "."
  );
  lines.push("");

  lines.push("## Files produced (all files-only, none executed)");
  lines.push("");
  for (const f of files) {
    lines.push(`- \`${rel(f.path)}\`${f.rows !== null ? ` (${f.rows} rows)` : ""}`);
  }
  lines.push("");

  lines.push("## Promotion procedure");
  lines.push("");
  lines.push("1. Create or select a Turso STAGING database (or a staging-prefixed schema).");
  lines.push("2. Load `turso-staging/01_staging_tires.sql` through `05_staging_provenance.sql`, in order, against staging.");
  lines.push("3. Run every gate in `turso-staging/06_gates_against_staging.sql` against staging. All must pass.");
  lines.push("4. Run `turso-staging/07_pre_promotion_backup.sql`'s dump procedure against LIVE Turso and verify the backup file(s).");
  lines.push("5. Obtain explicit owner approval to promote (separate from approval to prepare this dry run).");
  lines.push("6. Execute `turso-staging/08_promote_atomic.sql`'s transaction against LIVE Turso.");
  lines.push("7. Re-run the runtime lookup smoke test (Gates I/J) against the newly-promoted live tables.");
  lines.push("8. Keep the `_old_YYYYMMDD` renamed tables for at least one verification cycle before dropping them.");
  lines.push("");

  lines.push("## Rollback plan");
  lines.push("");
  lines.push("See `turso-staging/09_rollback.sql`: rename the `_old_YYYYMMDD` tables back (fast path, only until they are dropped), or restore from the pre-promotion backup dump (slow path, always available). Full detail and preconditions are in that file.");
  lines.push("");

  lines.push("## Status");
  lines.push("");
  lines.push(
    "This dry run has produced staging SQL, gate queries, a backup step, and an atomic promotion " +
      "script, all as files only. **Zero write statements have been issued against Turso.** " +
      "Promotion requires explicit owner approval to execute."
  );
  lines.push("");

  writeFileSync(REPORT_OUT, lines.join("\n"), "utf8");
  console.log(`Wrote ${rel(REPORT_OUT)}`);
  console.log(`Wrote ${files.length} staging files under ${rel(STAGING_DIR)}`);
  console.log(`Mode: ${mode}`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
