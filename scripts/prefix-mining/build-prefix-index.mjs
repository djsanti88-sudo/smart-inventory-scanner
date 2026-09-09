// Offline derivation of the GS1 prefix-confidence map for the anti-hallucination firewall.
// Streams a product dataset (default: the tire corpus CSV) and aggregates, per 6-digit company prefix,
// the candidate brands/manufacturers with confidence weights + category distribution. Emits the map in
// the PrefixEntry shape consumed by src/products/catalog/prefixIndex.ts (derived_catalog source).
//
// This is STATISTICAL evidence, NOT official GS1 truth. Run offline ($0, no AI):
//   node scripts/build-prefix-index.mjs [--input <csv>] [--out <json>] [--min <n>] [--brandCol N] [--codeCol N] [--category tire]
// Default --out writes the runtime map (src/products/catalog/derivedPrefixMap.json); use --out to a
// proof path to inspect without changing runtime. For the full 4M DB, export it to CSV/JSONL first
// (Firestore -> rows of {barcode, brand, category}) and point --input at it.

import fs from "node:fs";

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const INPUT = opt("input", "data/tire-knowledge/tire_corpus_flat.csv");
const OUT = opt("out", "src/products/catalog/derivedPrefixMap.json");
const MIN = Number(opt("min", "3"));
const BRAND_COL = Number(opt("brandCol", "1")); // tire corpus: brand is column 1
const CODE_COL = Number(opt("codeCol", "9")); // tire corpus: barcode is column 9
const CATEGORY = opt("category", "tire"); // corpus rows are all tires; override per dataset

const text = fs.readFileSync(INPUT, "utf8");
const lines = text.split(/\r?\n/);
const agg = new Map(); // prefix -> { brands: Map<name,count>, total }
let rows = 0;

for (let i = 1; i < lines.length; i++) {
  const line = lines[i];
  if (!line) continue;
  const cols = line.split(",");
  const brand = (cols[BRAND_COL] || "").trim();
  const code = (cols[CODE_COL] || "").replace(/\D/g, "");
  if (!brand || code.length < 6) continue;
  const prefix = code.slice(0, 6);
  rows++;
  let e = agg.get(prefix);
  if (!e) { e = { brands: new Map(), total: 0 }; agg.set(prefix, e); }
  e.brands.set(brand, (e.brands.get(brand) || 0) + 1);
  e.total++;
}

const out = {};
let kept = 0;
for (const [prefix, e] of agg) {
  if (e.total < MIN) continue;
  const sorted = [...e.brands.entries()].sort((a, b) => b[1] - a[1]);
  const candidates = sorted.slice(0, 5).map(([name, count]) => ({
    name,
    kind: "manufacturer",
    productCount: count,
    confidence: Number((count / e.total).toFixed(3)),
    categories: [CATEGORY],
  }));
  const topShare = sorted[0][1] / e.total;
  out[prefix] = {
    prefix,
    candidates,
    dominant: topShare >= 0.5 ? candidates[0] : null,
    productCount: e.total,
    categoryDist: { [CATEGORY]: e.total },
    countryHints: [],
    confidence: Number(topShare.toFixed(3)),
    ambiguity: Number((1 - topShare).toFixed(3)),
    source: "derived_catalog",
  };
  kept++;
}

fs.writeFileSync(OUT, JSON.stringify(out));
const sample = Object.values(out).sort((a, b) => b.productCount - a.productCount).slice(0, 3)
  .map((x) => `${x.prefix}->${x.dominant?.name ?? "(ambiguous)"} x${x.productCount} conf=${x.confidence}`);
console.log(`[build-prefix-index] input=${INPUT} rows=${rows} distinctPrefixes=${agg.size} kept(min>=${MIN})=${kept}`);
console.log(`[build-prefix-index] out=${OUT}`);
console.log(`[build-prefix-index] top: ${sample.join(" | ")}`);
