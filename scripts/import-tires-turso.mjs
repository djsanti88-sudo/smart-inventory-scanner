// One-time (idempotent, re-runnable) import of the tire corpus into Turso.
// Source: src/server/tire-knowledge/tireKnowledge.generated.json
//   barcodeIndex:      Record<normBarcodeKey(barcode), TireKnowledgeRow>
//   partNumberIndex:   Record<normPartKey(manufacturer_part_number), canonical_product_uid>
//
// Creates (if not present):
//   tires             — one row per barcodeIndex entry, PK = barcode (already normBarcodeKey form)
//   tire_part_numbers — one row per partNumberIndex entry, PK = normalized_part_number (normPartKey form)
//
// Key convention (verified against src/server/tire-knowledge/tireKnowledgeIndex.ts):
//   - normBarcodeKey(code) = code.replace(/[ -]/g, '').trim().replace(/[ -]/g, '')
//   - normPartKey(pn)      = pn.replace(/[ -]/g, '').trim().toUpperCase().replace(/\s/g, '')
//   The JSON's barcodeIndex/partNumberIndex keys are ALREADY in these normalized forms (spot-checked
//   sample keys against the normalizers before writing this script). We store rows keyed by those
//   same JSON keys directly (not re-derived from row.barcode) so the stored key is guaranteed to
//   match what the runtime lookup computes from a scanned code.
//
// Usage:
//   node scripts/import-tires-turso.mjs --dry-run   (count only, no writes)
//   node scripts/import-tires-turso.mjs             (real import, batched INSERT OR REPLACE)
//
// Does not touch retail, decode_cache, legacy provider, or decode_archive tables.

import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";

const DRY_RUN = process.argv.includes("--dry-run");
const BATCH_SIZE = 500;
const TIRE_JSON_PATH = "src/server/tire-knowledge/tireKnowledge.generated.json";

