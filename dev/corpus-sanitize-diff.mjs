// SCRATCH (dev/, not committed): compute the before/after diff of the retail corpus sanitize for the
// owner. Reads the generated retail JSON and applies sanitizeRetailEntry to count/sample dropped and
// brand-truncated rows. NO Turso access, NO sync - read-only local analysis.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizeRetailEntry, isDummyBarcode } from "../scripts/retailIngestRules.mjs";

const ROOT = process.cwd();
const RETAIL_JSON = join(ROOT, "src", "server", "retail-knowledge", "retailKnowledge.generated.json");

console.log("[diff] reading generated retail JSON...");
const data = JSON.parse(readFileSync(RETAIL_JSON, "utf8"));
const index = data.index || {};
const entries = Object.entries(index);

let total = 0;
let dropped = 0;
let droppedDummy = 0;
let droppedGarbled = 0;
let brandTruncated = 0;
let brandCleared = 0;
const dropSamples = [];
const truncSamples = [];

for (const [code, entry] of entries) {
  total++;
  const clean = sanitizeRetailEntry(code, entry);
  if (!clean) {
    dropped++;
    if (isDummyBarcode(code)) droppedDummy++;
    else droppedGarbled++;
    if (dropSamples.length < 25) dropSamples.push({ code, before: entry });
    continue;
  }
  const oldBrand = (entry?.[1] ?? "").toString().trim();
  const newBrand = clean[1] ?? "";
  if (oldBrand && oldBrand !== newBrand) {
    if (newBrand === "") brandCleared++;
    else brandTruncated++;
    if (truncSamples.length < 25) truncSamples.push({ code, before: oldBrand, after: newBrand });
  }
}

const summary = {
  generated_at_of_source: data.generated_at,
  total_rows: total,
  rows_dropped: dropped,
  rows_dropped_dummy_barcode: droppedDummy,
  rows_dropped_garbled_text: droppedGarbled,
  rows_kept: total - dropped,
  brand_truncated_to_first_tag: brandTruncated,
  brand_cleared_still_garbled: brandCleared,
  pct_dropped: ((dropped / total) * 100).toFixed(4) + "%",
  pct_brand_changed: (((brandTruncated + brandCleared) / total) * 100).toFixed(4) + "%",
};

const report = { summary, dropped_samples: dropSamples, brand_change_samples: truncSamples };
const OUT = join(ROOT, "dev", "corpus-sanitize-diff.json");
writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
console.log("[diff] summary:", JSON.stringify(summary, null, 2));
console.log("[diff] wrote", OUT);
