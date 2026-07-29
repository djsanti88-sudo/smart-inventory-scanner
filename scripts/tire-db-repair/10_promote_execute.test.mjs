#!/usr/bin/env node
// Task PROMOTE-BUILD: proof suite for 10_promote_execute.mjs.
//
// Runs the FULL backup -> stage -> verify -> promote -> rollback cycle against a synthesized
// fake-live libsql database (a local `file:` URL, not real Turso), using the real staging SQL
// files from turso-staging/ as the load source. Asserts:
//   1. backup produces a manifest + jsonl dump matching the fake-live row counts.
//   2. stage creates ONLY staging_* tables, loaded from the real staging SQL files.
//   3. verify's gates pass against the staged data and catch a deliberately-broken orphan case.
//   4. promote performs an atomic rename-swap; operational sentinel tables (retail, decode_cache)
//      are untouched; the new tire_product_part_number_aliases/canonical_tire_products/provenance
//      tables are created from staging.
//   5. rollback restores the exact original tables (byte-for-byte row content).
//   6. The refusal gate: any live subcommand without PROMOTE_CONFIRM=YES exits with code 3.
//   7. Atomic-swap correctness: after promote, tires/tire_part_numbers contain staging's rows
//      (not the old rows), and *_old_<ts> tables retain the pre-promotion rows.
//
// PROMOTE-FIX round (panel findings from panel-opus.md + panel-antigravity.md) additionally proves:
//   C1: post-promote secondary indexes exist (idx_tire_barcode/idx_tire_part_number/idx_tire_uid on
//       tires, idx_tire_part_numbers_uid on tire_part_numbers, idx_tire_pn_aliases_normalized on the
//       alias table) - queried directly from sqlite_master, not inferred.
//   I1: verify's exact-count gates catch a TRUNCATED staging load (count > 0 but short of the
//       manifest's expected count) and refuse to fall back to a weak check when the manifest itself
//       is missing.
//   I2: rollback resolves ts via --ts (wins) > PROMOTE_TS env > auto-discovery, and REFUSES to guess
//       when multiple _old_<ts> generations exist and neither is given.
//   I3: promote runs an automated post-swap smoke test (barcode/part-number/alias lookups + index
//       presence) and prints PASS/FAIL; a sabotaged swap FAILS loudly, exits nonzero, and retains
//       the _old_<ts> tables for rollback.
//   Antigravity #4: splitSqlStatements is fully quote-aware (comment-stripping happens in the SAME
//       scan as statement-splitting), so a value with '--' at the start of a line inside an open
//       string is never corrupted.
//   Antigravity #5/#6: backup dumps schema.sql (CREATE TABLE + CREATE INDEX DDL) alongside the JSONL
//       row dumps, and reports a pre/post-dump count consistency check per table.
//   Antigravity #7 (minor): re-promoting with a colliding PROMOTE_TS fails with a clear message
//       instead of a raw SQLite rename error.
//
// Codex panel additionally proves:
//   C3: backup writes a run-manifest (liveCounts + stagingContentHash); stage/verify/promote each
//       bind to it (--manifest or auto-discovered latest backup) and ABORT if live has moved or the
//       staging dataset has changed since backup, rather than silently losing a concurrent write.
//   I3: a hard table-name allowlist is enforced on every statement before execution; a sabotaged
//       staging file referencing an operational table (e.g. retail) is refused, not executed.
//   M1: verify --dry-run prints "DRY-RUN: not evaluated" and never PASS/FAIL wording, and returns
//       passed: null (not true) so no caller can mistake it for a real result.
//   (Codex C1 - the 17 dropped part-number keys - is an explicit owner-ordered decision already
//   recorded in PROMOTE_PREFLIGHT_REPORT.md / TURSO_DRYRUN_REPORT.md; no code change for it here.)
//
// This test NEVER touches real Turso. It points PROMOTE_TURSO_URL at a local libsql `file:` URL
// (proven to work identically to the remote client - same @libsql/client API) and
// PROMOTE_STAGING_DIR / PROMOTE_BACKUP_DIR at scratch directories under the OS temp dir (staging SQL
// files are COPIED from the real checked-in dataset into scratch, never read from in-place, so
// stage()'s expected-count manifest write never touches tracked repo files).
//
// Usage: node --test scripts/tire-db-repair/10_promote_execute.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createClient } from "@libsql/client";

// NOTE on why 10_promote_execute.mjs is loaded via a DYNAMIC import (not a static `import {...}`
// at the top of this file): a static ESM import is hoisted above all other module-level statements
// - including `process.env.PROMOTE_SKIP_MAIN = "1"` - so setting the env var textually "before" a
// static import does NOT actually run before that import's module evaluation. Without
// PROMOTE_SKIP_MAIN set first, importing the script in-process auto-invokes its main(), which then
// parses THIS TEST RUNNER's own process.argv and can exit(2), killing the entire test worker
// (observed exactly this: the whole file reported as one failing test, code ERR_TEST_FAILURE,
// exitCode 2). A dynamic `await import(...)` is NOT hoisted, so setting the env var first in
// normal statement order genuinely runs first.
process.env.PROMOTE_SKIP_MAIN = "1";
const {
  splitSqlStatements, countValueTuples, isAllowedTableName, assertAllowedTables, OPERATIONAL_TABLES,
  isAllowedNoTableStatement, runPostSwapSmokeTest,
} = await import("./10_promote_execute.mjs");

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const REAL_STAGING_DIR = join(
  REPO_ROOT, "backups", "claude-tire-db-handoff-2026-07-28", "repair-2026-07-28", "turso-staging"
);
const SCRIPT_PATH = join(__dirname, "10_promote_execute.mjs");

const STAGING_SQL_FILES = [
  "01_staging_tires.sql",
  "02_staging_tire_part_numbers.sql",
  "03_staging_tire_product_part_number_aliases.sql",
  "04_staging_canonical_tire_products.sql",
  "05_staging_provenance.sql",
];

let scratchRoot;
let dbPath;
let dbUrl;
let backupDir;
let stagingDir;
let approvedDropsPath;

/** Write the scratch approved-drops CSV (re-review OPEN-1). The fake-live fixture seeds one live
 *  part-number key (LIVEPN0001) that intentionally does NOT exist in the real staging dataset - it
 *  plays the role of the real promotion's 17 owner-approved dropped keys, so the PN-preservation
 *  gate exercises the "missing but approved" path on every full-cycle run. Tests that need an
 *  UNAPPROVED missing key add a second live key without touching this file. */
function writeApprovedDrops(keys = ["LIVEPN0001"]) {
  const lines = [
    "# scratch approved-drops fixture (mirrors repair-2026-07-28/APPROVED_PN_KEY_DROPS.csv format)",
    "normalized_part_number,owner_decision_reference,decision_date",
    ...keys.map((k) => `${k},test fixture (plays the role of the 17 owner-approved drops),2026-07-28`),
  ];
  writeFileSync(approvedDropsPath, lines.join("\n") + "\n", "utf8");
}

function freshScratch() {
  scratchRoot = mkdtempSync(join(tmpdir(), "promote-proof-"));
  dbPath = join(scratchRoot, "fake-live.db");
  dbUrl = `file:${dbPath.replace(/\\/g, "/")}`;
  backupDir = join(scratchRoot, "turso-backup");
  mkdirSync(backupDir, { recursive: true });
  // Copy (never point directly at) the real checked-in staging SQL files into a scratch dir.
  // cmdStage() now writes a stage_expected_counts.json manifest INTO its STAGING_DIR (panel finding
  // I1's exact-count verify needs this manifest) - if tests pointed PROMOTE_STAGING_DIR at the real
  // backups/.../turso-staging/ folder directly, every test run would leak that manifest file into
  // tracked repo content. Copying to a scratch dir keeps the real dataset directory read-only from
  // this test's perspective while still exercising the exact same real SQL content.
  stagingDir = join(scratchRoot, "turso-staging");
  mkdirSync(stagingDir, { recursive: true });
  for (const f of STAGING_SQL_FILES) {
    copyFileSync(join(REAL_STAGING_DIR, f), join(stagingDir, f));
  }
  // Scratch approved-drops file (OPEN-1 gate), pointed at via PROMOTE_APPROVED_DROPS in runCli so
  // tests never read or depend on the real checked-in APPROVED_PN_KEY_DROPS.csv.
  approvedDropsPath = join(scratchRoot, "APPROVED_PN_KEY_DROPS.csv");
  writeApprovedDrops();
}

/** Build the fake-live DB: same tables/columns as production, populated with a small but
 *  structurally faithful subset (a few hundred rows), PLUS operational sentinel tables
 *  (retail, decode_cache) that must remain untouched by every subcommand. */
async function seedFakeLiveDb() {
  const client = createClient({ url: dbUrl });

  await client.execute(`CREATE TABLE tires (
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
    model_display TEXT
  )`);
  await client.execute(`CREATE TABLE tire_part_numbers (
    normalized_part_number TEXT PRIMARY KEY,
    canonical_product_uid TEXT
  )`);

  // A handful of pre-existing "live" rows that ALSO exist in the real staging_tires dump (so Gate
  // G - preserve-all-live-keys - passes), by reusing a few real barcodes from
  // 01_staging_tires.sql. We parse the first few INSERT rows out of the real file directly so the
  // fixture stays honest to the real dataset shape rather than inventing fictitious keys.
  const realTiresSql = readFileSync(join(REAL_STAGING_DIR, "01_staging_tires.sql"), "utf8");
  const firstValuesLine = realTiresSql.match(/\(\s*'([0-9]+)'.*?\)/); // first VALUES tuple
  assert.ok(firstValuesLine, "expected to find at least one real tuple in 01_staging_tires.sql");
  const sampleBarcode = firstValuesLine[1];

  await client.execute({
    sql: `INSERT INTO tires (barcode, canonical_product_uid, brand, model, size) VALUES (?, 'OLD_UID_SAMPLE', 'oldbrand', 'oldmodel', '000/00R00')`,
    args: [sampleBarcode],
  });
  await client.execute({
    sql: `INSERT INTO tire_part_numbers (normalized_part_number, canonical_product_uid) VALUES (?, 'OLD_UID_SAMPLE')`,
    args: ["LIVEPN0001"],
  });

  // Operational sentinel tables that must NEVER be touched by any subcommand.
  await client.execute(`CREATE TABLE retail (barcode TEXT PRIMARY KEY, product_name TEXT, sentinel TEXT)`);
  await client.execute(`INSERT INTO retail (barcode, product_name, sentinel) VALUES ('999999999999', 'SENTINEL PRODUCT', 'DO_NOT_TOUCH')`);
  await client.execute(`CREATE TABLE decode_cache (barcode TEXT PRIMARY KEY, payload TEXT, sentinel TEXT)`);
  await client.execute(`INSERT INTO decode_cache (barcode, payload, sentinel) VALUES ('888888888888', '{}', 'DO_NOT_TOUCH')`);

  client.close();
  return { sampleBarcode };
}

