// Task A4 fix round 1 (review finding I-2): the population script's most safety-critical branch -
// demoting an ambiguous alias candidate to a conflict record instead of writing it - had zero
// occurrences in the real dataset and therefore no execution proof. This test runs the REAL script
// (child process, real SQLite fixture db in a temp dir) against a genuinely ambiguous candidate
// spanning two products, and asserts it is demoted/recorded as a conflict and NOT written to the
// alias table, while an unambiguous candidate in the same run IS written.
//
// The script's custom-dbPath mode writes PART_NUMBER_CONFLICTS.csv next to the fixture db and skips
// the packaged-input hash guard, so this test never touches the real repair-2026-07-28 outputs.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "03_part_number_aliases.mjs");

let tempDir;
let dbPath;
let csvPath;
let scriptOutput;

function buildFixtureDb(path) {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE tires (
      barcode TEXT PRIMARY KEY,
      canonical_product_uid TEXT,
      manufacturer_part_number TEXT
    );
    CREATE TABLE tire_part_numbers (
      normalized_part_number TEXT PRIMARY KEY,
      canonical_product_uid TEXT
    );
    CREATE TABLE tire_product_part_number_aliases (
      canonical_product_id TEXT NOT NULL,
      normalized_part_number TEXT NOT NULL,
      display_part_number TEXT NOT NULL,
      source TEXT NOT NULL,
      trust_color TEXT NOT NULL,
      confidence_score INTEGER NOT NULL,
      is_unambiguous INTEGER NOT NULL,
      PRIMARY KEY (canonical_product_id, normalized_part_number)
    );
    CREATE TABLE process_merge_audit (
      audit_id INTEGER PRIMARY KEY,
      action TEXT,
      trust_color TEXT,
      confidence_score INTEGER,
      source_sheet TEXT,
      source_row INTEGER,
      part_number TEXT,
      barcode TEXT,
      raw_barcode TEXT,
      barcode_type TEXT,
      barcode_note TEXT,
      canonical_product_uid TEXT,
      previous_value TEXT,
      new_value TEXT,
      reason TEXT,
      created_at TEXT
    );
  `);

  const insertTire = db.prepare(
    "INSERT INTO tires (barcode, canonical_product_uid, manufacturer_part_number) VALUES (?, ?, ?)",
  );
  insertTire.run("1110000000001", "TIRE_FIXTURE_X", "111000");
  insertTire.run("2220000000002", "TIRE_FIXTURE_Y", "222000");
  insertTire.run("3330000000003", "TIRE_FIXTURE_Z", "333000");

  const insertAudit = db.prepare(`
    INSERT INTO process_merge_audit (action, trust_color, confidence_score, part_number, barcode, previous_value, new_value)
    VALUES ('part_number_value_conflict', 'green', 100, @part_number, @barcode, @previous_value, @new_value)
  `);
  // GENUINELY AMBIGUOUS candidate: two different products (X and Y) each claim a boss variant that
  // normalizes to the SAME key ("ZZAMBIG555555") - the demotion branch MUST fire for both, and the
  // key must never reach the alias table.
  insertAudit.run({ part_number: "ZZAMBIG555555", barcode: "1110000000001", previous_value: "111000", new_value: "ZZAMBIG555555" });
  insertAudit.run({ part_number: "ZZ-AMBIG555555", barcode: "2220000000002", previous_value: "222000", new_value: "ZZ-AMBIG555555" });
  // UNAMBIGUOUS control candidate in the same run: a plain distributor-affix alias for product Z.
  insertAudit.run({ part_number: "BH333000", barcode: "3330000000003", previous_value: "333000", new_value: "BH333000" });

  db.close();
}

before(() => {
  tempDir = mkdtempSync(join(tmpdir(), "a4-alias-fixture-"));
  dbPath = join(tempDir, "fixture.db");
  csvPath = join(tempDir, "PART_NUMBER_CONFLICTS.csv");
  buildFixtureDb(dbPath);
  scriptOutput = execFileSync(process.execPath, [SCRIPT, dbPath], { encoding: "utf8" });
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("03_part_number_aliases.mjs - ambiguous-candidate demotion branch (fixture run)", () => {
  test("exits 0 with all gates passed (execFileSync throws on nonzero exit)", () => {
    assert.ok(scriptOutput.includes("All gates passed."));
  });

  test("demotes BOTH sides of the ambiguous candidate: reported in the summary, key NOT in the alias table", () => {
    assert.ok(scriptOutput.includes("demoted to conflict (ambiguous across candidates+existing data): 2"));

    const db = new Database(dbPath, { readonly: true });
    const ambiguousRows = db
      .prepare("SELECT * FROM tire_product_part_number_aliases WHERE normalized_part_number = ?")
      .all("ZZAMBIG555555");
    db.close();
    assert.equal(ambiguousRows.length, 0);
  });

  test("records the demotion as a 'true conflict' row in the CSV written next to the fixture db", () => {
    assert.equal(existsSync(csvPath), true);
    const csv = readFileSync(csvPath, "utf8");
    const demotionLines = csv
      .split("\n")
      .filter((line) => line.includes("true conflict") && line.includes("demoted from alias to conflict"));
    assert.equal(demotionLines.length, 2); // one conflict record per demoted candidate product
    assert.ok(demotionLines.some((l) => l.includes("TIRE_FIXTURE_X")));
    assert.ok(demotionLines.some((l) => l.includes("TIRE_FIXTURE_Y")));
  });

  test("still writes the UNAMBIGUOUS candidate from the same run (demotion is per-key, not per-run)", () => {
    const db = new Database(dbPath, { readonly: true });
    const rows = db
      .prepare("SELECT * FROM tire_product_part_number_aliases WHERE normalized_part_number = ?")
      .all("BH333000");
    db.close();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].canonical_product_id, "TIRE_FIXTURE_Z");
    assert.equal(rows[0].is_unambiguous, 1);
  });

  test("fixture run never touches the real repair outputs (CSV lands in the temp dir, hash guard skipped)", () => {
    assert.ok(scriptOutput.includes("Custom dbPath given (fixture/test run)"));
    assert.ok(scriptOutput.includes(csvPath));
  });
});
