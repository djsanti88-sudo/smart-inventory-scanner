#!/usr/bin/env node
// Smoke + behavior tests for apply_pn_picks.mjs (node --test). Uses a tiny in-temp fixture DB and
// CSV; never touches the packaged deliverable or live Turso.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsv, loadPickSheet, planPicks, applyPicks } from "./apply_pn_picks.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const require = createRequire(path.join(REPO_ROOT, "package.json"));
const Database = require("better-sqlite3");
const SCRIPT = path.join(__dirname, "apply_pn_picks.mjs");

const HEADER = "part_number_key,old_uid,candidate,brand,model,size,load_speed,barcode,PICK (mark X)";

function makeDb(dbPath) {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE tire_part_numbers (normalized_part_number TEXT PRIMARY KEY, canonical_product_uid TEXT);
    CREATE TABLE tire_part_numbers_quarantine (
      normalized_part_number TEXT PRIMARY KEY, canonical_product_uid TEXT,
      quarantine_reason TEXT, quarantined_at TEXT);
    CREATE TABLE stage2_enrichment_audit (
      audit_id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT, trust_color TEXT,
      confidence_score INTEGER, barcode TEXT, canonical_product_id TEXT, part_number TEXT,
      reason TEXT, created_at TEXT);
    CREATE TABLE provenance (
      id INTEGER PRIMARY KEY AUTOINCREMENT, product_id TEXT, barcode TEXT, source_name TEXT,
      source_ref TEXT, sheet TEXT, row TEXT, batch_id TEXT, imported_at TEXT, evidence_level TEXT,
      license_note TEXT, content_hash TEXT,
      UNIQUE(product_id, barcode, source_name, source_ref));
  `);
  db.prepare(
    `INSERT INTO tire_part_numbers_quarantine (normalized_part_number, canonical_product_uid, quarantine_reason, quarantined_at)
     VALUES (?, ?, ?, ?)`
  ).run("221010345", "TIRE_59E7C1EBA56CDCD7DFFE", "conflict", "2026-07-28");
  return db;
}

function run(args, cwd = REPO_ROOT) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8" });
}

// --- Pure-function unit tests -----------------------------------------------------------------

test("parseCsv handles quoted fields and plain rows", () => {
  const text = `a,b,c\n1,2,3\n"has, comma",plain,"quo""te"`;
  const rows = parseCsv(text);
  assert.deepEqual(rows[0], ["a", "b", "c"]);
  assert.deepEqual(rows[1], ["1", "2", "3"]);
  assert.deepEqual(rows[2], ["has, comma", "plain", 'quo"te']);
});

test("loadPickSheet groups rows by part_number_key and marks picked rows", () => {
  const csv = [
    HEADER,
    "221010345,old1,CAND_A,,,,,000221010345,",
    "221010345,old1,CAND_B,atlas,Force HP,245/50R20,102V,8859291422662,X",
  ].join("\n");
  const { rowsByKey } = loadPickSheet(csv);
  assert.equal(rowsByKey.size, 1);
  const rows = rowsByKey.get("221010345");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].picked, false);
  assert.equal(rows[1].picked, true);
  assert.equal(rows[1].candidate, "CAND_B");
});

test("loadPickSheet throws on a missing required column", () => {
  assert.throws(() => loadPickSheet("a,b,c\n1,2,3"), /missing required column/);
});

test("planPicks: exactly one X is applicable; zero or two+ are skipped", () => {
  const csv = [
    HEADER,
    "KEY_ZERO,old,CAND_1,,,,,000000000001,",
    "KEY_ZERO,old,CAND_2,,,,,000000000002,",
    "KEY_ONE,old,CAND_3,,,,,000000000003,",
    "KEY_ONE,old,CAND_4,,,,,000000000004,X",
    "KEY_TWO,old,CAND_5,,,,,000000000005,X",
    "KEY_TWO,old,CAND_6,,,,,000000000006,X",
  ].join("\n");
  const { rowsByKey } = loadPickSheet(csv);
  const plan = planPicks(rowsByKey);
  assert.deepEqual(plan.skippedZero, ["KEY_ZERO"]);
  assert.deepEqual(plan.skippedMultiple, ["KEY_TWO"]);
  assert.equal(plan.applicable.length, 1);
  assert.equal(plan.applicable[0].key, "KEY_ONE");
  assert.equal(plan.applicable[0].candidate, "CAND_4");
});

// --- DB-level behavior tests -------------------------------------------------------------------

test("applyPicks moves a single-picked key from quarantine to active, with audit + provenance", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pnpick-apply-"));
  const dbPath = path.join(dir, "f.db");
  const db = makeDb(dbPath);
  try {
    const result = applyPicks(db, [{ key: "221010345", candidate: "TIRE_74ED02FBF98CA470F553", row: { barcode: "8859291422662", old_uid: "old1" } }]);
    assert.equal(result.applied.length, 1);

    const quarantineRow = db.prepare("SELECT * FROM tire_part_numbers_quarantine WHERE normalized_part_number = ?").get("221010345");
    assert.equal(quarantineRow, undefined, "key must be removed from quarantine");

    const activeRow = db.prepare("SELECT * FROM tire_part_numbers WHERE normalized_part_number = ?").get("221010345");
    assert.ok(activeRow, "key must now exist in active tire_part_numbers");
    assert.equal(activeRow.canonical_product_uid, "TIRE_74ED02FBF98CA470F553");

    const auditRow = db.prepare("SELECT * FROM stage2_enrichment_audit WHERE part_number = ?").get("221010345");
    assert.ok(auditRow, "audit row must exist");
    assert.equal(auditRow.action, "owner_pick_conflict_resolution");
    assert.equal(auditRow.trust_color, "green");

    const provRow = db.prepare("SELECT * FROM provenance WHERE source_ref = ?").get("221010345");
    assert.ok(provRow, "provenance row must exist");
    assert.equal(provRow.source_name, "owner_decision");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applyPicks is idempotent: re-applying the same pick against an already-applied DB is a safe no-op", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pnpick-idem-"));
  const dbPath = path.join(dir, "f.db");
  const db = makeDb(dbPath);
  try {
    const pick = [{ key: "221010345", candidate: "TIRE_74ED02FBF98CA470F553", row: { barcode: "8859291422662", old_uid: "old1" } }];
    const first = applyPicks(db, pick);
    assert.equal(first.applied.length, 1);

    const second = applyPicks(db, pick);
    assert.equal(second.applied.length, 0, "second run must not re-apply");
    assert.equal(second.alreadyApplied.length, 1, "second run reports already-applied");

    const activeRows = db.prepare("SELECT * FROM tire_part_numbers WHERE normalized_part_number = ?").all("221010345");
    assert.equal(activeRows.length, 1, "no duplicate active row");

    const auditRows = db.prepare("SELECT * FROM stage2_enrichment_audit WHERE part_number = ?").all("221010345");
    assert.equal(auditRows.length, 1, "no duplicate audit row on re-run");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applyPicks reports notQuarantined for a key absent from quarantine and not already applied", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pnpick-notq-"));
  const dbPath = path.join(dir, "f.db");
  const db = makeDb(dbPath);
  try {
    const result = applyPicks(db, [{ key: "DOES_NOT_EXIST", candidate: "TIRE_X", row: { barcode: "0", old_uid: "x" } }]);
    assert.equal(result.applied.length, 0);
    assert.equal(result.notQuarantined.length, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applyPicks --dry-run mode plans without writing", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pnpick-dryrun-"));
  const dbPath = path.join(dir, "f.db");
  const db = makeDb(dbPath);
  try {
    const result = applyPicks(db, [{ key: "221010345", candidate: "TIRE_74ED02FBF98CA470F553", row: { barcode: "8859291422662", old_uid: "old1" } }], { dryRun: true });
    assert.equal(result.applied.length, 1);
    assert.equal(result.applied[0].dryRun, true);

    const quarantineRow = db.prepare("SELECT * FROM tire_part_numbers_quarantine WHERE normalized_part_number = ?").get("221010345");
    assert.ok(quarantineRow, "dry-run must not remove the quarantine row");
    const activeRow = db.prepare("SELECT * FROM tire_part_numbers WHERE normalized_part_number = ?").get("221010345");
    assert.equal(activeRow, undefined, "dry-run must not write the active row");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- CLI-level tests (spawns the real script) ---------------------------------------------------

test("CLI requires --db and --csv", () => {
  let r = run([]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--db .* is REQUIRED/);

  r = run(["--db", "somefile.db"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--csv .* is REQUIRED/);
});

test("CLI errors on missing DB or CSV file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pnpick-cli-missing-"));
  const csvPath = path.join(dir, "sheet.csv");
  writeFileSync(csvPath, HEADER + "\n");
  try {
    let r = run(["--db", path.join(dir, "nope.db"), "--csv", csvPath]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /working DB not found/);

    const dbPath = path.join(dir, "f.db");
    makeDb(dbPath).close();
    r = run(["--db", dbPath, "--csv", path.join(dir, "nope.csv")]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /pick sheet CSV not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI end-to-end: applies exactly-one-X rows, skips zero/multiple, reports a summary", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pnpick-cli-e2e-"));
  const dbPath = path.join(dir, "f.db");
  const csvPath = path.join(dir, "sheet.csv");
  const db = makeDb(dbPath);
  // Add a second quarantine row for a "zero picks" key so we can prove it's skipped.
  db.prepare(
    `INSERT INTO tire_part_numbers_quarantine (normalized_part_number, canonical_product_uid, quarantine_reason, quarantined_at)
     VALUES (?, ?, ?, ?)`
  ).run("99999999", "TIRE_ZERO_PICK", "conflict", "2026-07-28");
  db.close();

  const csv = [
    HEADER,
    "221010345,old1,CAND_A,,,,,000221010345,",
    "221010345,old1,TIRE_74ED02FBF98CA470F553,atlas,Force HP,245/50R20,102V,8859291422662,X",
    "99999999,old2,CAND_X,,,,,000099999999,",
    "99999999,old2,CAND_Y,,,,,000099999998,",
  ].join("\n");
  writeFileSync(csvPath, csv);

  try {
    const r = run(["--db", dbPath, "--csv", csvPath]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /99999999.*ZERO picks/s);

    const summary = JSON.parse(r.stdout);
    assert.equal(summary.applied, 1);
    assert.equal(summary.skippedZeroPicks, 1);

    const verifyDb = new Database(dbPath, { readonly: true });
    const active = verifyDb.prepare("SELECT * FROM tire_part_numbers WHERE normalized_part_number = ?").get("221010345");
    assert.ok(active);
    assert.equal(active.canonical_product_uid, "TIRE_74ED02FBF98CA470F553");
    const stillQuarantined = verifyDb.prepare("SELECT * FROM tire_part_numbers_quarantine WHERE normalized_part_number = ?").get("99999999");
    assert.ok(stillQuarantined, "zero-pick key must remain in quarantine");
    verifyDb.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
