#!/usr/bin/env node
// MPN PILOT (owner-approved 2026-07-28) - build a 200-row priority-ordered research queue for
// manufacturer_part_number blank rows, split into 2 batches of 100, following the exact
// b6_build_queue.mjs pattern (blind row shape, dedupe by barcode, deterministic priority order).
//
// Scope: manufacturer_part_number ONLY (the field B6 explicitly quarantined). This is the
// owner-approved pilot to measure hit rate before committing to the full 48,145-row backlog.
//
// Priority order (owner-authorized, pilot spec):
//   1. Five boss brands (nexen, arisun, blackhawk, fortune, falken) - via brandPrefixMap.json GS1
//      prefix match OR known brand column text match.
//   2. Valid public GTIN barcode (non-placeholder, correct mod-10 check digit at a standard
//      GTIN-8/12/13/14 length) - same check as B6's tier 2.
//   3. Rows richest in known fields (brand + model + size ALL present) - best research targets.
//   4. Everything else (still non-placeholder).
//
// Placeholder barcodes (numeric core <= 6 digits after stripping leading zeros) are EXCLUDED.
//
// Output: repair-2026-07-28/bakeoff/mpn_pilot/batch_<N>_input.json (100 rows each),
// repair-2026-07-28/bakeoff/mpn_pilot/queue_manifest.json.

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

const DB_PATH = path.join(
  REPO_ROOT,
  "backups/claude-tire-db-handoff-2026-07-28/repair-2026-07-28/REPAIRED_TIRE_DATABASE.db"
);
const PREFIX_MAP_PATH = path.join(REPO_ROOT, "src/services/catalog/brandPrefixMap.json");
const OUT_DIR = path.join(
  REPO_ROOT,
  "backups/claude-tire-db-handoff-2026-07-28/repair-2026-07-28/bakeoff/mpn_pilot"
);

const BOSS_BRANDS = ["nexen", "arisun", "blackhawk", "fortune", "falken"];
const BATCH_SIZE = 100;
const PILOT_TOTAL = 200;

function digitsOnly(s) {
  return String(s || "").replace(/\D/g, "");
}
function toGtin13(code) {
  return digitsOnly(code).padStart(13, "0").slice(-13);
}
function gs1Prefix7(code) {
  return toGtin13(code).slice(0, 7);
}
function isPlaceholderBarcode(barcode) {
  const digits = digitsOnly(barcode);
  const stripped = digits.replace(/^0+/, "");
  return stripped.length <= 6;
}
function isValidGtinShape(barcode) {
  const digits = digitsOnly(barcode);
  if (![8, 12, 13, 14].includes(digits.length)) return false;
  const payload = digits.slice(0, -1);
  const checkDigit = Number(digits[digits.length - 1]);
  let sum = 0;
  for (let i = 0; i < payload.length; i++) {
    const digit = Number(payload[payload.length - 1 - i]);
    sum += digit * (i % 2 === 0 ? 3 : 1);
  }
  const computedCheck = (10 - (sum % 10)) % 10;
  return computedCheck === checkDigit;
}

function main() {
  const db = new Database(DB_PATH, { readonly: true });
  db.pragma("busy_timeout = 30000");

  const prefixMap = JSON.parse(fs.readFileSync(PREFIX_MAP_PATH, "utf8"));

  const rows = db
    .prepare(
      `SELECT barcode, canonical_product_uid, brand, model, size, manufacturer_part_number
       FROM tires
       WHERE manufacturer_part_number IS NULL OR TRIM(manufacturer_part_number) = ''`
    )
    .all();
  db.close();

  const nonPlaceholder = rows.filter((r) => !isPlaceholderBarcode(r.barcode));

  function isBossBrandRow(row) {
    const prefix7 = gs1Prefix7(row.barcode);
    const mappedBrand = (prefixMap[prefix7] || "").toLowerCase();
    if (BOSS_BRANDS.some((b) => mappedBrand.includes(b))) return true;
    const knownBrandLower = String(row.brand || "").toLowerCase();
    return BOSS_BRANDS.some((b) => knownBrandLower.includes(b));
  }
  function isRichRow(row) {
    return (
      String(row.brand || "").trim() !== "" &&
      String(row.model || "").trim() !== "" &&
      String(row.size || "").trim() !== ""
    );
  }

  // Tiering per pilot spec: (1) boss brand, (2) valid GTIN (non-boss), (3) rich known fields
  // (non-boss, non-valid-GTIN-already-counted - but a row can be BOTH valid GTIN AND rich; tier 2
  // (valid GTIN) takes priority per the spec's ordering, tier 3 picks up remaining rich rows that
  // are not valid-GTIN-shaped, e.g. UPC-A/EAN-8 non-standard-length codes), (4) rest.
  const bossRows = [];
  const validGtinRows = [];
  const richRows = [];
  const restRows = [];
  for (const row of nonPlaceholder) {
    if (isBossBrandRow(row)) bossRows.push(row);
    else if (isValidGtinShape(row.barcode)) validGtinRows.push(row);
    else if (isRichRow(row)) richRows.push(row);
    else restRows.push(row);
  }

  const byBarcodeAsc = (a, b) => (a.barcode < b.barcode ? -1 : a.barcode > b.barcode ? 1 : 0);
  bossRows.sort(byBarcodeAsc);
  validGtinRows.sort(byBarcodeAsc);
  richRows.sort(byBarcodeAsc);
  restRows.sort(byBarcodeAsc);

  const priorityOrdered = [...bossRows, ...validGtinRows, ...richRows, ...restRows];
  const pilotSlice = priorityOrdered.slice(0, PILOT_TOTAL);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const batches = [];
  let nextId = 1;
  for (let i = 0; i < pilotSlice.length; i += BATCH_SIZE) {
    const slice = pilotSlice.slice(i, i + BATCH_SIZE);
    const batchNum = batches.length + 1;
    const batchInput = slice.map((row) => {
      const id = `MPNP-${String(nextId).padStart(5, "0")}`;
      nextId += 1;
      const known_fields = {};
      if (row.brand) known_fields.brand = row.brand;
      if (row.model) known_fields.model = row.model;
      if (row.size) known_fields.size = row.size;
      return { id, barcode: row.barcode, known_fields, missing_fields: ["manufacturer_part_number"] };
    });
    const batchPath = path.join(OUT_DIR, `batch_${batchNum}_input.json`);
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
    totalBlankMpnRows: rows.length,
    nonPlaceholderRows: nonPlaceholder.length,
    pilotTotal: pilotSlice.length,
    bossBrandRowsInPilot: pilotSlice.filter((r) => bossRows.includes(r)).length,
    validGtinRowsInPilot: pilotSlice.filter((r) => validGtinRows.includes(r)).length,
    richRowsInPilot: pilotSlice.filter((r) => richRows.includes(r)).length,
    restRowsInPilot: pilotSlice.filter((r) => restRows.includes(r)).length,
    tierCounts: {
      bossBrandTotal: bossRows.length,
      validGtinTotal: validGtinRows.length,
      richTotal: richRows.length,
      restTotal: restRows.length,
    },
    batchSize: BATCH_SIZE,
    batchCount: batches.length,
    batches,
    scopeNote:
      "MPN PILOT (2026-07-28): manufacturer_part_number only, 200-row sample, 2 batches of 100, sequential Codex. Priority: boss brands > valid GTIN > rich-known-fields > rest. Placeholder barcodes excluded.",
  };
  fs.writeFileSync(path.join(OUT_DIR, "queue_manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

  console.log(JSON.stringify(manifest, null, 2));
}

main();
