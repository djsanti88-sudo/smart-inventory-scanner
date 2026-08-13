#!/usr/bin/env node
"use strict";

// Read-only reconciliation of the 319-row Barcode Lookup pilot against the serving corpus.
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const Database = require("better-sqlite3");

const root = path.resolve(__dirname, "..", "..", "..");
const dbPath = path.join(root, "src", "server", "knowledge.generated.db");
const pilotPath = path.join(root, "data", "retail-knowledge", "retail_corpus.jsonl");
const outputPath = path.join(__dirname, "retail-pilot-profile.json");

function variants(code) {
  const stripped = code.replace(/^0+/, "") || "0";
  const values = new Set([code, stripped]);
  for (const base of [code, stripped]) {
    if (base.length <= 14) values.add(base.padStart(14, "0"));
    if (base.length <= 13) values.add(base.padStart(13, "0"));
    if (base.length <= 12) values.add(base.padStart(12, "0"));
  }
  return [...values].filter((value) => value.length >= 8 && value.length <= 14);
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
db.pragma("query_only = ON");
const lookup = db.prepare("SELECT barcode, product_name, brand, category FROM retail WHERE barcode = ?");
const counts = {
  rows: 0,
  invalid_json_rows: 0,
  gtin_valid_rows: 0,
  missing_title_rows: 0,
  missing_brand_rows: 0,
  missing_category_rows: 0,
  exact_barcode_overlap_rows: 0,
  variant_overlap_rows: 0,
  new_barcode_rows: 0,
  overlap_identity_disagreement_rows: 0,
};
const disagreements = [];

async function main() {
const input = readline.createInterface({ input: fs.createReadStream(pilotPath), crlfDelay: Infinity });
for await (const line of input) {
  counts.rows++;
  let row;
  try { row = JSON.parse(line); } catch { counts.invalid_json_rows++; continue; }
  const code = String(row.barcode_number || "").trim();
  const title = String(row.title || "").trim();
  const brand = String(row.brand || row.manufacturer || "").trim();
  const category = String(row.category || "").trim();
  if (row._gtin_valid === true) counts.gtin_valid_rows++;
  if (!title) counts.missing_title_rows++;
  if (!brand) counts.missing_brand_rows++;
  if (!category) counts.missing_category_rows++;

  let match = lookup.get(code);
  if (match) counts.exact_barcode_overlap_rows++;
  else {
    for (const candidate of variants(code)) {
      if (candidate === code) continue;
      match = lookup.get(candidate);
      if (match) { counts.variant_overlap_rows++; break; }
    }
  }
  if (!match) counts.new_barcode_rows++;
  else {
    const normalize = (value) => String(value || "").trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
    if (title && normalize(title) !== normalize(match.product_name)) {
      counts.overlap_identity_disagreement_rows++;
      if (disagreements.length < 30) {
        disagreements.push({
          input_barcode: code,
          matched_barcode: match.barcode,
          pilot_title: title,
          pilot_brand: brand,
          corpus_product_name: match.product_name,
          corpus_brand: match.brand,
        });
      }
    }
  }
}

db.close();
const result = {
  generated_at: new Date().toISOString(),
  source: "data/retail-knowledge/retail_corpus.jsonl",
  database: "src/server/knowledge.generated.db#retail",
  counts,
  disagreement_examples: disagreements,
};
fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + "\n", "utf8");
console.log(JSON.stringify(result.counts, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
