#!/usr/bin/env node
// Task B1: Enrichment bakeoff sample builder.
//
// Purpose: build a 30-row sample of tires with blank fields (10 blank-brand,
// 10 blank-mpn, 10 blank-size) for the enrichment-lane bakeoff, plus a
// separate answer key holding hidden-truth values recovered from
// pre-canonical / boss-derived data where available.
//
// Read-only sources (NEVER written to):
//   - repair-2026-07-28/REPAIRED_TIRE_DATABASE.db (working copy of the rich
//     DB; identical blanks to the packaged 02_ENRICHMENT_STAGE_2_rich.db -
//     used per global-constraints.md "Working DB" convention)
//   - backups/claude-tire-db-handoff-2026-07-28/02_ENRICHMENT_STAGE_2_rich.db (packaged, verified via SHA-256)
//   - backups/claude-tire-db-handoff-2026-07-28/01_PROCESS_MERGED_pre_canonical.db (packaged, pre-canonical hidden-truth candidates)
//
// Outputs:
//   - backups/claude-tire-db-handoff-2026-07-28/repair-2026-07-28/bakeoff/sample.json
//   - backups/claude-tire-db-handoff-2026-07-28/repair-2026-07-28/bakeoff/answer_key.json
//
// How hidden-truth rows were selected (deterministic, no randomness):
//
//   1. blank-brand and blank-size: `tires` rows with a blank field are
//      joined to `canonical_tire_products` on `tires.canonical_product_uid =
//      canonical_tire_products.canonical_product_id`. When the canonical
//      product row has a non-blank value for the same field, that value is
//      hidden truth (the canonical row is the merged/deduplicated identity
//      record for that product; this is a same-identity join, not a fuzzy
//      match). This produced 239 candidate barcodes for BOTH brand and size
//      blanks in the current corpus (fully overlapping barcode sets).
//
//      Investigated but NOT usable for brand/size: the boss workbook
//      (03_BOSS_SOURCE_BARCODES.xlsx). Sheet1 provides brand+size text but
//      its barcodes (~2,776, mostly Blackhawk/Nexen/Arisun/Fortune/Falken
//      distributor codes) do not overlap the barcodes that are blank in
//      `tires` for brand/size (checked exact match and zero-padded/GTIN-length
//      normalization - zero hits both ways). Sheet2 has no brand/size text
//      columns populated. So boss data is not a source for THIS category on
//      THIS corpus snapshot; canonical_tire_products is the only real
//      recoverable source found.
//
//   2. blank-mpn: `tires` rows with a blank manufacturer_part_number are
//      joined to `remaining_blank_fill_audit` (in the rich DB) on barcode.
//      The only action that still matches a currently-blank row is
//      `propose_part_number_from_brand_size_specs_only` (trust_color=red,
//      confidence_score=42) - all of this audit's GREEN,
//      high-confidence fills (`fill_part_number_from_exact_tire_identity`,
//      954 rows) and the pre-canonical DB's `process_merge_audit` green
//      fills were already applied to `tires.manufacturer_part_number` in
//      this snapshot, so none of those barcodes are still blank (verified:
//      0 rows). The red/weak proposal is the only hidden-truth-shaped value
//      still attached to a blank row, so it is used for the answer key but
//      is explicitly labeled `confidence: "weak"` (candidate_count 1,
//      confidence_score 42, method: brand/size/load/speed match without an
//      exact model match) so a lane result that reproduces it is not
//      mistaken for a certified match. This is intentional: the bakeoff
//      should test whether lanes independently reach an answer, not whether
//      they parrot a low-confidence internal proposal.
//
//   3. "Genuinely unknown" rows for all three categories are rows with the
//      target field blank AND no match in any of the above sources. They are
//      selected as the lowest N barcodes (stable string sort) among the
//      no-match set, per category, after excluding barcodes already chosen
//      for the hidden-truth half. Plain ascending sort by barcode is the
//      deterministic order (no LIMIT-without-ORDER-BY, no random seed).
//
//   4. Within each category, the hidden-truth subset takes the first 5
//      barcodes (ascending sort) from the recoverable set, and the
//      genuinely-unknown subset takes the first 5 barcodes (ascending sort)
//      from the no-match set. Deterministic, reproducible, no `LIMIT 1`
//      ambiguity resolution (each category's candidate pool is filtered to
//      an unambiguous single value before sorting).
//
// Row shape (sample.json): { id, barcode, known_fields, missing_fields }
//   - known_fields: the non-blank tires columns relevant to identifying the
//     product (brand, model, size, load_index, speed_rating, load_range,
//     type, season, manufacturer_part_number, barcode_type), EXCLUDING any
//     field that is itself in missing_fields for that row.
//   - missing_fields: array with exactly one of "brand" | "manufacturer_part_number" | "size"
//     (the category this row was drawn for). A row can have other blank
//     fields too (e.g. also blank season) - those are simply omitted from
//     known_fields, not added to missing_fields, since missing_fields marks
//     the field the bakeoff lane is being tested on.
//
// Row shape (answer_key.json): { id, barcode, category, has_hidden_truth,
//   truth: { field: value } | null, source, confidence }

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');

