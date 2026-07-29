#!/usr/bin/env node
// Task B6 - build the priority-ordered, deduped research queue and slice it into ~100-barcode
// batch input files (same blind row shape as the bakeoff: { id, barcode, known_fields,
// missing_fields }).
//
// Scope (owner-authorized): brand + size + model blank queues only. The 48,144-row MPN queue is
// OUT OF SCOPE tonight (see B6_ENRICHMENT_REPORT.md follow-up plan) and is NOT included in any
// batch file this script produces.
//
// Dedup: one research row per barcode covering ALL its missing fields at once (a barcode that is
// blank in both brand and size gets a single row with missing_fields: ["brand","size"], not two
// separate rows).
//
// Priority order (owner-authorized):
//   1. Rows whose GS1 prefix or existing known_* fields indicate one of the five boss brands
//      (nexen, arisun, blackhawk, fortune, falken) - checked via src/services/catalog/brandPrefixMap.json
//      and via any known_brand text match.
//   2. Rows with a valid (non-placeholder, correct check-digit where checkable) GTIN barcode.
//   3. Everything else (still non-placeholder).
//
// Placeholder barcodes are never included (already excluded by B5's remaining_blanks.json).
//
// Output: repair-2026-07-28/bakeoff/b6/batch_<N>_input.json, ~100 barcodes each, plus
// repair-2026-07-28/bakeoff/b6/queue_manifest.json recording the full priority-ordered barcode
// list and batch boundaries for resumability.

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

const REMAINING_BLANKS_PATH = path.join(
  REPO_ROOT,
  "backups/claude-tire-db-handoff-2026-07-28/repair-2026-07-28/bakeoff/remaining_blanks.json"
);
const PREFIX_MAP_PATH = path.join(REPO_ROOT, "src/services/catalog/brandPrefixMap.json");
const B6_DIR = path.join(REPO_ROOT, "backups/claude-tire-db-handoff-2026-07-28/repair-2026-07-28/bakeoff/b6");

const BOSS_BRANDS = ["nexen", "arisun", "blackhawk", "fortune", "falken"];
const BATCH_SIZE = Number(process.argv.find((a) => a.startsWith("--batch-size="))?.split("=")[1]) || 100;

function digitsOnly(s) {
  return String(s || "").replace(/\D/g, "");
}
function toGtin13(code) {
  return digitsOnly(code).padStart(13, "0").slice(-13);
}
function gs1Prefix7(code) {
  return toGtin13(code).slice(0, 7);
}

