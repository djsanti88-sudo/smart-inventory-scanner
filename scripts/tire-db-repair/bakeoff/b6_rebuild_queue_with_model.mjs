#!/usr/bin/env node
// Task B6 - queue rebuild (one-time, after batches 1-2 dispatched): B5's remaining_blanks.json
// carried brand/size/mpn lists but NOT a model list, so the original b6_build_queue.mjs batches
// omitted "model" from missing_fields. This script rebuilds batches 3..N directly from the LIVE
// DB with model included:
//   - selects every tires row where brand, size, or model is blank (MPN stays out of scope),
//   - excludes placeholder barcodes,
//   - excludes barcodes already dispatched in batch_1_input.json / batch_2_input.json,
//   - one row per barcode covering ALL its missing fields,
//   - priority: boss-brand rows first (GS1 prefix map or known brand text), then valid-GTIN
//     check-digit rows, then rest; ascending barcode within each tier (deterministic).
// Writes batch_3_input.json onward (overwriting the previously generated, never-dispatched
// batch_3..14 files) and updates queue_manifest.json.

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
const B6_DIR = path.join(REPO_ROOT, "backups/claude-tire-db-handoff-2026-07-28/repair-2026-07-28/bakeoff/b6");

const BOSS_BRANDS = ["nexen", "arisun", "blackhawk", "fortune", "falken"];
const BATCH_SIZE = 100;
const FIRST_BATCH_NUM = 3;

function digitsOnly(s) {
  return String(s || "").replace(/\D/g, "");
}
function isPlaceholderBarcode(barcode) {
  return digitsOnly(barcode).replace(/^0+/, "").length <= 6;
}
function gs1Prefix7(code) {
  return digitsOnly(code).padStart(13, "0").slice(-13).slice(0, 7);
}
function isValidGtinShape(barcode) {
  const digits = digitsOnly(barcode);
  if (![8, 12, 13, 14].includes(digits.length)) return false;
  const payload = digits.slice(0, -1);
  const checkDigit = Number(digits[digits.length - 1]);
  let sum = 0;
  for (let i = 0; i < payload.length; i++) {
    sum += Number(payload[payload.length - 1 - i]) * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10 === checkDigit;
}

function main() {
  const prefixMap = JSON.parse(fs.readFileSync(PREFIX_MAP_PATH, "utf8"));

  const dispatched = new Set();
  for (const n of [1, 2]) {
    const p = path.join(B6_DIR, `batch_${n}_input.json`);
    for (const r of JSON.parse(fs.readFileSync(p, "utf8"))) dispatched.add(r.barcode);
  }

  const db = new Database(DB_PATH, { readonly: true });
  db.pragma("busy_timeout = 30000");
  const rows = db
    .prepare(
      `SELECT barcode, canonical_product_uid, brand, model, size, manufacturer_part_number
       FROM tires
       WHERE (brand IS NULL OR TRIM(brand)='')
          OR (size IS NULL OR TRIM(size)='')
          OR (model IS NULL OR TRIM(model)='')
       ORDER BY barcode ASC`
    )
    .all();
  db.close();

  const isBlank = (v) => v === null || v === undefined || String(v).trim() === "";

  const queue = [];
  let skippedPlaceholder = 0;
  let skippedDispatched = 0;
  for (const r of rows) {
    if (isPlaceholderBarcode(r.barcode)) {
      skippedPlaceholder++;
      continue;
    }
    if (dispatched.has(r.barcode)) {
      skippedDispatched++;
      continue;
    }
    const missing = [];
    if (isBlank(r.brand)) missing.push("brand");
    if (isBlank(r.model)) missing.push("model");
    if (isBlank(r.size)) missing.push("size");
    if (missing.length === 0) continue;
    queue.push({
      barcode: r.barcode,
      canonical_product_uid: r.canonical_product_uid,
      known_brand: r.brand || null,
      known_model: r.model || null,
      known_size: r.size || null,
      known_manufacturer_part_number: r.manufacturer_part_number || null,
      missing_fields: missing,
    });
  }

  function isBossBrandRow(row) {
    const mapped = (prefixMap[gs1Prefix7(row.barcode)] || "").toLowerCase();
    if (BOSS_BRANDS.includes(mapped)) return true;
    return BOSS_BRANDS.some((b) => String(row.known_brand || "").toLowerCase().includes(b));
  }

  const boss = queue.filter(isBossBrandRow);
  const nonBoss = queue.filter((r) => !isBossBrandRow(r));
  const validGtin = nonBoss.filter((r) => isValidGtinShape(r.barcode));
  const rest = nonBoss.filter((r) => !isValidGtinShape(r.barcode));
  const ordered = [...boss, ...validGtin, ...rest];

  // Remove stale never-dispatched batch files from the first build (3..99 range clean sweep).
  for (const f of fs.readdirSync(B6_DIR)) {
    const m = f.match(/^batch_(\d+)_input\.json$/);
    if (m && Number(m[1]) >= FIRST_BATCH_NUM) fs.rmSync(path.join(B6_DIR, f));
  }

  let nextId = 201; // batches 1-2 used B6-00001..B6-00200
  const batches = [];
  for (let i = 0; i < ordered.length; i += BATCH_SIZE) {
    const slice = ordered.slice(i, i + BATCH_SIZE);
    const batchNum = FIRST_BATCH_NUM + batches.length;
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
    batches.push({ batchNum, path: path.relative(REPO_ROOT, batchPath), rowCount: batchInput.length });
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    rebuild: "with model field, after batches 1-2 dispatched",
    totalRows: ordered.length,
    bossBrandRows: boss.length,
    validGtinRows: validGtin.length,
    restRows: rest.length,
    skippedPlaceholder,
    skippedAlreadyDispatched: skippedDispatched,
    batchSize: BATCH_SIZE,
    firstBatchNum: FIRST_BATCH_NUM,
    batchCount: batches.length,
    batches,
    scopeNote:
      "brand/model/size blanks only; manufacturer_part_number (48k) out of scope tonight. Batches 1-2 were dispatched WITHOUT model in missing_fields (remaining_blanks.json had no model list); their barcodes are excluded here and their model gap is noted in the report.",
  };
  fs.writeFileSync(path.join(B6_DIR, "queue_manifest_v2.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({ ...manifest, batches: manifest.batches.length + " batches" }, null, 2));
}

main();
