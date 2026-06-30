#!/usr/bin/env node
// Generator: read the Open Food Facts JSONL (4M+ products) and produce a compact barcode->product
// index the server loads at startup for instant local resolution (no AI needed).
//
//   node scripts/build-retail-knowledge.mjs
//
// Output: src/server/retail-knowledge/retailKnowledge.generated.json (~compact, barcode-keyed)
//         src/server/retail-knowledge/retailKnowledge.generated.meta.json (stats)

import { createReadStream, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";

const ROOT = process.cwd();
const INPUT = join(ROOT, "data", "retail-knowledge", "retail_off.jsonl");
const OUT_DIR = join(ROOT, "src", "server", "retail-knowledge");
const OUT_JSON = join(OUT_DIR, "retailKnowledge.generated.json");
const OUT_META = join(OUT_DIR, "retailKnowledge.generated.meta.json");

mkdirSync(OUT_DIR, { recursive: true });

// Compact format: barcode -> [name, brand, category]  (array to save ~40% JSON size vs object keys)
const index = {};
let total = 0, valid = 0, noCode = 0, noName = 0, dupes = 0, conflicts = 0;

const rl = createInterface({ input: createReadStream(INPUT), crlfDelay: Infinity });

for await (const line of rl) {
  total++;
  if (total % 500000 === 0) process.stdout.write(`  ${(total / 1e6).toFixed(1)}M...\r`);
  let d;
  try { d = JSON.parse(line); } catch { continue; }

  const code = (d.code || "").toString().trim();
  // Valid barcode: 8-14 digits (UPC-8, UPC-A, EAN-13, GTIN-14)
  if (!code || !/^\d{8,14}$/.test(code)) { noCode++; continue; }

  const name = (d.product_name || "").trim();
  if (!name || name.length < 3) { noName++; continue; }

  const brand = (d.brands || d.brand_owner || "").trim();
  const category = (d.main_category_en || d.categories_en || "").split(",")[0].trim();

  if (index[code]) {
    dupes++;
    // Keep the entry with more info (longer name + brand)
    const existing = index[code];
    if ((name.length + brand.length) > (existing[0].length + (existing[1] || "").length)) {
      index[code] = [name, brand, category].map(s => s || undefined);
    }
    continue;
  }

  index[code] = [name, brand || undefined, category || undefined];
  valid++;
}

console.log(`\n[build-retail-knowledge] Parsed ${total} rows, ${valid} unique barcodes, ${dupes} dupes merged, ${noCode} no-code, ${noName} no-name`);

// Write atomically
const generated_at = new Date().toISOString();
const tmpJson = OUT_JSON + ".tmp";
const tmpMeta = OUT_META + ".tmp";

// Use a streaming write for the large index to avoid OOM
const entries = Object.entries(index);
let json = '{"generated_at":"' + generated_at + '","index":{';
for (let i = 0; i < entries.length; i++) {
  const [k, v] = entries[i];
  json += (i > 0 ? "," : "") + JSON.stringify(k) + ":" + JSON.stringify(v);
  // Flush in chunks to avoid string concat OOM
  if (i % 100000 === 0 && i > 0) {
    writeFileSync(tmpJson, json, { flag: i === 100000 ? "w" : "a" });
    json = "";
  }
}
json += "}}";
writeFileSync(tmpJson, json, { flag: entries.length > 100000 ? "a" : "w" });

const meta = {
  generated_at,
  source: "data/retail-knowledge/retail_off.jsonl",
  source_row_count: total,
  unique_barcodes: valid,
  duplicates_merged: dupes,
  skipped_no_code: noCode,
  skipped_no_name: noName,
  conflicts,
  index_file: "retailKnowledge.generated.json",
};
writeFileSync(tmpMeta, JSON.stringify(meta, null, 2) + "\n");

renameSync(tmpJson, OUT_JSON);
renameSync(tmpMeta, OUT_META);

import { statSync as statSyncFs } from "node:fs";
const sizeBytes = statSyncFs(OUT_JSON).size;
console.log(`[build-retail-knowledge] OK ${valid} products, index ${(sizeBytes / 1e6).toFixed(1)}MB`);
