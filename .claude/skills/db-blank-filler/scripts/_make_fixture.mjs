#!/usr/bin/env node
// Builds a tiny fixture tire DB for the smoke tests. Deterministic; safe to overwrite.
// Usage: node _make_fixture.mjs <outPath>
import { createRequire } from "node:module";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const require = createRequire(path.join(REPO_ROOT, "package.json"));
const Database = require("better-sqlite3");

export function makeFixture(outPath) {
  if (existsSync(outPath)) rmSync(outPath);
  const db = new Database(outPath);
  db.exec(`
    CREATE TABLE tires (
      barcode TEXT, canonical_product_uid TEXT, brand TEXT, brand_normalized TEXT, model TEXT,
      model_normalized TEXT, size TEXT, raw_size_text TEXT, load_index TEXT, speed_rating TEXT,
      load_range TEXT, type TEXT, season TEXT, manufacturer_part_number TEXT, barcode_type TEXT,
      confidence TEXT, current_status TEXT, usable_for TEXT, field_completeness_score TEXT,
      missing_fields TEXT, source_count INTEGER, model_display TEXT);
    CREATE TABLE tire_barcode_aliases (
      barcode TEXT PRIMARY KEY, barcode_type TEXT, canonical_product_id TEXT, source_table TEXT,
      alias_confidence INTEGER);
    CREATE TABLE tire_part_numbers (normalized_part_number TEXT, canonical_product_uid TEXT);
    CREATE TABLE provenance (
      id INTEGER PRIMARY KEY AUTOINCREMENT, product_id TEXT, barcode TEXT, source_name TEXT,
      source_ref TEXT, sheet TEXT, row TEXT, batch_id TEXT, imported_at TEXT, evidence_level TEXT,
      license_note TEXT, content_hash TEXT,
      UNIQUE(product_id, barcode, source_name, source_ref));
    CREATE TABLE remaining_blank_fill_audit (
      audit_id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT, trust_color TEXT,
      confidence_score INTEGER, canonical_product_uid TEXT, barcode TEXT, previous_value TEXT,
      new_value TEXT, candidate_count INTEGER, candidate_values TEXT, reason TEXT,
      created_at TEXT DEFAULT (datetime('now')));
  `);

  const insTire = db.prepare(
    `INSERT INTO tires (barcode, canonical_product_uid, brand, model, size, barcode_type, source_count)
     VALUES (?, ?, ?, ?, ?, ?, 0)`
  );
  const insAlias = db.prepare(
    `INSERT INTO tire_barcode_aliases (barcode, barcode_type, canonical_product_id, source_table, alias_confidence)
     VALUES (?, ?, ?, ?, ?)`
  );

  // Row 1: leading-zero EAN-13 that NEEDS a UPC-A twin (direction A).
  insTire.run("0012345678905", "UID-A", "Nexen", "Roadian", "265/70R17", "ean");
  insAlias.run("0012345678905", "ean", "UID-A", "source_ean", 100);
  // Row 2: 12-digit UPC-A that NEEDS an EAN-13 twin (direction B).
  insTire.run("036731100016", "UID-B", "Falken", "Wildpeak", "285/75R16", "upc");
  insAlias.run("036731100016", "upc", "UID-B", "source_upc", 100);
  // Row 3: a pair that ALREADY has both forms (should be no-op / idempotent).
  insTire.run("0099999999999", "UID-C", "Fortune", "Perfectus", "225/65R17", "ean");
  insAlias.run("0099999999999", "ean", "UID-C", "source_ean", 100);
  insTire.run("099999999999", "UID-C", "Fortune", "Perfectus", "225/65R17", "upc");
  insAlias.run("099999999999", "upc", "UID-C", "twin", 100);

  db.close();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (!out) {
    console.error("usage: node _make_fixture.mjs <outPath>");
    process.exit(1);
  }
  makeFixture(out);
  console.log("fixture written:", out);
}