function runCli(args, envOverrides = {}) {
  const env = {
    ...process.env,
    PROMOTE_TURSO_URL: dbUrl,
    PROMOTE_STAGING_DIR: stagingDir,
    PROMOTE_BACKUP_DIR: backupDir,
    PROMOTE_APPROVED_DROPS: approvedDropsPath,
    ...envOverrides,
  };
  // This test process sets PROMOTE_SKIP_MAIN=1 on itself (see the dynamic import above) so that
  // in-process importing 10_promote_execute.mjs for its pure helpers does not auto-invoke main().
  // That must NOT propagate to the actual CLI subprocess spawned here, which needs main() to run.
  delete env.PROMOTE_SKIP_MAIN;
  try {
    const out = execFileSync(process.execPath, [SCRIPT_PATH, ...args], { env, encoding: "utf8" });
    return { code: 0, stdout: out };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "" };
  }
}

/** Best-effort scratch cleanup. A lingering Windows file handle on the temp libsql DB (from the
 *  short-lived CLI subprocess or this process's own createClient() calls) can make rmSync throw
 *  EPERM even with maxRetries - that must never fail a test whose actual assertions already ran
 *  and passed; the OS temp dir is reclaimed eventually regardless. */
function cleanupScratch() {
  try {
    rmSync(scratchRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // best-effort only, see comment above
  }
}

async function tableExists(client, name) {
  const res = await client.execute({
    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
    args: [name],
  });
  return res.rows.length > 0;
}

async function rowCount(client, table) {
  const res = await client.execute(`SELECT COUNT(*) c FROM ${table}`);
  return Number(res.rows[0].c);
}

// ===============================================================================================
// Refusal gate tests (no DB seeding needed - these must refuse before ever touching a client)
// ===============================================================================================

test("refusal gate: stage without PROMOTE_CONFIRM exits 3", () => {
  freshScratch();
  const res = runCli(["stage"], { PROMOTE_CONFIRM: "" });
  assert.equal(res.code, 3);
  assert.match(res.stderr, /REFUSED/);
  cleanupScratch();
});

test("refusal gate: promote without PROMOTE_CONFIRM exits 3", () => {
  freshScratch();
  const res = runCli(["promote"], { PROMOTE_CONFIRM: "" });
  assert.equal(res.code, 3);
  assert.match(res.stderr, /REFUSED/);
  cleanupScratch();
});

test("refusal gate: rollback without PROMOTE_CONFIRM exits 3", () => {
  freshScratch();
  const res = runCli(["rollback"], { PROMOTE_CONFIRM: "" });
  assert.equal(res.code, 3);
  assert.match(res.stderr, /REFUSED/);
  cleanupScratch();
});

test("refusal gate: --dry-run NEVER requires PROMOTE_CONFIRM", () => {
  freshScratch();
  const res = runCli(["stage", "--dry-run"], { PROMOTE_CONFIRM: "" });
  assert.equal(res.code, 0);
  assert.doesNotMatch(res.stdout, /REFUSED/);
  cleanupScratch();
});

test("refusal gate: unknown subcommand exits 2 with usage", () => {
  freshScratch();
  const res = runCli(["bogus"]);
  assert.equal(res.code, 2);
  cleanupScratch();
});

// ===============================================================================================
// Full cycle proof: backup -> stage -> verify -> promote -> rollback against fake-live DB
// ===============================================================================================

let fixture;

test("full cycle: backup produces manifest + jsonl matching fake-live row counts", async () => {
  freshScratch();
  fixture = await seedFakeLiveDb();

  const res = runCli(["backup"], { PROMOTE_CONFIRM: "YES" });
  assert.equal(res.code, 0, res.stderr);

  // Find the timestamped dir the CLI created.
  const dirs = readdirSync(backupDir);
  assert.equal(dirs.length, 1, "expected exactly one timestamped backup dir");
  const outDir = join(backupDir, dirs[0]);
  const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"));

  assert.equal(manifest.tables.tires.rowCount, 1);
  assert.equal(manifest.tables.tire_part_numbers.rowCount, 1);
  assert.ok(existsSync(join(outDir, "tires.jsonl")));
  assert.ok(existsSync(join(outDir, "tire_part_numbers.jsonl")));

  const tiresLine = JSON.parse(readFileSync(join(outDir, "tires.jsonl"), "utf8").trim());
  assert.equal(tiresLine.barcode, fixture.sampleBarcode);
});

test("full cycle: stage creates ONLY staging_* tables and leaves operational tables untouched", async () => {
  const res = runCli(["stage"], { PROMOTE_CONFIRM: "YES" });
  assert.equal(res.code, 0, res.stderr);

  const client = createClient({ url: dbUrl });
  for (const t of ["staging_tires", "staging_tire_part_numbers", "staging_tire_product_part_number_aliases", "staging_canonical_tire_products", "staging_provenance"]) {
    assert.ok(await tableExists(client, t), `expected ${t} to exist after stage`);
  }
  // Real dataset row counts should have loaded (non-trivial size proves real files were used).
  const stagedTiresCount = await rowCount(client, "staging_tires");
  assert.ok(stagedTiresCount > 100, `expected staging_tires to have >100 rows from real dataset, got ${stagedTiresCount}`);

  // Operational sentinels untouched.
  assert.equal(await rowCount(client, "retail"), 1);
  const sentinelRes = await client.execute("SELECT sentinel FROM retail WHERE barcode = '999999999999'");
  assert.equal(sentinelRes.rows[0].sentinel, "DO_NOT_TOUCH");
  assert.equal(await rowCount(client, "decode_cache"), 1);

  // Live operational tables (non-staging_ prefixed) must not have been created/renamed.
  assert.ok(!(await tableExists(client, "staging_retail")));
  assert.ok(!(await tableExists(client, "staging_decode_cache")));

  client.close();
});

test("full cycle: stage is idempotent (re-running drops and reloads staging_* cleanly)", async () => {
  const res1 = runCli(["stage"], { PROMOTE_CONFIRM: "YES" });
  assert.equal(res1.code, 0, res1.stderr);
  const client = createClient({ url: dbUrl });
  const count1 = await rowCount(client, "staging_tires");

  const res2 = runCli(["stage"], { PROMOTE_CONFIRM: "YES" });
  assert.equal(res2.code, 0, res2.stderr);
  const count2 = await rowCount(client, "staging_tires");

  assert.equal(count1, count2, "re-staging should produce the same row count, not duplicates");
  client.close();
});

test("full cycle: verify passes all gates against correctly-staged data", async () => {
  const res = runCli(["verify"], { PROMOTE_CONFIRM: "YES" });
  assert.equal(res.code, 0, res.stderr + res.stdout);
  assert.match(res.stdout, /ALL GATES PASSED/);
});

test("full cycle: verify FAILS when an orphan part-number row is injected (gate D)", async () => {
  const client = createClient({ url: dbUrl });
  await client.execute(
    `INSERT INTO staging_tire_part_numbers (normalized_part_number, canonical_product_uid) VALUES ('ORPHAN_KEY_TEST', 'NO_SUCH_UID_ANYWHERE')`
  );
  client.close();

  const res = runCli(["verify"], { PROMOTE_CONFIRM: "YES" });
  assert.equal(res.code, 1, "verify must exit non-zero when a gate fails");
  assert.match(res.stdout, /GATE FAILURE/);
  assert.match(res.stdout, /FAIL D_orphan_part_numbers/);

  // Clean up the injected orphan so the promote test below is unaffected.
  const client2 = createClient({ url: dbUrl });
  await client2.execute(`DELETE FROM staging_tire_part_numbers WHERE normalized_part_number = 'ORPHAN_KEY_TEST'`);
  client2.close();
});

let promotedTs;

test("full cycle: promote performs an atomic rename-swap", async () => {
  const client = createClient({ url: dbUrl });
  const preOldTiresCount = await rowCount(client, "tires"); // the 1 pre-existing live row
  const preStagingTiresCount = await rowCount(client, "staging_tires");

  const res = runCli(["promote"], { PROMOTE_CONFIRM: "YES", PROMOTE_TS: "TESTTS1" });
  assert.equal(res.code, 0, res.stderr);
  promotedTs = "TESTTS1";

  // New `tires` table now has staging's row count, not the old 1-row count.
  const newTiresCount = await rowCount(client, "tires");
  assert.equal(newTiresCount, preStagingTiresCount);
  assert.notEqual(newTiresCount, preOldTiresCount);

  // Old table preserved under _old_TESTTS1.
  assert.ok(await tableExists(client, "tires_old_TESTTS1"));
  assert.equal(await rowCount(client, "tires_old_TESTTS1"), preOldTiresCount);
  assert.ok(await tableExists(client, "tire_part_numbers_old_TESTTS1"));

  // New tables created from staging.
  assert.ok(await tableExists(client, "tire_product_part_number_aliases"));
  assert.ok(await tableExists(client, "canonical_tire_products"));
  assert.ok(await tableExists(client, "provenance"));

  // staging_* names no longer exist (renamed away).
  assert.ok(!(await tableExists(client, "staging_tires")));
  assert.ok(!(await tableExists(client, "staging_tire_part_numbers")));

  // Operational sentinels STILL untouched after promote.
  assert.equal(await rowCount(client, "retail"), 1);
  const sentinelRes = await client.execute("SELECT sentinel FROM retail WHERE barcode = '999999999999'");
  assert.equal(sentinelRes.rows[0].sentinel, "DO_NOT_TOUCH");
  assert.equal(await rowCount(client, "decode_cache"), 1);
  const decodeSentinelRes = await client.execute("SELECT sentinel FROM decode_cache WHERE barcode = '888888888888'");
  assert.equal(decodeSentinelRes.rows[0].sentinel, "DO_NOT_TOUCH");

  // Panel finding C1: the promoted `tires` / `tire_part_numbers` / alias table must have their
  // secondary indexes, not just PKs, so runtime UID lookups (tireKnowledgeIndex.ts's Turso paths)
  // are not full-table scans. Query sqlite_master directly for the index names.
  const indexRes = await client.execute("SELECT name, tbl_name FROM sqlite_master WHERE type='index'");
  const indexByName = new Map(indexRes.rows.map((r) => [String(r.name), String(r.tbl_name)]));
  assert.equal(indexByName.get("idx_tire_barcode"), "tires");
  assert.equal(indexByName.get("idx_tire_part_number"), "tires");
  assert.equal(indexByName.get("idx_tire_uid"), "tires");
  assert.equal(indexByName.get("idx_tire_part_numbers_uid"), "tire_part_numbers");
  assert.equal(indexByName.get("idx_tire_pn_aliases_normalized"), "tire_product_part_number_aliases");

  // Post-swap smoke test output must report PASS for a good swap.
  assert.match(res.stdout, /post-swap smoke test results/);
  assert.match(res.stdout, /PASS smoke_barcode_lookup/);
  assert.match(res.stdout, /PASS smoke_part_number_two_step/);
  assert.match(res.stdout, /PASS smoke_index_presence/);
  // OPEN-1: the post-promote smoke summary includes the PN key-preservation diff. The fixture's
  // one pre-existing live key (LIVEPN0001) is approved-dropped, so: missing=1, approved=1, unapproved=0.
  assert.match(res.stdout, /PASS smoke_pn_key_preservation: missing=1, approved=1, unapproved=0/);
  assert.match(res.stdout, /SMOKE TEST PASSED/);

  client.close();
});

test("full cycle: rollback restores exactly the pre-promotion tables", async () => {
  const client = createClient({ url: dbUrl });
  const postPromoteTiresCount = await rowCount(client, "tires");

  const res = runCli(["rollback", "--ts", promotedTs], { PROMOTE_CONFIRM: "YES" });
  assert.equal(res.code, 0, res.stderr);

  const restoredTiresCount = await rowCount(client, "tires");
  assert.equal(restoredTiresCount, 1, "rollback should restore the original 1-row live tires table");
  assert.notEqual(restoredTiresCount, postPromoteTiresCount);

  const restoredRow = await client.execute(`SELECT * FROM tires WHERE barcode = ?`, [fixture.sampleBarcode]);
  assert.equal(restoredRow.rows.length, 1);
  assert.equal(restoredRow.rows[0].canonical_product_uid, "OLD_UID_SAMPLE");

  const restoredPn = await client.execute(`SELECT * FROM tire_part_numbers WHERE normalized_part_number = 'LIVEPN0001'`);
  assert.equal(restoredPn.rows.length, 1);

  // The failed-promotion tables (renamed-away "new" tables) exist but new tables were dropped.
  assert.ok(await tableExists(client, `tires_failed_promotion_${promotedTs}`));
  assert.ok(!(await tableExists(client, "tire_product_part_number_aliases")));
  assert.ok(!(await tableExists(client, "canonical_tire_products")));
  assert.ok(!(await tableExists(client, "provenance")));

  // Operational sentinels untouched through rollback too.
  assert.equal(await rowCount(client, "retail"), 1);
  assert.equal(await rowCount(client, "decode_cache"), 1);

  client.close();
  try {
    cleanupScratch();
  } catch {
    // Best-effort cleanup only; a lingering Windows file handle on the temp DB must never fail
    // the proof run (the OS temp dir is reclaimed eventually regardless).
  }
});

// ===============================================================================================
// Panel finding I1: verify must catch a PARTIAL/TRUNCATED staging load via EXACT counts, not the
// old count > 0 check. Simulate a crash mid-stage by truncating the live staging_tires table
// AFTER a normal stage() run, then confirm verify fails specifically on the exact-count gate.
// ===============================================================================================

test("I1: verify FAILS on a truncated staging_tires load (exact-count gate, not count>0)", async () => {
  freshScratch();
  fixture = await seedFakeLiveDb();
  runCli(["backup"], { PROMOTE_CONFIRM: "YES" });

  const stageRes = runCli(["stage"], { PROMOTE_CONFIRM: "YES" });
  assert.equal(stageRes.code, 0, stageRes.stderr);

  // Confirm the manifest itself was written with the real dataset's full expected count.
  const manifestPath = join(stagingDir, "stage_expected_counts.json");
  assert.ok(existsSync(manifestPath), "expected stage() to write stage_expected_counts.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const fullCount = manifest.expectedCounts.staging_tires;
  assert.ok(fullCount > 100, `expected a large real dataset count, got ${fullCount}`);

  // Simulate a crash mid-stage: delete a chunk's worth of rows from the ALREADY-STAGED table so its
  // live row count (still > 0) no longer matches the manifest's exact expected count. This is
  // exactly the shape of damage a CHUNK-batched stage() crash would leave behind - a truncated
  // table that is nonetheless non-empty.
  const client = createClient({ url: dbUrl });
  await client.execute(`DELETE FROM staging_tires WHERE rowid IN (SELECT rowid FROM staging_tires LIMIT 200)`);
  const truncatedCount = await rowCount(client, "staging_tires");
  assert.ok(truncatedCount > 0, "truncated table must still be non-empty (this is the count>0 blind spot)");
  assert.notEqual(truncatedCount, fullCount);
  client.close();

  const verifyRes = runCli(["verify"], { PROMOTE_CONFIRM: "YES" });
  assert.equal(verifyRes.code, 1, "verify must exit non-zero on a truncated load");
  assert.match(verifyRes.stdout, /GATE FAILURE/);
  assert.match(verifyRes.stdout, /FAIL B_staging_tires_count/);
  assert.match(verifyRes.stdout, /MISMATCH/);

  cleanupScratch();
});

test("I1: verify FAILS with a clear error when the expected-count manifest is missing", async () => {
  freshScratch();
  fixture = await seedFakeLiveDb();
  runCli(["backup"], { PROMOTE_CONFIRM: "YES" });
  // Load staging tables directly via the SQL files WITHOUT going through cmdStage's manifest write,
  // by running stage() then deleting the manifest - simulating a staging_dir that was populated by
  // some other means (e.g. an operator running raw SQL) without ever writing the manifest.
  runCli(["stage"], { PROMOTE_CONFIRM: "YES" });
  rmSync(join(stagingDir, "stage_expected_counts.json"), { force: true });

  const verifyRes = runCli(["verify"], { PROMOTE_CONFIRM: "YES" });
  assert.equal(verifyRes.code, 1, "verify must refuse to fall back to a weak count>0 check");
  assert.match(verifyRes.stdout, /FAIL Z_expected_counts_manifest_present/);
  assert.match(verifyRes.stdout, /MISSING/);

  cleanupScratch();
});

// ===============================================================================================
// Panel finding I2: rollback must accept PROMOTE_TS env as well as --ts, with --ts taking
// precedence, and must error (not silently guess) when neither is given and multiple _old_
// generations exist.
// ===============================================================================================

test("I2: rollback resolves ts from PROMOTE_TS env when --ts is not passed", async () => {
  freshScratch();
  fixture = await seedFakeLiveDb();
  runCli(["backup"], { PROMOTE_CONFIRM: "YES" });
  runCli(["stage"], { PROMOTE_CONFIRM: "YES" });
  const promoteRes = runCli(["promote"], { PROMOTE_CONFIRM: "YES", PROMOTE_TS: "ENVTS1" });
  assert.equal(promoteRes.code, 0, promoteRes.stderr);

  // No --ts flag passed to rollback; only PROMOTE_TS env is set.
  const rollbackRes = runCli(["rollback"], { PROMOTE_CONFIRM: "YES", PROMOTE_TS: "ENVTS1" });
  assert.equal(rollbackRes.code, 0, rollbackRes.stderr);
  assert.match(rollbackRes.stdout, /ts=ENVTS1/);

  const client = createClient({ url: dbUrl });
  assert.equal(await rowCount(client, "tires"), 1, "rollback via PROMOTE_TS should restore the original 1-row live table");
  assert.ok(await tableExists(client, "tires_failed_promotion_ENVTS1"));
  client.close();

  cleanupScratch();
});

test("I2: rollback prefers explicit --ts over PROMOTE_TS when both are set", async () => {
  freshScratch();
  fixture = await seedFakeLiveDb();
  runCli(["backup"], { PROMOTE_CONFIRM: "YES" });
  runCli(["stage"], { PROMOTE_CONFIRM: "YES" });
  const promoteRes = runCli(["promote"], { PROMOTE_CONFIRM: "YES", PROMOTE_TS: "EXPLICITTS" });
  assert.equal(promoteRes.code, 0, promoteRes.stderr);

  // PROMOTE_TS is set to a DIFFERENT (bogus) value; --ts must win.
  const rollbackRes = runCli(["rollback", "--ts", "EXPLICITTS"], { PROMOTE_CONFIRM: "YES", PROMOTE_TS: "SOME_OTHER_BOGUS_TS" });
  assert.equal(rollbackRes.code, 0, rollbackRes.stderr);
  assert.match(rollbackRes.stdout, /ts=EXPLICITTS/);

  const client = createClient({ url: dbUrl });
  assert.equal(await rowCount(client, "tires"), 1);
  client.close();

  cleanupScratch();
});

test("I2: rollback errors (does not silently guess) when neither --ts nor PROMOTE_TS is given and multiple _old_ generations exist", async () => {
  freshScratch();
  fixture = await seedFakeLiveDb();

  // Create two separate _old_<ts> generations WITHOUT ever cleaning either one up, by manually
  // renaming a copy of tires aside under a second _old_ name after a normal promote. This simulates
  // an operator (or a broken script) leaving two stale _old_ generations around - the real hazard
  // I2 targets - without relying on a second full promote cycle (which the re-promotion collision
  // guard, Antigravity Minor #7, now correctly refuses since NEW_TABLES' live names would already
  // exist from the first promote).
  runCli(["backup"], { PROMOTE_CONFIRM: "YES" });
  runCli(["stage"], { PROMOTE_CONFIRM: "YES" });
  const promote1 = runCli(["promote"], { PROMOTE_CONFIRM: "YES", PROMOTE_TS: "GEN1" });
  assert.equal(promote1.code, 0, promote1.stderr);

  const client = createClient({ url: dbUrl });
  await client.execute("CREATE TABLE tires_old_GEN2 (barcode TEXT PRIMARY KEY, canonical_product_uid TEXT)");
  assert.ok(await tableExists(client, "tires_old_GEN1"));
  assert.ok(await tableExists(client, "tires_old_GEN2"));
  client.close();

  const rollbackRes = runCli(["rollback"], { PROMOTE_CONFIRM: "YES", PROMOTE_TS: "" });
  assert.notEqual(rollbackRes.code, 0, "rollback must refuse to guess among multiple _old_ generations");
  assert.match(rollbackRes.stderr + rollbackRes.stdout, /generations found|Refusing to guess/);

  cleanupScratch();
});

// ===============================================================================================
// Panel finding I3: promote runs an automated post-swap smoke test and prints PASS/FAIL; a FAIL
// must leave the *_old_ tables in place and exit nonzero.
// ===============================================================================================

test("I3/Critical#1: promote's PRE-SWAP verify gate catches a broken alias fallback and refuses BEFORE the swap runs", async () => {
  freshScratch();
  fixture = await seedFakeLiveDb();
  runCli(["backup"], { PROMOTE_CONFIRM: "YES" });
  runCli(["stage"], { PROMOTE_CONFIRM: "YES" });

  // Sabotage staging BEFORE promote: make the alias table's normalized_part_number point at a
  // canonical_product_id that does NOT exist in staging_canonical_tire_products / will not exist in
  // staging_tires either - an orphaned alias row.
  const client = createClient({ url: dbUrl });
  await client.execute(`DELETE FROM staging_tire_product_part_number_aliases`);
  await client.execute(
    `INSERT INTO staging_tire_product_part_number_aliases (canonical_product_id, normalized_part_number, display_part_number, source, trust_color, confidence_score, is_unambiguous)
     VALUES ('NO_SUCH_UID_ANYWHERE', 'SABOTAGE_PN', 'SABOTAGE_PN', 'test', 'green', 100, 1)`
  );
  client.close();

  // Critical finding #1: promote now re-runs the FULL verify gate battery against live staging_*
  // tables in this SAME invocation, immediately before the atomic swap - so this orphaned-alias
  // sabotage is caught by gate F_orphan_aliases BEFORE any rename ever executes, not discovered only
  // after the swap via the post-swap smoke test. This is strictly safer than the old behavior (which
  // let the swap happen and only complained afterward).
  const promoteRes = runCli(["promote"], { PROMOTE_CONFIRM: "YES", PROMOTE_TS: "SABOTAGETS" });
  assert.notEqual(promoteRes.code, 0, "promote must exit nonzero when the pre-swap verify gate battery fails");
  assert.match(promoteRes.stdout, /pre-swap verify gate results/);
  assert.match(promoteRes.stdout, /FAIL F_orphan_aliases/);
  assert.match(promoteRes.stderr, /REFUSING to swap/);
  assert.match(promoteRes.stderr, /pre-swap verify gate battery FAILED/);

  // The swap must NOT have happened at all: no _old_ tables were created, and live tires/tire_part_numbers
  // still hold their ORIGINAL (pre-promote) content, not the staged data.
  const client2 = createClient({ url: dbUrl });
  assert.ok(!(await tableExists(client2, "tires_old_SABOTAGETS")), "the swap must not have run - no _old_ table should exist");
  assert.equal(await rowCount(client2, "tires"), 1, "live tires must still hold only the original pre-promote row");
  client2.close();

  cleanupScratch();
});

test("I3: promote's automated smoke test PASSES on a correctly-staged swap (already proven by the full-cycle test above; explicit standalone check)", async () => {
  freshScratch();
  fixture = await seedFakeLiveDb();
  runCli(["backup"], { PROMOTE_CONFIRM: "YES" });
  runCli(["stage"], { PROMOTE_CONFIRM: "YES" });

  const promoteRes = runCli(["promote"], { PROMOTE_CONFIRM: "YES", PROMOTE_TS: "GOODTS" });
  assert.equal(promoteRes.code, 0, promoteRes.stderr);
  assert.match(promoteRes.stdout, /SMOKE TEST PASSED/);

  cleanupScratch();
});

// ===============================================================================================
// Minor (Antigravity panel #7): re-promotion collision must fail cleanly, not with a raw SQLite
// rename error.
// ===============================================================================================

test("re-promotion collision: promoting twice with the SAME PROMOTE_TS fails with a clear message", async () => {
  freshScratch();
  fixture = await seedFakeLiveDb();
  runCli(["backup"], { PROMOTE_CONFIRM: "YES" });
  runCli(["stage"], { PROMOTE_CONFIRM: "YES" });
  const promote1 = runCli(["promote"], { PROMOTE_CONFIRM: "YES", PROMOTE_TS: "DUPTS" });
  assert.equal(promote1.code, 0, promote1.stderr);

  // Take a FRESH backup first: the first promote changed live tires/tire_part_numbers (they now
  // hold the staged data), so the ORIGINAL backup's manifest is correctly stale per panel finding
  // C3's live-drift check - a real operator would always re-run backup before a second promote
  // attempt. This isolates the test to the re-promotion COLLISION guard specifically, rather than
  // incidentally tripping the (also-correct) C3 live-drift guard first.
  runCli(["backup"], { PROMOTE_CONFIRM: "YES" });
  // Re-stage (promote consumed the staging_* tables) and attempt to promote AGAIN with the same ts.
  runCli(["stage"], { PROMOTE_CONFIRM: "YES" });
  const promote2 = runCli(["promote"], { PROMOTE_CONFIRM: "YES", PROMOTE_TS: "DUPTS" });
  assert.notEqual(promote2.code, 0, "re-promoting with a colliding ts must fail, not silently corrupt");
  assert.match(promote2.stderr, /REFUSING|already exist/);
  assert.doesNotMatch(promote2.stderr, /SQLITE_ERROR|no such table/i);

  cleanupScratch();
});

// ===============================================================================================
// Antigravity panel Important #4: comment stripper must be quote-aware, not a naive line-prefix
// filter, so a literal '--' at the START of a line INSIDE a multi-line string is never mistaken
// for a comment.
// ===============================================================================================

test("splitSqlStatements: a value containing '--' does not get corrupted, including at line start inside a string", async () => {
  // Case 1: '--' mid-string (the real-world case already present in provenance URLs).
  const midString = `INSERT INTO t (a) VALUES ('https://example.com/11.00--r20-foo');`;
  const stmts1 = splitSqlStatements(midString);
  assert.equal(stmts1.length, 1);
  assert.match(stmts1[0], /11\.00--r20-foo/);

  // Case 2: a genuine full-line comment must still be stripped.
  const withComment = `-- this is a comment\nINSERT INTO t (a) VALUES ('x');`;
  const stmts2 = splitSqlStatements(withComment);
  assert.equal(stmts2.length, 1);
  assert.doesNotMatch(stmts2.join(""), /this is a comment/);

  // Case 3: a value that legitimately STARTS a (wrapped) line with '--' while still inside an
  // open single-quoted string must be preserved, not stripped as if it were a line comment. This
  // is the exact gap the old two-pass (strip-comments-then-split) implementation had: it checked
  // `line.trim().startsWith("--")` BEFORE the quote-aware scan ever ran, so a multi-line string
  // value could be truncated.
  const multilineValueStartingWithDashes =
    "INSERT INTO t (a) VALUES ('first line\n--second line still inside the string');";
  const stmts3 = splitSqlStatements(multilineValueStartingWithDashes);
  assert.equal(stmts3.length, 1, "expected exactly one statement, not a truncated/corrupted split");
  assert.match(stmts3[0], /--second line still inside the string/);

  // Case 4: a semicolon inside a string must still not split the statement (regression check for
  // the existing provenance-lineage-text behavior).
  const semicolonInString = `INSERT INTO t (a) VALUES ('lineage; internal, no external license');`;
  const stmts4 = splitSqlStatements(semicolonInString);
  assert.equal(stmts4.length, 1);
  assert.match(stmts4[0], /lineage; internal, no external license/);
});

// ===============================================================================================
// Antigravity panel Important #5 + #6: backup must dump schema DDL (not just row data) and must
// use keyset pagination with a before/after count consistency check (not naive OFFSET pagination).
// ===============================================================================================

test("backup: writes schema.sql with CREATE TABLE + CREATE INDEX DDL, and a consistent manifest", async () => {
  freshScratch();
  fixture = await seedFakeLiveDb();

  const res = runCli(["backup"], { PROMOTE_CONFIRM: "YES" });
  assert.equal(res.code, 0, res.stderr);

  const dirs = readdirSync(backupDir);
  assert.equal(dirs.length, 1);
  const outDir = join(backupDir, dirs[0]);

  const schemaPath = join(outDir, "schema.sql");
  assert.ok(existsSync(schemaPath), "expected backup to write schema.sql");
  const schemaSql = readFileSync(schemaPath, "utf8");
  assert.match(schemaSql, /CREATE TABLE tires/);
  assert.match(schemaSql, /CREATE TABLE tire_part_numbers/);
  // Operational sentinel tables' schema must NOT leak into the tire-corpus backup (only
  // LIVE_TABLES = tires/tire_part_numbers are backed up by cmdBackup; this backup only covers
  // those two, not the full live schema).
  assert.doesNotMatch(schemaSql, /CREATE TABLE retail/);
  assert.doesNotMatch(schemaSql, /CREATE TABLE decode_cache/);

  const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"));
  assert.equal(manifest.schemaFile, "schema.sql");
  assert.equal(manifest.tables.tires.consistent, true);
  assert.equal(manifest.tables.tires.preDumpCount, manifest.tables.tires.postDumpCount);
  assert.equal(manifest.tables.tires.rowCount, manifest.tables.tires.preDumpCount);

  cleanupScratch();
});

test("countValueTuples: counts INSERT value-tuples matching the real staging file's own generator format", async () => {
  const sample = `CREATE TABLE t (a TEXT);\nINSERT INTO t (a) VALUES\n  ('one'),\n  ('two'),\n  ('three');\n`;
  assert.equal(countValueTuples(sample), 3);
});

// ===============================================================================================
// Codex panel finding C3: no state previously bound backup -> stage -> verify -> promote across
// separate command invocations; a live write landing between steps could be silently lost.
// backup now writes a run-manifest (liveCounts + stagingContentHash); stage/verify/promote each
// bind to it and REFUSE if live has moved or the staging dataset changed since backup.
// ===============================================================================================

test("C3: stage REFUSES to run without a prior backup (no run-manifest found)", async () => {
  freshScratch();
  fixture = await seedFakeLiveDb();
  // Deliberately skip backup.
  const stageRes = runCli(["stage"], { PROMOTE_CONFIRM: "YES" });
  assert.notEqual(stageRes.code, 0, "stage must refuse without a bound run-manifest");
  assert.match(stageRes.stderr, /no run-manifest found/);
  cleanupScratch();
});

test("C3: stage REFUSES when a live write lands after backup but before stage (live-drift detection)", async () => {
  freshScratch();
  fixture = await seedFakeLiveDb();
  runCli(["backup"], { PROMOTE_CONFIRM: "YES" });

  // Simulate a concurrent live write landing AFTER backup's snapshot: insert a new live tires row.
  const client = createClient({ url: dbUrl });
  await client.execute({
    sql: `INSERT INTO tires (barcode, canonical_product_uid, brand, model, size) VALUES (?, 'DRIFT_UID', 'driftbrand', 'driftmodel', '111/11R11')`,
    args: ["999000111222"],
  });
  client.close();

  const stageRes = runCli(["stage"], { PROMOTE_CONFIRM: "YES" });
  assert.notEqual(stageRes.code, 0, "stage must refuse when live has drifted since the bound backup");
  assert.match(stageRes.stderr, /live has changed since the bound backup/);
  assert.match(stageRes.stderr, /tires: backup saw 1, now 2/);

  cleanupScratch();
});

test("C3: verify REFUSES when live drifts after stage (between stage and verify)", async () => {
  freshScratch();
  fixture = await seedFakeLiveDb();
  runCli(["backup"], { PROMOTE_CONFIRM: "YES" });
  const stageRes = runCli(["stage"], { PROMOTE_CONFIRM: "YES" });
  assert.equal(stageRes.code, 0, stageRes.stderr);

  // Live write lands AFTER stage completed, BEFORE verify runs.
  const client = createClient({ url: dbUrl });
  await client.execute({
    sql: `INSERT INTO tire_part_numbers (normalized_part_number, canonical_product_uid) VALUES (?, 'DRIFT_UID_2')`,
    args: ["DRIFTPN0002"],
  });
  client.close();

  const verifyRes = runCli(["verify"], { PROMOTE_CONFIRM: "YES" });
  assert.notEqual(verifyRes.code, 0, "verify must refuse when live has drifted since the bound backup");
  assert.match(verifyRes.stderr, /live has changed since the bound backup/);
  assert.match(verifyRes.stderr, /tire_part_numbers: backup saw 1, now 2/);

  cleanupScratch();
});

test("C3: promote REFUSES when live drifts after verify (last-gate re-check before the swap)", async () => {
  freshScratch();
  fixture = await seedFakeLiveDb();
  runCli(["backup"], { PROMOTE_CONFIRM: "YES" });
  runCli(["stage"], { PROMOTE_CONFIRM: "YES" });
  const verifyRes = runCli(["verify"], { PROMOTE_CONFIRM: "YES" });
  assert.equal(verifyRes.code, 0, verifyRes.stderr + verifyRes.stdout);

  // Live write lands AFTER verify PASSED, BEFORE promote runs - the exact race C3 targets.
  const client = createClient({ url: dbUrl });
  await client.execute({
    sql: `INSERT INTO tires (barcode, canonical_product_uid, brand, model, size) VALUES (?, 'DRIFT_UID_3', 'b', 'm', '1/1R1')`,
    args: ["999000333444"],
  });
  client.close();

  const promoteRes = runCli(["promote"], { PROMOTE_CONFIRM: "YES", PROMOTE_TS: "DRIFTTS" });
  assert.notEqual(promoteRes.code, 0, "promote must refuse when live has drifted since the bound backup, even after verify passed");
  assert.match(promoteRes.stderr, /live has changed since the bound backup/);

  // Critically: the swap must NOT have happened - live tires must still be the ORIGINAL + drift
  // row, not the staged data, and no _old_ table should exist for this ts.
  const client2 = createClient({ url: dbUrl });
  assert.equal(await rowCount(client2, "tires"), 2, "the aborted promote must not have executed the swap");
  assert.ok(!(await tableExists(client2, "tires_old_DRIFTTS")));
  client2.close();

  cleanupScratch();
});

test("C3: stage REFUSES when the staging SQL content changes after backup (staging-content-hash drift)", async () => {
  freshScratch();
  fixture = await seedFakeLiveDb();
  runCli(["backup"], { PROMOTE_CONFIRM: "YES" });

  // Mutate a staging SQL file's content AFTER backup hashed it.
  const targetFile = join(stagingDir, "01_staging_tires.sql");
  const original = readFileSync(targetFile, "utf8");
  writeFileSync(targetFile, original + "\n-- tampered after backup\n", "utf8");

  const stageRes = runCli(["stage"], { PROMOTE_CONFIRM: "YES" });
  assert.notEqual(stageRes.code, 0, "stage must refuse when the staging dataset changed since backup");
  assert.match(stageRes.stderr, /staging SQL files' content hash/);

  cleanupScratch();
});

test("C3: an explicit --manifest path can bind to a specific (non-latest) backup", async () => {
  freshScratch();
  fixture = await seedFakeLiveDb();
  const firstBackup = runCli(["backup"], { PROMOTE_CONFIRM: "YES" });
  assert.equal(firstBackup.code, 0, firstBackup.stderr);
  const firstBackupDirName = readdirSync(backupDir)[0];
  const firstManifestPath = join(backupDir, firstBackupDirName, "manifest.json");

  // A second backup captures a NEWER snapshot (still consistent, just a later timestamp dir).
  const secondBackup = runCli(["backup"], { PROMOTE_CONFIRM: "YES", PROMOTE_TS: "SECONDBACKUPTS" });
  assert.equal(secondBackup.code, 0, secondBackup.stderr);

  // Explicitly bind stage to the FIRST manifest (not auto-discovered latest) - must still succeed,
  // proving --manifest is honored rather than always resolving to "latest".
  const stageRes = runCli(["stage", "--manifest", firstManifestPath], { PROMOTE_CONFIRM: "YES" });
  assert.equal(stageRes.code, 0, stageRes.stderr);
  assert.match(stageRes.stdout, new RegExp(firstBackupDirName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  cleanupScratch();
});

// ===============================================================================================
// Codex panel finding I3: operational-table isolation must be an ENFORCED invariant of the
// executable (a hard allowlist checked before every batch execution), not merely a property of
// today's reviewed SQL text. A sabotaged staging file referencing an operational table must be
// refused, never executed.
// ===============================================================================================

test("I3 (Codex): isAllowedTableName accepts every tire-scope table + staging/_old_/_failed_promotion variants, and sqlite_master", () => {
  for (const t of ["tires", "tire_part_numbers", "tire_product_part_number_aliases", "canonical_tire_products", "provenance"]) {
    assert.ok(isAllowedTableName(t), `expected base table ${t} to be allowed`);
    assert.ok(isAllowedTableName(`staging_${t}`), `expected staging_${t} to be allowed`);
    assert.ok(isAllowedTableName(`${t}_old_20260728_120000`), `expected ${t}_old_<ts> to be allowed`);
    assert.ok(isAllowedTableName(`${t}_failed_promotion_20260728_120000`), `expected ${t}_failed_promotion_<ts> to be allowed`);
  }
  assert.ok(isAllowedTableName("sqlite_master"), "sqlite_master reads must be allowed");
});

test("I3 (Codex): isAllowedTableName REJECTS every operational table and arbitrary names", () => {
  for (const t of OPERATIONAL_TABLES) {
    assert.ok(!isAllowedTableName(t), `expected operational table ${t} to be REJECTED`);
  }
  assert.ok(!isAllowedTableName("retail"));
  assert.ok(!isAllowedTableName("decode_cache"));
  assert.ok(!isAllowedTableName("some_random_table"));
  assert.ok(!isAllowedTableName("tires_staging")); // wrong prefix direction - must not be confused with staging_tires
});

test("I3 (Codex): assertAllowedTables throws a clear error on a statement referencing an operational table", () => {
  assert.throws(
    () => assertAllowedTables(["DELETE FROM retail;"], "test-label"),
    /REFUSING to execute.*"retail"/s
  );
  assert.throws(
    () => assertAllowedTables(["INSERT INTO decode_cache (barcode) VALUES ('x');"], "test-label"),
    /REFUSING to execute.*"decode_cache"/s
  );
  // Allowed statements must NOT throw.
  assert.doesNotThrow(() => assertAllowedTables(["CREATE TABLE IF NOT EXISTS staging_tires (barcode TEXT PRIMARY KEY);"], "test-label"));
  assert.doesNotThrow(() => assertAllowedTables(["ALTER TABLE tires RENAME TO tires_old_20260728;"], "test-label"));
});

test("I3 (Codex): stage REFUSES end-to-end when a sabotaged staging file references an operational table (retail)", async () => {
  freshScratch();
  fixture = await seedFakeLiveDb();

  // Sabotage: append a statement to a staging file that touches the operational `retail` table -
  // exactly the attack I3 must catch regardless of source (tampered file, wrong PROMOTE_STAGING_DIR).
  // The sabotage happens BEFORE backup here (not after) so the C3 staging-content-hash check (which
  // fires first, and is itself a correct, separate defense) sees consistent content and does not
  // mask the I3 allowlist assertion this test targets - a real attacker sabotaging the staging
  // directory would do so before an operator runs backup+stage against it, not after.
  const targetFile = join(stagingDir, "02_staging_tire_part_numbers.sql");
  const original = readFileSync(targetFile, "utf8");
  writeFileSync(targetFile, original + "\nDELETE FROM retail;\n", "utf8");

  runCli(["backup"], { PROMOTE_CONFIRM: "YES" });

  const stageRes = runCli(["stage"], { PROMOTE_CONFIRM: "YES" });
  assert.notEqual(stageRes.code, 0, "stage must refuse when a staging file references an operational table");
  assert.match(stageRes.stderr, /REFUSING to execute/);
  assert.match(stageRes.stderr, /"retail"/);

  // Confirm retail was NEVER touched - the sentinel row must be untouched.
  const client = createClient({ url: dbUrl });
  assert.equal(await rowCount(client, "retail"), 1, "retail must be completely untouched by the refused sabotage attempt");
  client.close();

  cleanupScratch();
});

// ===============================================================================================
// Codex panel finding M1: verify --dry-run must print "DRY-RUN: not evaluated" and NEVER PASS/FAIL
// wording, and must return passed: null (not true) so no caller mistakes it for a real result.
// ===============================================================================================

test("M1 (Codex): verify --dry-run prints DRY-RUN markers, never a real gate PASS/FAIL verdict, exits 0", () => {
  freshScratch();
  const res = runCli(["verify", "--dry-run"], { PROMOTE_CONFIRM: "" });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /DRY-RUN: not evaluated/);
  assert.match(res.stdout, /DRY-RUN COMPLETE/);
  // The old bug (panel M1) was returning { passed: true } and printing gate descriptions that read
  // as a real result. The fix's invariant: no line claims a gate actually PASSED or FAILED - every
  // gate line is explicitly tagged "DRY-RUN: not evaluated", and the real verify() verdict strings
  // ("ALL GATES PASSED" / "GATE FAILURE" / a bare "PASS <gate>" / "FAIL <gate>" line) never appear.
  assert.doesNotMatch(res.stdout, /ALL GATES PASSED/);
  assert.doesNotMatch(res.stdout, /GATE FAILURE/);
  assert.doesNotMatch(res.stdout, /^\s*PASS /m);
  assert.doesNotMatch(res.stdout, /^\s*FAIL /m);
  // Every "Gate <letter>:" line must carry the explicit not-evaluated tag.
  const gateLines = res.stdout.split("\n").filter((l) => /^\s*Gate [A-Z]/.test(l));
  assert.ok(gateLines.length >= 8, `expected at least 8 gate description lines, got ${gateLines.length}`);
  for (const line of gateLines) {
    assert.match(line, /DRY-RUN: not evaluated/, `gate line missing not-evaluated tag: ${line}`);
  }
  cleanupScratch();
});

// ===============================================================================================
// Re-review OPEN-1 / Codex C1's hard gate: live tire_part_numbers key preservation with an
// explicit approved-drops file. Any live PN key missing from staging must appear in
// APPROVED_PN_KEY_DROPS.csv or the verify gate (and post-promote smoke) FAILS.
// ===============================================================================================

test("OPEN-1 (a): PN gate PASSES when exactly the approved keys are missing (missing=N, approved=N, unapproved=0)", async () => {
  freshScratch();
  fixture = await seedFakeLiveDb();
  runCli(["backup"], { PROMOTE_CONFIRM: "YES" });
  runCli(["stage"], { PROMOTE_CONFIRM: "YES" });

  const verifyRes = runCli(["verify"], { PROMOTE_CONFIRM: "YES" });
  assert.equal(verifyRes.code, 0, verifyRes.stderr + verifyRes.stdout);
  // The fixture's one live key (LIVEPN0001) is absent from staging AND listed in the scratch
  // approved-drops file - the exact "only approved keys are missing" shape of the real 17-key run.
  assert.match(verifyRes.stdout, /PASS PN_live_part_number_keys_preserved: missing=1, approved=1, unapproved=0/);
  assert.match(verifyRes.stdout, /ALL GATES PASSED/);

  cleanupScratch();
});

test("OPEN-1 (b): PN gate FAILS when one extra live key is absent from staging and NOT approved (unapproved=1)", async () => {
  freshScratch();
  fixture = await seedFakeLiveDb();

  // Add a SECOND live PN key that is neither in staging nor in the approved-drops file. Inserted
  // BEFORE backup so the C3 live-drift check sees a consistent snapshot and cannot mask this gate.
  const client = createClient({ url: dbUrl });
  await client.execute(
    `INSERT INTO tire_part_numbers (normalized_part_number, canonical_product_uid) VALUES ('LIVEPN_UNAPPROVED', 'SOME_UID')`
  );
  client.close();

  runCli(["backup"], { PROMOTE_CONFIRM: "YES" });
  runCli(["stage"], { PROMOTE_CONFIRM: "YES" });

  const verifyRes = runCli(["verify"], { PROMOTE_CONFIRM: "YES" });
  assert.equal(verifyRes.code, 1, "verify must exit non-zero when an unapproved live PN key would be dropped");
  assert.match(verifyRes.stdout, /FAIL PN_live_part_number_keys_preserved: missing=2, approved=1, unapproved=1/);
  assert.match(verifyRes.stdout, /UNAPPROVED: LIVEPN_UNAPPROVED/);
  assert.match(verifyRes.stdout, /GATE FAILURE/);

  cleanupScratch();
});

test("OPEN-1 (c): PN gate FAILS when the approved-drops file is missing while any live key is missing", async () => {
  freshScratch();
  fixture = await seedFakeLiveDb();
  runCli(["backup"], { PROMOTE_CONFIRM: "YES" });
  runCli(["stage"], { PROMOTE_CONFIRM: "YES" });

  // Remove the approved-drops file: LIVEPN0001 is still missing from staging, and with no
  // approvals file present NO drop is approved - the gate must fail closed, not silently treat
  // "no file" as "nothing to check".
  rmSync(approvedDropsPath, { force: true });

  const verifyRes = runCli(["verify"], { PROMOTE_CONFIRM: "YES" });
  assert.equal(verifyRes.code, 1, "verify must fail closed when keys are missing and no approvals file exists");
  assert.match(verifyRes.stdout, /FAIL PN_live_part_number_keys_preserved: missing=1, approved=0, unapproved=1/);
  assert.match(verifyRes.stdout, /GATE FAILURE/);

  cleanupScratch();
});

test("OPEN-1/Critical#1: promote's PRE-SWAP verify gate catches an unapproved dropped PN key and refuses BEFORE the swap, even when verify was skipped", async () => {
  freshScratch();
  fixture = await seedFakeLiveDb();

  // Second live PN key, unapproved. verify would catch it - and (Critical finding #1) promote's own
  // pre-swap re-run of the full gate battery ALSO catches it independently, even when the operator
  // skips verify entirely - promote never trusts a prior separate verify run.
  const client = createClient({ url: dbUrl });
  await client.execute(
    `INSERT INTO tire_part_numbers (normalized_part_number, canonical_product_uid) VALUES ('LIVEPN_SMOKED', 'SOME_UID2')`
  );
  client.close();

  runCli(["backup"], { PROMOTE_CONFIRM: "YES" });
  runCli(["stage"], { PROMOTE_CONFIRM: "YES" });
  // Skip verify deliberately - promote's own pre-swap gate re-run must stand alone.
  const promoteRes = runCli(["promote"], { PROMOTE_CONFIRM: "YES", PROMOTE_TS: "PNSMOKETS" });
  assert.notEqual(promoteRes.code, 0, "promote must exit nonzero when the pre-swap PN preservation gate fails");
  assert.match(promoteRes.stdout, /FAIL PN_live_part_number_keys_preserved: missing=2, approved=1, unapproved=1/);
  assert.match(promoteRes.stdout, /UNAPPROVED: LIVEPN_SMOKED/);
  assert.match(promoteRes.stderr, /REFUSING to swap/);

  // The swap must NOT have happened: no _old_ tables were created for this ts.
  const client2 = createClient({ url: dbUrl });
  assert.ok(!(await tableExists(client2, "tires_old_PNSMOKETS")), "the swap must not have run - no _old_ table should exist");
  assert.ok(!(await tableExists(client2, "tire_part_numbers_old_PNSMOKETS")));
  client2.close();

  cleanupScratch();
});

test("OPEN-1: the real checked-in APPROVED_PN_KEY_DROPS.csv contains exactly the 17 owner-approved keys", () => {
  const realPath = join(
    REPO_ROOT, "backups", "claude-tire-db-handoff-2026-07-28", "repair-2026-07-28", "APPROVED_PN_KEY_DROPS.csv"
  );
  assert.ok(existsSync(realPath), "APPROVED_PN_KEY_DROPS.csv must exist in the repair package");
  const lines = readFileSync(realPath, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
  const keys = lines.slice(1).map((l) => l.split(",")[0].trim()).filter(Boolean).sort();
  const SEVENTEEN = [
    "20244", "9265031141", "312250", "352430", "352050", "345050", "345120", "360220", "360460",
    "360280", "360420", "360800", "318010", "318180", "318320", "351200", "254350",
  ].sort();
  assert.deepEqual(keys, SEVENTEEN, "the approved-drops file must list exactly the 17 keys from PROMOTE_PREFLIGHT_REPORT.md Proof 2 - no more, no fewer");
  // Every data row must carry a decision reference and date (owner-decision provenance).
  for (const line of lines.slice(1)) {
    const parts = line.split(",");
    assert.ok(parts.length >= 3, `approved-drops row missing reference/date columns: ${line}`);
    assert.match(parts[1], /PROMOTE_PREFLIGHT_REPORT|TURSO_DRYRUN_REPORT/, `row lacks an owner-decision reference: ${line}`);
    assert.match(parts[2], /^\d{4}-\d{2}-\d{2}$/, `row lacks a decision date: ${line}`);
  }
});

// ===============================================================================================
// Fix round 3 (live promote #2 gap, task-PROMOTE2-EXEC-report.md): FULL DOUBLE-PROMOTE cycle.
// Promote once, regenerate the staging package (one extra alias row = measurably different
// generation), promote again. The old refusal ("NEW_TABLES live names already exist") must be
// gone: the three NEW_TABLES now get the same rename-aside _old_<ts> treatment as
// tires/tire_part_numbers. Then rollback of the SECOND promote must restore the FIRST promote's
// state exactly - including the three NEW_TABLES' generation-1 content.
// ===============================================================================================

test("ROUND-3: full double-promote cycle - second promote succeeds, both _old_ generations coexist, rollback restores promote-#1 state exactly", async () => {
  freshScratch();
  fixture = await seedFakeLiveDb();

  // ---- Promote #1 (first-promote path: NEW_TABLES created from staging) ----
  runCli(["backup"], { PROMOTE_CONFIRM: "YES" });
  runCli(["stage"], { PROMOTE_CONFIRM: "YES" });
  const promote1 = runCli(["promote"], { PROMOTE_CONFIRM: "YES", PROMOTE_TS: "R3GEN1" });
  assert.equal(promote1.code, 0, promote1.stderr);
  assert.match(promote1.stdout, /first-promote path: NEW_TABLES created from staging/);

  const c1 = createClient({ url: dbUrl });
  const gen1TiresCount = await rowCount(c1, "tires");
  const gen1PnCount = await rowCount(c1, "tire_part_numbers");
  const gen1AliasCount = await rowCount(c1, "tire_product_part_number_aliases");
  const gen1CanonicalCount = await rowCount(c1, "canonical_tire_products");
  const gen1ProvenanceCount = await rowCount(c1, "provenance");
  c1.close();

  // ---- "New package": regenerate staging with ONE extra alias row so generation 2 is
  // measurably different from generation 1 (gen2 alias count = gen1 + 1). The new row reuses an
  // EXISTING canonical_product_id from the real dataset so verify's orphan gate F stays green. ----
  const aliasFile = join(stagingDir, "03_staging_tire_product_part_number_aliases.sql");
  const aliasOrig = readFileSync(aliasFile, "utf8");
  const existingCanonicalId = aliasOrig.match(/\(\s*'(TIRE_[0-9A-F]+)'/)[1];
  writeFileSync(
    aliasFile,
    aliasOrig +
      "\nINSERT OR REPLACE INTO staging_tire_product_part_number_aliases (canonical_product_id, normalized_part_number, display_part_number, source, trust_color, confidence_score, is_unambiguous)\nVALUES\n" +
      `  ('${existingCanonicalId}', 'R3NEWALIAS', 'R3NEWALIAS', 'test_round3_regen', 'green', 100, 1);\n`,
    "utf8"
  );

  // ---- Promote #2 (second-promote path: NEW_TABLES renamed aside). Fresh backup is REQUIRED
  // (live changed after promote #1 AND staging content changed) - exactly the real operational
  // sequence from task-PROMOTE2-EXEC-report.md. ----
  const backup2 = runCli(["backup"], { PROMOTE_CONFIRM: "YES", PROMOTE_TS: "R3BACKUP2" });
  assert.equal(backup2.code, 0, backup2.stderr);
  runCli(["stage"], { PROMOTE_CONFIRM: "YES" });
  const verify2 = runCli(["verify"], { PROMOTE_CONFIRM: "YES" });
  assert.equal(verify2.code, 0, verify2.stderr + verify2.stdout);
  assert.match(verify2.stdout, /PASS PN_live_part_number_keys_preserved: missing=0, approved=0, unapproved=0/);
  assert.match(verify2.stdout, /ALL GATES PASSED/);

  const promote2 = runCli(["promote"], { PROMOTE_CONFIRM: "YES", PROMOTE_TS: "R3GEN2" });
  // THE round-3 fix: this is the exact call that live promote #2 was refused on. Refusal must be gone.
  assert.equal(promote2.code, 0, promote2.stderr + promote2.stdout);
  assert.doesNotMatch(promote2.stderr ?? "", /REFUSING/);
  assert.match(promote2.stdout, /second-promote path: renaming aside tire_product_part_number_aliases, canonical_tire_products, provenance/);
  assert.match(promote2.stdout, /PASS smoke_index_presence/);
  assert.match(promote2.stdout, /PASS smoke_pn_key_preservation: missing=0, approved=0, unapproved=0/);
  assert.match(promote2.stdout, /SMOKE TEST PASSED/);

  const c2 = createClient({ url: dbUrl });
  // All five live tables swapped to generation 2 (alias table proves it: +1 row, new key present).
  assert.equal(await rowCount(c2, "tires"), gen1TiresCount);
  assert.equal(await rowCount(c2, "tire_part_numbers"), gen1PnCount);
  assert.equal(await rowCount(c2, "tire_product_part_number_aliases"), gen1AliasCount + 1);
  assert.equal(await rowCount(c2, "canonical_tire_products"), gen1CanonicalCount);
  assert.equal(await rowCount(c2, "provenance"), gen1ProvenanceCount);
  const newAliasRow = await c2.execute("SELECT * FROM tire_product_part_number_aliases WHERE normalized_part_number = 'R3NEWALIAS'");
  assert.equal(newAliasRow.rows.length, 1, "generation-2 alias row must be live after promote #2");

  // Both _old_ generations coexist: GEN1 (tires/tpn only - first promote had no NEW_TABLES to
  // rename aside) and GEN2 (all five).
  for (const t of ["tires_old_R3GEN1", "tire_part_numbers_old_R3GEN1",
                   "tires_old_R3GEN2", "tire_part_numbers_old_R3GEN2",
                   "tire_product_part_number_aliases_old_R3GEN2",
                   "canonical_tire_products_old_R3GEN2", "provenance_old_R3GEN2"]) {
    assert.ok(await tableExists(c2, t), `expected ${t} to exist after the double promote`);
  }
  assert.ok(!(await tableExists(c2, "tire_product_part_number_aliases_old_R3GEN1")), "first promote had no prior alias generation to rename aside");

  // Index-name carryover fix: every required index must be attached to the LIVE table, not to an
  // _old_ generation (the pre-fix CREATE INDEX IF NOT EXISTS would have silently left the fresh
  // tables unindexed here).
  const idxRes = await c2.execute("SELECT name, tbl_name FROM sqlite_master WHERE type='index'");
  const idxByName = new Map(idxRes.rows.map((r) => [String(r.name), String(r.tbl_name)]));
  assert.equal(idxByName.get("idx_tire_barcode"), "tires");
  assert.equal(idxByName.get("idx_tire_part_number"), "tires");
  assert.equal(idxByName.get("idx_tire_uid"), "tires");
  assert.equal(idxByName.get("idx_tire_part_numbers_uid"), "tire_part_numbers");
  assert.equal(idxByName.get("idx_tire_pn_aliases_normalized"), "tire_product_part_number_aliases");

  // Operational sentinels untouched through both promotes.
  assert.equal(await rowCount(c2, "retail"), 1);
  assert.equal(await rowCount(c2, "decode_cache"), 1);
  c2.close();

  // ---- Rollback of promote #2: must restore promote #1's state EXACTLY, including the three
  // NEW_TABLES' generation-1 content (rename-back, NOT drop). ----
  const rollback = runCli(["rollback", "--ts", "R3GEN2"], { PROMOTE_CONFIRM: "YES" });
  assert.equal(rollback.code, 0, rollback.stderr);

  const c3 = createClient({ url: dbUrl });
  assert.equal(await rowCount(c3, "tires"), gen1TiresCount, "rollback must restore promote-#1 tires");
  assert.equal(await rowCount(c3, "tire_part_numbers"), gen1PnCount);
  assert.ok(await tableExists(c3, "tire_product_part_number_aliases"), "alias table must be RESTORED (not dropped) on a second-promote rollback");
  assert.equal(await rowCount(c3, "tire_product_part_number_aliases"), gen1AliasCount, "alias table must hold generation-1 content again");
  const rolledBackAlias = await c3.execute("SELECT * FROM tire_product_part_number_aliases WHERE normalized_part_number = 'R3NEWALIAS'");
  assert.equal(rolledBackAlias.rows.length, 0, "the generation-2 alias row must be gone after rollback");
  assert.equal(await rowCount(c3, "canonical_tire_products"), gen1CanonicalCount);
  assert.equal(await rowCount(c3, "provenance"), gen1ProvenanceCount);

  // Failed-promotion set exists for all five; GEN1's rollback net remains untouched.
  for (const t of ["tires_failed_promotion_R3GEN2", "tire_part_numbers_failed_promotion_R3GEN2",
                   "tire_product_part_number_aliases_failed_promotion_R3GEN2",
                   "canonical_tire_products_failed_promotion_R3GEN2", "provenance_failed_promotion_R3GEN2"]) {
    assert.ok(await tableExists(c3, t), `expected ${t} after second-promote rollback`);
  }
  assert.ok(await tableExists(c3, "tires_old_R3GEN1"), "promote-#1 rollback net must survive the promote-#2 rollback");
  assert.ok(await tableExists(c3, "tire_part_numbers_old_R3GEN1"));

  // Indexes recreated on the RESTORED live tables (incl. the restored alias table).
  const idxRes3 = await c3.execute("SELECT name, tbl_name FROM sqlite_master WHERE type='index'");
  const idxByName3 = new Map(idxRes3.rows.map((r) => [String(r.name), String(r.tbl_name)]));
  assert.equal(idxByName3.get("idx_tire_uid"), "tires");
  assert.equal(idxByName3.get("idx_tire_part_numbers_uid"), "tire_part_numbers");
  assert.equal(idxByName3.get("idx_tire_pn_aliases_normalized"), "tire_product_part_number_aliases");

  // Operational sentinels untouched through the whole double-promote + rollback journey.
  assert.equal(await rowCount(c3, "retail"), 1);
  const sentinel = await c3.execute("SELECT sentinel FROM retail WHERE barcode = '999999999999'");
  assert.equal(sentinel.rows[0].sentinel, "DO_NOT_TOUCH");
  assert.equal(await rowCount(c3, "decode_cache"), 1);
  c3.close();

  cleanupScratch();
});

// ===============================================================================================
// PR-panel harden round (2026-07-28): three findings from pr-panel-codex.md.
//   Critical #1: promote must re-verify staging IN THE SAME INVOCATION immediately before the
//     atomic swap (not trust a stale/separate `verify` run), and the post-swap smoke must assert
//     exact count equality across all 5 tables, not just 1 sampled row per table.
//   Important #2: the drift gate must catch a content mutation (UPDATE, or DELETE+INSERT that nets
//     to the same row count) between backup and promote, not just a COUNT(*) change.
//   Important #3: assertAllowedTables/extractTableNames must be FAIL-CLOSED - an unrecognized
//     statement shape (or one whose table name this scanner cannot parse) must be REJECTED, not
//     silently allowed just because no name was extracted.
// ===============================================================================================

test("PR-panel Critical#1(a): promote's own pre-swap re-verify catches staging truncated AFTER a stale 'verify passed' run, even though verify itself already said PASS earlier", async () => {
  freshScratch();
  fixture = await seedFakeLiveDb();
  runCli(["backup"], { PROMOTE_CONFIRM: "YES" });
  runCli(["stage"], { PROMOTE_CONFIRM: "YES" });

  // A real, honest verify run passes against the correctly-staged data.
  const verifyRes = runCli(["verify"], { PROMOTE_CONFIRM: "YES" });
  assert.equal(verifyRes.code, 0, verifyRes.stderr + verifyRes.stdout);
  assert.match(verifyRes.stdout, /ALL GATES PASSED/);

  // AFTER that PASS, staging is tampered/truncated (simulating a partial re-stage, a stray manual
  // DELETE, or any drift between "verify said yes" and "promote actually runs"). The stale verify
  // result must NOT be trusted by promote - this is exactly the Critical #1 hazard: verify and
  // promote were independent commands with no re-check binding them together.
  const client = createClient({ url: dbUrl });
  await client.execute(`DELETE FROM staging_tires WHERE rowid IN (SELECT rowid FROM staging_tires LIMIT 500)`);
  client.close();

  const promoteRes = runCli(["promote"], { PROMOTE_CONFIRM: "YES", PROMOTE_TS: "STALEVERIFYTS" });
  assert.notEqual(promoteRes.code, 0, "promote must refuse even though a PRIOR separate verify run had passed");
  assert.match(promoteRes.stdout, /pre-swap verify gate results/);
  assert.match(promoteRes.stdout, /FAIL B_staging_tires_count/);
  assert.match(promoteRes.stdout, /MISMATCH/);
  assert.match(promoteRes.stderr, /REFUSING to swap/);
  assert.match(promoteRes.stderr, /pre-swap verify gate battery FAILED/);

  // The swap must not have happened.
  const client2 = createClient({ url: dbUrl });
  assert.ok(!(await tableExists(client2, "tires_old_STALEVERIFYTS")));
  assert.equal(await rowCount(client2, "tires"), 1, "live tires must be untouched - the original pre-promote row only");
  client2.close();

  cleanupScratch();
});

test("PR-panel Critical#1(c): a post-swap count mismatch (simulated partial swap) retains _old_ tables and exits nonzero", async () => {
  freshScratch();
  fixture = await seedFakeLiveDb();
  runCli(["backup"], { PROMOTE_CONFIRM: "YES" });
  runCli(["stage"], { PROMOTE_CONFIRM: "YES" });

  // Directly exercise runPostSwapSmokeTest's new smoke_full_row_count_equality check in isolation
  // (rather than trying to force a genuine partial ALTER TABLE batch, which SQLite/libsql applies
  // atomically and cannot easily be interrupted mid-batch from a test): simulate the exact SYMPTOM
  // a partial/anomalous swap would leave behind - live row count differs from what was staged -
  // and confirm the smoke check catches it and reports a clear mismatch.
  const client = createClient({ url: dbUrl });
  const stagedTiresCount = await rowCount(client, "staging_tires");
  client.close();

  const smokeClient = createClient({ url: dbUrl });

  // Simulate a swap that under-delivered: live `tires` will still be the OLD 1-row table (promote
  // was never run in this test), while preSwapStagedCounts claims the full staged count - exactly
  // the shape of damage the check must catch (live count != what was staged).
  const fakePreSwapStagedCounts = {
    staging_tires: stagedTiresCount,
    staging_tire_part_numbers: 999999, // deliberately wrong too, to prove multiple mismatches report
  };
  const { pass, checks } = await runPostSwapSmokeTest(smokeClient, "FAKETS", fakePreSwapStagedCounts);
  const countCheck = checks.find((c) => c.name === "smoke_full_row_count_equality");
  assert.ok(countCheck, "expected a smoke_full_row_count_equality check to run when preSwapStagedCounts is provided");
  assert.equal(countCheck.pass, false, "count-equality check must FAIL when live does not match pre-swap staged counts");
  assert.match(countCheck.detail, /MISMATCH/);
  assert.match(countCheck.detail, /tires: staged \d+, live 1/);
  assert.equal(pass, false, "overall smoke test must fail when the count-equality check fails");

  smokeClient.close();
  cleanupScratch();
});

test("PR-panel Critical#1(c) end-to-end: promote's real post-swap smoke includes exact 5-table count equality on a correct swap", async () => {
  freshScratch();
  fixture = await seedFakeLiveDb();
  runCli(["backup"], { PROMOTE_CONFIRM: "YES" });
  runCli(["stage"], { PROMOTE_CONFIRM: "YES" });

  const promoteRes = runCli(["promote"], { PROMOTE_CONFIRM: "YES", PROMOTE_TS: "COUNTEQTS" });
  assert.equal(promoteRes.code, 0, promoteRes.stderr);
  assert.match(promoteRes.stdout, /PASS smoke_full_row_count_equality: all 5 tables: live count exactly matches pre-swap staged count/);
  assert.match(promoteRes.stdout, /SMOKE TEST PASSED/);

  cleanupScratch();
});

test("PR-panel Important#2: content fingerprint catches an equal-count UPDATE between backup and stage (COUNT(*) alone would miss this)", async () => {
  freshScratch();
  fixture = await seedFakeLiveDb();
  const backupRes = runCli(["backup"], { PROMOTE_CONFIRM: "YES" });
  assert.equal(backupRes.code, 0, backupRes.stderr);

  // Mutate an EXISTING live row's content without changing the row count: an UPDATE that changes
  // canonical_product_uid and brand. COUNT(*) before and after is identical (still 1 row) - this is
  // exactly the gap Important finding #2 targets.
  const client = createClient({ url: dbUrl });
  const before = await rowCount(client, "tires");
  await client.execute(
    `UPDATE tires SET canonical_product_uid = 'MUTATED_UID', brand = 'MUTATEDBRAND' WHERE barcode = ?`,
    [fixture.sampleBarcode]
  );
  const after = await rowCount(client, "tires");
  assert.equal(before, after, "row count must be unchanged by the UPDATE - this is the blind spot being tested");
  client.close();

  const stageRes = runCli(["stage"], { PROMOTE_CONFIRM: "YES" });
  assert.notEqual(stageRes.code, 0, "stage must refuse: live content changed since backup even though row counts match");
  assert.match(stageRes.stderr, /live data CHANGED since the bound backup even though row counts match/);
  assert.match(stageRes.stderr, /content fingerprint mismatch on: tires/);

  cleanupScratch();
});

test("PR-panel Important#2: content fingerprint catches an equal-count DELETE+INSERT (row swap) between backup and verify", async () => {
  freshScratch();
  fixture = await seedFakeLiveDb();
  runCli(["backup"], { PROMOTE_CONFIRM: "YES" });
  const stageRes = runCli(["stage"], { PROMOTE_CONFIRM: "YES" });
  assert.equal(stageRes.code, 0, stageRes.stderr);

  // DELETE the live tire_part_numbers row and INSERT a different one - net row count unchanged, but
  // the actual key content is now entirely different. This must be caught even though it lands
  // between stage and verify (not just backup and stage), proving the fingerprint check runs at
  // every gate that calls assertLiveUnchangedSinceManifest, exactly like the existing count-only C3
  // drift checks do for stage/verify/promote.
  const client = createClient({ url: dbUrl });
  const before = await rowCount(client, "tire_part_numbers");
  await client.execute(`DELETE FROM tire_part_numbers WHERE normalized_part_number = 'LIVEPN0001'`);
  await client.execute(
    `INSERT INTO tire_part_numbers (normalized_part_number, canonical_product_uid) VALUES ('SWAPPED_IN_PN', 'SWAPPED_UID')`
  );
  const after = await rowCount(client, "tire_part_numbers");
  assert.equal(before, after, "row count must be unchanged by the delete+insert swap");
  client.close();

  const verifyRes = runCli(["verify"], { PROMOTE_CONFIRM: "YES" });
  assert.notEqual(verifyRes.code, 0, "verify must refuse: live content changed (delete+insert) since backup even though row counts match");
  assert.match(verifyRes.stderr, /content fingerprint mismatch on: tire_part_numbers/);

  cleanupScratch();
});

test("PR-panel Important#2: a genuinely UNCHANGED live table (same rows, same content) never trips the fingerprint check", async () => {
  freshScratch();
  fixture = await seedFakeLiveDb();
  runCli(["backup"], { PROMOTE_CONFIRM: "YES" });

  // No mutation at all - stage/verify must proceed normally, proving the fingerprint check is not a
  // false-positive trap on the ordinary unchanged-live-data path already covered by the full-cycle test.
  const stageRes = runCli(["stage"], { PROMOTE_CONFIRM: "YES" });
  assert.equal(stageRes.code, 0, stageRes.stderr);
  const verifyRes = runCli(["verify"], { PROMOTE_CONFIRM: "YES" });
  assert.equal(verifyRes.code, 0, verifyRes.stderr + verifyRes.stdout);
  assert.match(verifyRes.stdout, /ALL GATES PASSED/);

  cleanupScratch();
});

test("PR-panel Important#3: fail-closed allowlist REJECTS REPLACE INTO on an operational table", () => {
  assert.throws(
    () => assertAllowedTables(["REPLACE INTO retail (barcode, product_name) VALUES ('1', 'x');"], "test-label"),
    /REFUSING to execute.*"retail"/s
  );
});

test("PR-panel Important#3: fail-closed allowlist REJECTS INSERT OR REPLACE on an operational table", () => {
  assert.throws(
    () => assertAllowedTables(["INSERT OR REPLACE INTO decode_cache (barcode) VALUES ('x');"], "test-label"),
    /REFUSING to execute.*"decode_cache"/s
  );
});

test("PR-panel Important#3: fail-closed allowlist REJECTS a bare DROP INDEX (no table name extractable) that is not on the explicit no-table allowlist shape only when it targets nothing recognizable - a legitimate DROP INDEX IF EXISTS must still be ALLOWED", () => {
  // DROP INDEX IF EXISTS <name> never names a TABLE (SQLite resolves the owning table internally),
  // so extractTableNames legitimately returns zero names for it. Before this fix, "zero names
  // extracted" meant "silently allowed" for ANY statement shape - the actual security gap. After the
  // fix, DROP INDEX is allowed ONLY because it is on the explicit isAllowedNoTableStatement allowlist,
  // not because it fell through unmatched.
  assert.doesNotThrow(() => assertAllowedTables(["DROP INDEX IF EXISTS idx_tire_barcode;"], "test-label"));
  assert.ok(isAllowedNoTableStatement("DROP INDEX IF EXISTS idx_tire_barcode;"));
});

test("PR-panel Important#3: fail-closed allowlist REJECTS an unrecognized statement shape that extracts no table name and is not on the no-table allowlist", () => {
  // A statement this scanner cannot parse into a table name AND that is not one of the enumerated
  // no-table shapes (PRAGMA/BEGIN/COMMIT/ROLLBACK/DROP INDEX/blank/comment) must be REJECTED, not
  // silently passed through. This is the core fail-open -> fail-closed fix: previously "extraction
  // found nothing" was treated as "nothing to check", which is exactly backwards for a security gate.
  assert.throws(
    () => assertAllowedTables(["VACUUM;"], "test-label"),
    /REFUSING to execute.*not one of the explicitly allowed no-table statements/s
  );
  assert.throws(
    () => assertAllowedTables(["ANALYZE;"], "test-label"),
    /REFUSING to execute/s
  );
});

test("PR-panel Important#3: fail-closed allowlist still ALLOWS the legitimate no-table statement shapes (PRAGMA, BEGIN/COMMIT, blank/comment-only)", () => {
  assert.doesNotThrow(() => assertAllowedTables(["PRAGMA integrity_check;"], "test-label"));
  assert.doesNotThrow(() => assertAllowedTables(["PRAGMA foreign_keys = OFF;"], "test-label"));
  assert.doesNotThrow(() => assertAllowedTables(["BEGIN;"], "test-label"));
  assert.doesNotThrow(() => assertAllowedTables(["COMMIT;"], "test-label"));
  assert.doesNotThrow(() => assertAllowedTables(["ROLLBACK;"], "test-label"));
  assert.doesNotThrow(() => assertAllowedTables(["-- just a comment\n"], "test-label"));
  assert.doesNotThrow(() => assertAllowedTables(["   \n  \n"], "test-label"));
  assert.doesNotThrow(() => assertAllowedTables([""], "test-label"));
});

test("PR-panel Important#3: fail-closed allowlist still ALLOWS every legitimate staging/promote statement shape (regression: the real workflow must keep working)", () => {
  // This mirrors the exact statement shapes this script's own stage()/cmdPromote()/cmdRollback()
  // build, to prove the fail-closed tightening did not accidentally break the real workflow.
  assert.doesNotThrow(() => assertAllowedTables(["DROP TABLE IF EXISTS staging_tires;"], "test-label"));
  assert.doesNotThrow(() => assertAllowedTables(["CREATE TABLE IF NOT EXISTS staging_tires (barcode TEXT PRIMARY KEY);"], "test-label"));
  assert.doesNotThrow(() => assertAllowedTables(["INSERT OR REPLACE INTO staging_tires (barcode) VALUES ('1');"], "test-label"));
  assert.doesNotThrow(() => assertAllowedTables(["ALTER TABLE tires RENAME TO tires_old_20260728;"], "test-label"));
  assert.doesNotThrow(() => assertAllowedTables(["ALTER TABLE staging_tires RENAME TO tires;"], "test-label"));
  assert.doesNotThrow(() => assertAllowedTables(["DROP INDEX IF EXISTS idx_tire_barcode;"], "test-label"));
  assert.doesNotThrow(() => assertAllowedTables(["CREATE INDEX idx_tire_barcode ON tires(barcode);"], "test-label"));
  assert.doesNotThrow(() => assertAllowedTables(["SELECT COUNT(*) c FROM staging_tires;"], "test-label"));
  assert.doesNotThrow(() =>
    assertAllowedTables(
      [`SELECT COUNT(*) c FROM staging_tire_part_numbers p
       LEFT JOIN staging_tires t ON t.canonical_product_uid = p.canonical_product_uid
       WHERE t.barcode IS NULL;`],
      "test-label"
    )
  );
});

test("PR-panel Important#3 end-to-end: a sabotaged staging file using REPLACE INTO on an operational table is refused, never executed", async () => {
  freshScratch();
  fixture = await seedFakeLiveDb();

  // The original I3 (Codex) test proved a plain DELETE FROM retail is caught. This proves the
  // FAIL-OPEN gap specifically: REPLACE INTO was one of the statement shapes extractTableNames could
  // not recognize (only "INSERT [OR REPLACE] INTO" was matched, not bare "REPLACE INTO"), so it used
  // to sail through as "no names extracted -> allowed". Now it must be both recognized (this scanner
  // extracts "retail" from it) AND rejected.
  const targetFile = join(stagingDir, "02_staging_tire_part_numbers.sql");
  const original = readFileSync(targetFile, "utf8");
  writeFileSync(targetFile, original + "\nREPLACE INTO retail (barcode, product_name) VALUES ('1', 'sabotage');\n", "utf8");

  runCli(["backup"], { PROMOTE_CONFIRM: "YES" });
  const stageRes = runCli(["stage"], { PROMOTE_CONFIRM: "YES" });
  assert.notEqual(stageRes.code, 0, "stage must refuse when a staging file uses REPLACE INTO against an operational table");
  assert.match(stageRes.stderr, /REFUSING to execute/);
  assert.match(stageRes.stderr, /"retail"/);

  const client = createClient({ url: dbUrl });
  assert.equal(await rowCount(client, "retail"), 1, "retail must be completely untouched by the refused sabotage attempt");
  const sentinelRes = await client.execute("SELECT sentinel FROM retail WHERE barcode = '999999999999'");
  assert.equal(sentinelRes.rows[0].sentinel, "DO_NOT_TOUCH");
  client.close();

  cleanupScratch();
});

test("PR-panel Important#3 end-to-end: a sabotaged staging file using DROP INDEX on an arbitrary name is still bound by table-name rules for any accompanying CREATE INDEX ON <operational table>", async () => {
  freshScratch();
  fixture = await seedFakeLiveDb();

  // DROP INDEX alone is legitimately table-free (allowed), but a paired CREATE INDEX ... ON <table>
  // targeting an operational table must still be rejected - proving the CREATE INDEX...ON extraction
  // pattern (added by this fix) is enforced, not just DROP INDEX's allowlisting.
  const targetFile = join(stagingDir, "02_staging_tire_part_numbers.sql");
  const original = readFileSync(targetFile, "utf8");
  writeFileSync(
    targetFile,
    original + "\nDROP INDEX IF EXISTS sabotage_idx;\nCREATE INDEX sabotage_idx ON retail(barcode);\n",
    "utf8"
  );

  runCli(["backup"], { PROMOTE_CONFIRM: "YES" });
  const stageRes = runCli(["stage"], { PROMOTE_CONFIRM: "YES" });
  assert.notEqual(stageRes.code, 0, "stage must refuse when a staging file creates an index on an operational table");
  assert.match(stageRes.stderr, /REFUSING to execute/);
  assert.match(stageRes.stderr, /"retail"/);

  cleanupScratch();
});