function main() {
  const remainingBlanks = JSON.parse(fs.readFileSync(REMAINING_BLANKS_PATH, "utf8"));
  const prefixMap = JSON.parse(fs.readFileSync(PREFIX_MAP_PATH, "utf8"));

  // Merge brand + size (fully overlapping barcode set per B5's report, but merge generically in
  // case that changes) into one row per barcode with a combined missing_fields array. Model is
  // not yet tracked in remaining_blanks.json (B5 only emitted brand/size/mpn); this script reads
  // whichever of brand/size/model keys exist in the file, MPN explicitly excluded.
  const fieldsInScope = ["brand", "size", "model"].filter((f) => remainingBlanks[f]);

  const byBarcode = new Map();
  for (const field of fieldsInScope) {
    for (const row of remainingBlanks[field].rows) {
      const existing = byBarcode.get(row.barcode) || {
        barcode: row.barcode,
        canonical_product_uid: row.canonical_product_uid,
        known_brand: row.known_brand,
        known_model: row.known_model,
        known_size: row.known_size,
        known_manufacturer_part_number: row.known_manufacturer_part_number,
        missing_fields: [],
      };
      if (!existing.missing_fields.includes(field)) existing.missing_fields.push(field);
      byBarcode.set(row.barcode, existing);
    }
  }

  const merged = [...byBarcode.values()];

  function isBossBrandRow(row) {
    const prefix7 = gs1Prefix7(row.barcode);
    const mappedBrand = (prefixMap[prefix7] || "").toLowerCase();
    if (BOSS_BRANDS.includes(mappedBrand)) return true;
    const knownBrandLower = String(row.known_brand || "").toLowerCase();
    return BOSS_BRANDS.some((b) => knownBrandLower.includes(b));
  }

  function isValidGtinShape(barcode) {
    // "Valid GTIN barcode" per the brief's priority tier 2: non-placeholder (already guaranteed
    // by remaining_blanks.json's exclusion) AND a plausible GTIN-8/12/13/14 length after
    // normalization (8, 12, 13, or 14 digits). Mod-10 check-digit verified when the length is a
    // standard GTIN length.
    const digits = digitsOnly(barcode);
    if (![8, 12, 13, 14].includes(digits.length)) return false;
    // GTIN mod-10 check digit (last digit) verification.
    const payload = digits.slice(0, -1);
    const checkDigit = Number(digits[digits.length - 1]);
    let sum = 0;
    // Weights alternate 3,1 from the rightmost payload digit.
    for (let i = 0; i < payload.length; i++) {
      const digit = Number(payload[payload.length - 1 - i]);
      sum += digit * (i % 2 === 0 ? 3 : 1);
    }
    const computedCheck = (10 - (sum % 10)) % 10;
    return computedCheck === checkDigit;
  }

  const bossRows = [];
  const validGtinRows = [];
  const restRows = [];
  for (const row of merged) {
    if (isBossBrandRow(row)) bossRows.push(row);
    else if (isValidGtinShape(row.barcode)) validGtinRows.push(row);
    else restRows.push(row);
  }

  // Stable deterministic ordering within each tier (ascending barcode - no LIMIT-without-ORDER-BY
  // ambiguity, no randomness).
  const byBarcodeAsc = (a, b) => (a.barcode < b.barcode ? -1 : a.barcode > b.barcode ? 1 : 0);
  bossRows.sort(byBarcodeAsc);
  validGtinRows.sort(byBarcodeAsc);
  restRows.sort(byBarcodeAsc);

  const priorityOrdered = [...bossRows, ...validGtinRows, ...restRows];

  fs.mkdirSync(B6_DIR, { recursive: true });

  const batches = [];
  let nextId = 1;
  for (let i = 0; i < priorityOrdered.length; i += BATCH_SIZE) {
    const slice = priorityOrdered.slice(i, i + BATCH_SIZE);
    const batchNum = batches.length + 1;
    const batchInput = slice.map((row) => {
      const id = `B6-${String(nextId).padStart(5, "0")}`;
      nextId += 1;
      const known_fields = {};
      if (row.known_brand) known_fields.brand = row.known_brand;
      if (row.known_model) known_fields.model = row.known_model;
      if (row.known_size) known_fields.size = row.known_size;
      if (row.known_manufacturer_part_number) {
        known_fields.manufacturer_part_number = row.known_manufacturer_part_number;
      }
      return { id, barcode: row.barcode, known_fields, missing_fields: row.missing_fields };
    });
    const batchPath = path.join(B6_DIR, `batch_${batchNum}_input.json`);
    fs.writeFileSync(batchPath, JSON.stringify(batchInput, null, 2) + "\n", "utf8");
    batches.push({
      batchNum,
      path: path.relative(REPO_ROOT, batchPath),
      rowCount: batchInput.length,
      firstId: batchInput[0]?.id,
      lastId: batchInput[batchInput.length - 1]?.id,
    });
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    totalRows: priorityOrdered.length,
    bossBrandRows: bossRows.length,
    validGtinRows: validGtinRows.length,
    restRows: restRows.length,
    batchSize: BATCH_SIZE,
    batchCount: batches.length,
    batches,
    scopeNote:
      "brand/size/model blank queues only. manufacturer_part_number (48,144 rows) intentionally excluded - see B6_ENRICHMENT_REPORT.md follow-up plan.",
  };
  fs.writeFileSync(path.join(B6_DIR, "queue_manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

  console.log(JSON.stringify(manifest, null, 2));
}

main();
