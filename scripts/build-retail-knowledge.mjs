#!/usr/bin/env node
// Generator: read the Open Food Facts JSONL (4M+ products) and produce a compact barcode->product
// index the server loads at startup for instant local resolution (no AI needed).
//
//   node scripts/build-retail-knowledge.mjs
//
// Output: src/server/retail-knowledge/retailKnowledge.generated.json (~compact, barcode-keyed)
//         src/server/retail-knowledge/retailKnowledge.generated.meta.json (stats)

import { createReadStream, writeFileSync, mkdirSync, renameSync, readFileSync, existsSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";

const ROOT = process.cwd();
const INPUT = join(ROOT, "data", "retail-knowledge", "retail_off.jsonl");
const OUT_DIR = join(ROOT, "src", "server", "retail-knowledge");
const OUT_JSON = join(OUT_DIR, "retailKnowledge.generated.json");
const OUT_META = join(OUT_DIR, "retailKnowledge.generated.meta.json");
// Output-sanity guard (DT-1, 2026-08-13, ported from build-tire-knowledge.mjs's F1 fix,
// 2026-08-12): refuse a rebuild that retains less than this fraction of the existing
// index's barcodes. --force overrides, for a deliberate corpus replacement.
const MIN_RETAINED_FRACTION = 0.9;
const FORCE = process.argv.includes("--force");

mkdirSync(OUT_DIR, { recursive: true });

/**
 * Does the meta file's recorded state actually describe the index file currently on disk?
 * (DT2-2, 2026-08-13.) The two-file write (index renamed, then meta renamed -- see the atomic
 * write at the bottom of this file) means an interrupted run between those two renames leaves a
 * STALE meta paired with a NEWER index: the meta's `index_size_bytes` no longer matches the
 * index's actual current byte size, and -- since meta is always written strictly AFTER the index
 * finishes in a healthy run -- the index's mtime ends up NEWER than the meta's mtime, an inverted
 * ordering that never happens in a normal completed run. Either signal alone is enough to call the
 * meta stale; trusting a rotted meta as the shrink guard's baseline would silently weaken the very
 * guard DT-1b exists to provide.
 */
function metaDescribesCurrentIndex(meta) {
  if (!existsSync(OUT_JSON)) return false;
  try {
    const indexStat = statSync(OUT_JSON);
    if (typeof meta.index_size_bytes === "number" && meta.index_size_bytes !== indexStat.size) return false;
    if (existsSync(OUT_META) && indexStat.mtimeMs > statSync(OUT_META).mtimeMs) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Barcode count of the index already on disk, or null when there is none (bootstrap).
 * Prefers the tiny meta file over parsing the ~259MB index, but only when the meta actually
 * describes the index that is currently on disk (DT2-2) -- otherwise falls back to counting the
 * real index directly rather than trusting a baseline that may have silently rotted.
 */
function priorBarcodeCount() {
  try {
    if (existsSync(OUT_META)) {
      const meta = JSON.parse(readFileSync(OUT_META, "utf8"));
      const n = meta.unique_barcodes;
      if (Number.isFinite(n) && n > 0 && metaDescribesCurrentIndex(meta)) return n;
    }
  } catch { /* fall through to the index itself */ }
  try {
    if (existsSync(OUT_JSON)) return Object.keys(JSON.parse(readFileSync(OUT_JSON, "utf8")).index ?? {}).length;
  } catch { /* unreadable prior index: treat as absent */ }
  return null;
}

// QA HARDENING FIX #5 (2026-07-16, live-proven): the crowdsourced Open Food Facts dump also contains
// literal GS1 TEXTBOOK EXAMPLE barcodes and demo/test/placeholder rows (contributors testing the
// submission form), previously ingested VERBATIM - only barcode shape + name length were checked. Live
// bug: 4006381333931 -> "Test Shopidoo", 5901234123457 -> "Sauce chiltepin"/"La lumbre",
// 0012345670121/0012345674020/0012345674037 -> brand "Healthyholics", plus rows literally named
// "Test"/"Fakeer"/"Fakewine"/"BrandTest". Skip these at BUILD time too (the read-time guard in
// src/services/ai/decode.ts's isExampleOrTestRow / src/server/decode/pipeline.ts / retailKnowledgeIndex.ts
// is the fix that ships immediately without a regen; this is belt-and-suspenders for the NEXT regen).
// EXACT-VALUE barcode blocklist only (never a fuzzy prefix - could suppress a real GTIN); whole-word
// name/brand markers only (never a substring - "Latest"/"Testarossa"/"contest" must survive).
const EXAMPLE_BARCODE_BLOCKLIST = new Set([
  "012345678905",
  "4006381333931",
  "5901234123457",
  "0012345670121",
  "0012345674020",
  "0012345674037",
]);
const TEST_NAME_PATTERN = /\b(test|fakeer|fake ?wine|dummy|sample product|placeholder|brandtest|shopidoo)\b/i;
function isDegenerateBarcodeShape(digits) {
  if (!digits) return false;
  if (/^0+$/.test(digits)) return true;
  if (/^(\d)\1+$/.test(digits)) return true;
  if (digits === "0123456789012" || digits === "1234567890128") return true;
  return false;
}
function isExampleOrTestRow(code, name, brand) {
  const digits = (code || "").replace(/\D/g, "");
  if (digits && isDegenerateBarcodeShape(digits)) return true;
  if (EXAMPLE_BARCODE_BLOCKLIST.has(code)) return true;
  if (name && TEST_NAME_PATTERN.test(name)) return true;
  if (brand && TEST_NAME_PATTERN.test(brand)) return true;
  return false;
}

// Compact format: barcode -> [name, brand, category]  (array to save ~40% JSON size vs object keys)
const index = {};
let total = 0, valid = 0, noCode = 0, noName = 0, dupes = 0, conflicts = 0, skippedExampleOrTest = 0;

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

  if (isExampleOrTestRow(code, name, brand)) { skippedExampleOrTest++; continue; }

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

console.log(`\n[build-retail-knowledge] Parsed ${total} rows, ${valid} unique barcodes, ${dupes} dupes merged, ${noCode} no-code, ${noName} no-name, ${skippedExampleOrTest} skipped-example-or-test`);

// OUTPUT-SANITY GUARD (DT-1, 2026-08-13). Everything above validates the INPUT (row
// shape, example/test blocklist); nothing validated the result. A truncated, partial, or
// stale retail_off.jsonl (interrupted download, wrong snapshot, disk issue) would parse
// cleanly, pass every per-row check, and atomically overwrite the real ~4M-barcode index
// with a near-empty one while reporting success. Refuse to shrink.
const prior = priorBarcodeCount();
if (prior !== null && valid < prior * MIN_RETAINED_FRACTION && !FORCE) {
  console.error(
    `[build-retail-knowledge] FAIL-CLOSED: refusing to shrink the retail index: existing=${prior} barcodes, ` +
    `rebuild=${valid} (below ${Math.round(MIN_RETAINED_FRACTION * 100)}% of existing). This usually means ` +
    `${INPUT} is truncated, partial, or from a stale snapshot. Pass --force only if you intend to replace the corpus.`,
  );
  process.exit(1);
}

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
  skipped_example_or_test: skippedExampleOrTest,
  conflicts,
  index_file: "retailKnowledge.generated.json",
  // DT2-2 (2026-08-13): the byte size of the index this meta describes, so a future run's shrink
  // guard can detect a meta left stale by an interrupted rename pair (see metaDescribesCurrentIndex
  // above) instead of silently trusting a rotted baseline.
  index_size_bytes: statSync(tmpJson).size,
};
writeFileSync(tmpMeta, JSON.stringify(meta, null, 2) + "\n");

// Back-to-back, nothing else running between them (DT2-1 pattern applied here too): the index is
// renamed first (it is what the app actually reads at runtime), then the meta. A crash in this gap
// leaves an old meta paired with a new index -- detected on the NEXT run by
// metaDescribesCurrentIndex() above, not trusted silently.
renameSync(tmpJson, OUT_JSON);
renameSync(tmpMeta, OUT_META);

const sizeBytes = statSync(OUT_JSON).size;
console.log(`[build-retail-knowledge] OK ${valid} products, index ${(sizeBytes / 1e6).toFixed(1)}MB`);