// minimal .env.local parse (no dep) — mirrors scripts/dt-harvest/state/turso-inspect.mjs
const env = {};
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const url = env.TURSO_DATABASE_URL;
const authToken = env.TURSO_AUTH_TOKEN;
if (!url) {
  console.error("NO TURSO_DATABASE_URL in .env.local");
  process.exit(1);
}
console.log("Turso URL host:", url.replace(/^libsql:\/\//, "").split(".")[0], "(rest hidden)");
console.log(DRY_RUN ? "Mode: DRY RUN (count only, no writes)" : "Mode: LIVE WRITE");

const TIRES_COLUMNS = [
  "barcode", "canonical_product_uid", "brand", "brand_normalized",
  "model", "model_normalized", "size", "raw_size_text",
  "load_index", "speed_rating", "load_range", "type", "season",
  "manufacturer_part_number", "barcode_type", "confidence",
  "current_status", "usable_for", "field_completeness_score",
  "missing_fields", "source_count",
];

const CREATE_TIRES_TABLE = `CREATE TABLE IF NOT EXISTS tires (
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
  source_count INTEGER
)`;

const CREATE_MPN_INDEX = `CREATE INDEX IF NOT EXISTS idx_tires_manufacturer_part_number ON tires (manufacturer_part_number)`;

const CREATE_PART_NUMBERS_TABLE = `CREATE TABLE IF NOT EXISTS tire_part_numbers (
  normalized_part_number TEXT PRIMARY KEY,
  canonical_product_uid TEXT
)`;

function readCorpus() {
  const raw = readFileSync(TIRE_JSON_PATH, "utf8");
  const parsed = JSON.parse(raw);
  return {
    barcodeIndex: parsed.barcodeIndex ?? {},
    partNumberIndex: parsed.partNumberIndex ?? {},
  };
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  const { barcodeIndex, partNumberIndex } = readCorpus();
  const barcodeKeys = Object.keys(barcodeIndex);
  const partNumberKeys = Object.keys(partNumberIndex);

  console.log(`\nCorpus source: ${TIRE_JSON_PATH}`);
  console.log(`  barcodeIndex entries:     ${barcodeKeys.length}`);
  console.log(`  partNumberIndex entries:  ${partNumberKeys.length}`);

  if (DRY_RUN) {
    console.log(`\nDRY RUN: would import ${barcodeKeys.length} tires rows + ${partNumberKeys.length} tire_part_numbers rows.`);
    console.log("No writes performed.");
    return;
  }

  const db = createClient({ url, authToken });

  console.log("\nCreating tables/indexes if not present...");
  await db.execute(CREATE_TIRES_TABLE);
  await db.execute(CREATE_MPN_INDEX);
  await db.execute(CREATE_PART_NUMBERS_TABLE);

  // --- Import tires (keyed by the JSON's barcodeIndex key = normBarcodeKey(row.barcode)) ---
  const placeholders = `(${TIRES_COLUMNS.map(() => "?").join(", ")})`;
  const insertSql = `INSERT OR REPLACE INTO tires (${TIRES_COLUMNS.join(", ")}) VALUES ${placeholders}`;

  console.log(`\nImporting ${barcodeKeys.length} tires rows in batches of ${BATCH_SIZE}...`);
  let imported = 0;
  for (const batchKeys of chunk(barcodeKeys, BATCH_SIZE)) {
    const statements = batchKeys.map((key) => {
      const row = barcodeIndex[key];
      const args = TIRES_COLUMNS.map((col) => {
        if (col === "barcode") return key; // stored key = JSON key = normBarcodeKey(row.barcode)
        if (col === "source_count") return Number(row.source_count ?? 0);
        const v = row[col];
        return v === undefined || v === null ? "" : String(v);
      });
      return { sql: insertSql, args };
    });
    await db.batch(statements, "write");
    imported += batchKeys.length;
    if (imported % 5000 === 0 || imported === barcodeKeys.length) {
      console.log(`  ...${imported}/${barcodeKeys.length} tires rows imported`);
    }
  }

  // --- Import tire_part_numbers (keyed by JSON's partNumberIndex key = normPartKey(mpn)) ---
  const pnInsertSql = `INSERT OR REPLACE INTO tire_part_numbers (normalized_part_number, canonical_product_uid) VALUES (?, ?)`;
  console.log(`\nImporting ${partNumberKeys.length} tire_part_numbers rows in batches of ${BATCH_SIZE}...`);
  let pnImported = 0;
  for (const batchKeys of chunk(partNumberKeys, BATCH_SIZE)) {
    const statements = batchKeys.map((key) => ({
      sql: pnInsertSql,
      args: [key, partNumberIndex[key]],
    }));
    await db.batch(statements, "write");
    pnImported += batchKeys.length;
    if (pnImported % 5000 === 0 || pnImported === partNumberKeys.length) {
      console.log(`  ...${pnImported}/${partNumberKeys.length} tire_part_numbers rows imported`);
    }
  }

  // --- Verify ---
  console.log("\nVerifying...");
  const tiresCount = await db.execute("SELECT count(*) AS n FROM tires");
  const pnCount = await db.execute("SELECT count(*) AS n FROM tire_part_numbers");
  console.log(`  tires row count:             ${tiresCount.rows[0].n} (expected ${barcodeKeys.length})`);
  console.log(`  tire_part_numbers row count: ${pnCount.rows[0].n} (expected ${partNumberKeys.length})`);

  const sample = await db.execute("SELECT * FROM tires LIMIT 5");
  console.log("\nSample rows (5):");
  for (const row of sample.rows) console.log("  ", JSON.stringify(row));

  const pnSample = await db.execute("SELECT * FROM tire_part_numbers LIMIT 5");
  console.log("\nSample tire_part_numbers rows (5):");
  for (const row of pnSample.rows) console.log("  ", JSON.stringify(row));

  await db.close?.();
  console.log("\nDone.");
}

main().catch((e) => {
  console.error("Import failed:", e);
  process.exit(1);
});