const PACKAGE_DIR = path.join(repoRoot, 'backups', 'claude-tire-db-handoff-2026-07-28');
const OUT_DIR = path.join(PACKAGE_DIR, 'repair-2026-07-28', 'bakeoff');

const WORKING_DB_PATH = path.join(PACKAGE_DIR, 'repair-2026-07-28', 'REPAIRED_TIRE_DATABASE.db');
const RICH_DB_PATH = path.join(PACKAGE_DIR, '02_ENRICHMENT_STAGE_2_rich.db');
const PRECANON_DB_PATH = path.join(PACKAGE_DIR, '01_PROCESS_MERGED_pre_canonical.db');

const PER_CATEGORY = 10;
const HIDDEN_TRUTH_PER_CATEGORY = 5; // ~half

const KNOWN_FIELD_COLUMNS = [
  'brand',
  'model',
  'size',
  'load_index',
  'speed_rating',
  'load_range',
  'type',
  'season',
  'manufacturer_part_number',
  'barcode_type',
];

function isBlank(v) {
  return v === null || v === undefined || String(v).trim() === '';
}

function openReadonly(dbPath) {
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

function buildKnownFields(row, targetField) {
  const known = {};
  for (const col of KNOWN_FIELD_COLUMNS) {
    if (col === targetField) continue;
    const val = row[col];
    if (!isBlank(val)) known[col] = val;
  }
  return known;
}

function main() {
  // Prefer the working DB (per global-constraints.md); fall back to the
  // packaged rich DB directly if the working copy has not been created yet
  // by task A1. Both currently contain identical `tires` blanks (the working
  // copy is a straight file copy at this stage of the plan).
  const useWorkingDb = fsExists(WORKING_DB_PATH);
  const dbPath = useWorkingDb ? WORKING_DB_PATH : RICH_DB_PATH;
  console.log(`Reading tires from: ${dbPath} (working copy used: ${useWorkingDb})`);

  const db = openReadonly(dbPath);
  db.exec(`ATTACH DATABASE '${sqlEscape(PRECANON_DB_PATH)}' AS precanon`);
  // Only attach the rich DB separately if we are reading from the working
  // copy, so remaining_blank_fill_audit / canonical_tire_products are always
  // available even if the working DB's own copies of those tables differ in
  // the future repair phases.
  if (useWorkingDb) {
    db.exec(`ATTACH DATABASE '${sqlEscape(RICH_DB_PATH)}' AS richpkg`);
  }
  const richAlias = useWorkingDb ? 'richpkg' : 'main';

  const sample = [];
  const answerKey = [];
  let nextId = 1;

  // ---- Category: blank-brand ----
  {
    const recoverable = db
      .prepare(
        `SELECT t.barcode AS barcode, t.brand, t.model, t.size, t.load_index, t.speed_rating,
                t.load_range, t.type, t.season, t.manufacturer_part_number, t.barcode_type,
                c.brand AS truth_brand
         FROM tires t
         JOIN ${richAlias}.canonical_tire_products c ON c.canonical_product_id = t.canonical_product_uid
         WHERE (t.brand IS NULL OR trim(t.brand) = '')
           AND c.brand IS NOT NULL AND trim(c.brand) <> ''
         ORDER BY t.barcode ASC`
      )
      .all();

    const recoverableBarcodes = new Set(recoverable.map((r) => r.barcode));

    const noMatch = db
      .prepare(
        `SELECT t.barcode AS barcode, t.brand, t.model, t.size, t.load_index, t.speed_rating,
                t.load_range, t.type, t.season, t.manufacturer_part_number, t.barcode_type
         FROM tires t
         WHERE (t.brand IS NULL OR trim(t.brand) = '')
         ORDER BY t.barcode ASC`
      )
      .all()
      .filter((r) => !recoverableBarcodes.has(r.barcode));

    addCategory({
      category: 'brand',
      recoverable: recoverable.slice(0, HIDDEN_TRUTH_PER_CATEGORY),
      unknown: noMatch.slice(0, PER_CATEGORY - HIDDEN_TRUTH_PER_CATEGORY),
      truthField: 'brand',
      truthValueKey: 'truth_brand',
      source: 'canonical_tire_products (same canonical_product_uid identity join)',
      confidence: 'strong',
    });
  }

  // ---- Category: blank-size ----
  {
    const recoverable = db
      .prepare(
        `SELECT t.barcode AS barcode, t.brand, t.model, t.size, t.load_index, t.speed_rating,
                t.load_range, t.type, t.season, t.manufacturer_part_number, t.barcode_type,
                c.size AS truth_size
         FROM tires t
         JOIN ${richAlias}.canonical_tire_products c ON c.canonical_product_id = t.canonical_product_uid
         WHERE (t.size IS NULL OR trim(t.size) = '')
           AND c.size IS NOT NULL AND trim(c.size) <> ''
         ORDER BY t.barcode ASC`
      )
      .all();

    const recoverableBarcodes = new Set(recoverable.map((r) => r.barcode));

    const noMatch = db
      .prepare(
        `SELECT t.barcode AS barcode, t.brand, t.model, t.size, t.load_index, t.speed_rating,
                t.load_range, t.type, t.season, t.manufacturer_part_number, t.barcode_type
         FROM tires t
         WHERE (t.size IS NULL OR trim(t.size) = '')
         ORDER BY t.barcode ASC`
      )
      .all()
      .filter((r) => !recoverableBarcodes.has(r.barcode));

    addCategory({
      category: 'size',
      recoverable: recoverable.slice(0, HIDDEN_TRUTH_PER_CATEGORY),
      unknown: noMatch.slice(0, PER_CATEGORY - HIDDEN_TRUTH_PER_CATEGORY),
      truthField: 'size',
      truthValueKey: 'truth_size',
      source: 'canonical_tire_products (same canonical_product_uid identity join)',
      confidence: 'strong',
    });
  }

  // ---- Category: blank-mpn ----
  {
    const recoverable = db
      .prepare(
        `SELECT t.barcode AS barcode, t.brand, t.model, t.size, t.load_index, t.speed_rating,
                t.load_range, t.type, t.season, t.manufacturer_part_number, t.barcode_type,
                a.new_value AS truth_mpn, a.confidence_score AS truth_confidence_score,
                a.reason AS truth_reason
         FROM tires t
         JOIN ${richAlias}.remaining_blank_fill_audit a ON a.barcode = t.barcode
         WHERE (t.manufacturer_part_number IS NULL OR trim(t.manufacturer_part_number) = '')
           AND a.action = 'propose_part_number_from_brand_size_specs_only'
           AND a.candidate_count = 1
           AND a.new_value IS NOT NULL AND trim(a.new_value) <> ''
         ORDER BY t.barcode ASC`
      )
      .all();

    const recoverableBarcodes = new Set(recoverable.map((r) => r.barcode));

    const noMatch = db
      .prepare(
        `SELECT t.barcode AS barcode, t.brand, t.model, t.size, t.load_index, t.speed_rating,
                t.load_range, t.type, t.season, t.manufacturer_part_number, t.barcode_type
         FROM tires t
         WHERE (t.manufacturer_part_number IS NULL OR trim(t.manufacturer_part_number) = '')
         ORDER BY t.barcode ASC`
      )
      .all()
      .filter((r) => !recoverableBarcodes.has(r.barcode));

    addCategory({
      category: 'manufacturer_part_number',
      recoverable: recoverable.slice(0, HIDDEN_TRUTH_PER_CATEGORY),
      unknown: noMatch.slice(0, PER_CATEGORY - HIDDEN_TRUTH_PER_CATEGORY),
      truthField: 'manufacturer_part_number',
      truthValueKey: 'truth_mpn',
      source: 'remaining_blank_fill_audit action=propose_part_number_from_brand_size_specs_only (weak: brand/size/load/speed match, no exact model match)',
      confidence: 'weak',
    });
  }

  function addCategory({ category, recoverable, unknown, truthField, truthValueKey, source, confidence }) {
    for (const row of recoverable) {
      const id = `B1-${String(nextId).padStart(3, '0')}`;
      nextId += 1;
      sample.push({
        id,
        barcode: row.barcode,
        known_fields: buildKnownFields(row, truthField),
        missing_fields: [truthField],
      });
      answerKey.push({
        id,
        barcode: row.barcode,
        category,
        has_hidden_truth: true,
        truth: { [truthField]: row[truthValueKey] },
        source,
        confidence,
      });
    }
    for (const row of unknown) {
      const id = `B1-${String(nextId).padStart(3, '0')}`;
      nextId += 1;
      sample.push({
        id,
        barcode: row.barcode,
        known_fields: buildKnownFields(row, truthField),
        missing_fields: [truthField],
      });
      answerKey.push({
        id,
        barcode: row.barcode,
        category,
        has_hidden_truth: false,
        truth: null,
        source: null,
        confidence: null,
      });
    }
  }

  db.close();

  if (sample.length !== 30) {
    throw new Error(`Expected 30 sample rows, got ${sample.length}`);
  }

  writeJson(path.join(OUT_DIR, 'sample.json'), sample);
  writeJson(path.join(OUT_DIR, 'answer_key.json'), answerKey);

  const withTruth = answerKey.filter((r) => r.has_hidden_truth).length;
  console.log(`Wrote ${sample.length} sample rows (${withTruth} with hidden truth, ${sample.length - withTruth} genuinely unknown) to:`);
  console.log(`  ${path.join(OUT_DIR, 'sample.json')}`);
  console.log(`  ${path.join(OUT_DIR, 'answer_key.json')}`);
}

function fsExists(p) {
  return fs.existsSync(p);
}

function sqlEscape(p) {
  return p.replace(/'/g, "''").replace(/\\/g, '/');
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

main();
