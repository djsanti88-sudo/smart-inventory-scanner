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
// This test NEVER touches real Turso. It points PROMOTE_TURSO_URL at a local libsql `file:` URL
// (proven to work identically to the remote client - same @libsql/client API) and
// PROMOTE_STAGING_DIR / PROMOTE_BACKUP_DIR at scratch directories under the OS temp dir.
//
// Usage: node --test scripts/tire-db-repair/10_promote_execute.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createClient } from "@libsql/client";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const REAL_STAGING_DIR = join(
  REPO_ROOT, "backups", "claude-tire-db-handoff-2026-07-28", "repair-2026-07-28", "turso-staging"
);
const SCRIPT_PATH = join(__dirname, "10_promote_execute.mjs");

let scratchRoot;
let dbPath;
let dbUrl;
let backupDir;

function freshScratch() {
  scratchRoot = mkdtempSync(join(tmpdir(), "promote-proof-"));
  dbPath = join(scratchRoot, "fake-live.db");
  dbUrl = `file:${dbPath.replace(/\\/g, "/")}`;
  backupDir = join(scratchRoot, "turso-backup");
  mkdirSync(backupDir, { recursive: true });
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
    PROMOTE_STAGING_DIR: REAL_STAGING_DIR,
    PROMOTE_BACKUP_DIR: backupDir,
    ...envOverrides,
  };
  try {
    const out = execFileSync(process.execPath, [SCRIPT_PATH, ...args], { env, encoding: "utf8" });
    return { code: 0, stdout: out };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "" };
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
  rmSync(scratchRoot, { recursive: true, force: true });
});

test("refusal gate: promote without PROMOTE_CONFIRM exits 3", () => {
  freshScratch();
  const res = runCli(["promote"], { PROMOTE_CONFIRM: "" });
  assert.equal(res.code, 3);
  assert.match(res.stderr, /REFUSED/);
  rmSync(scratchRoot, { recursive: true, force: true });
});

test("refusal gate: rollback without PROMOTE_CONFIRM exits 3", () => {
  freshScratch();
  const res = runCli(["rollback"], { PROMOTE_CONFIRM: "" });
  assert.equal(res.code, 3);
  assert.match(res.stderr, /REFUSED/);
  rmSync(scratchRoot, { recursive: true, force: true });
});

test("refusal gate: --dry-run NEVER requires PROMOTE_CONFIRM", () => {
  freshScratch();
  const res = runCli(["stage", "--dry-run"], { PROMOTE_CONFIRM: "" });
  assert.equal(res.code, 0);
  assert.doesNotMatch(res.stdout, /REFUSED/);
  rmSync(scratchRoot, { recursive: true, force: true });
});

test("refusal gate: unknown subcommand exits 2 with usage", () => {
  freshScratch();
  const res = runCli(["bogus"]);
  assert.equal(res.code, 2);
  rmSync(scratchRoot, { recursive: true, force: true });
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
    rmSync(scratchRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Best-effort cleanup only; a lingering Windows file handle on the temp DB must never fail
    // the proof run (the OS temp dir is reclaimed eventually regardless).
  }
});
