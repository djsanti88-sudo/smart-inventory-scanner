// PHASE 0 ANALYSIS ONLY - read-only profiler of the 4M+ retail DB (data/retail-knowledge/retail_off.jsonl).
// Does NOT touch runtime/firewall code, makes NO network/paid calls, writes only a JSON/markdown report.
// Streams the 2GB jsonl line-by-line. Answers the owner's 14 Phase-0 questions.
//
//   node --max-old-space-size=4096 scripts/analyze-prefix-db.mjs
//
// Prefix model: normalize to EAN-13 (pad UPC-12 with a leading 0; drop the GTIN-14 indicator digit),
// then take a 7-digit company-prefix bucket (variable-length GS1 prefixes are approximated; we also
// report distinct counts at 6 and 8 digits to inform the length choice). EAN-8 are counted separately.

import fs from "node:fs";
import readline from "node:readline";

const INPUT = "data/retail-knowledge/retail_off.jsonl";
const OUT_JSON = "reports/product-intel/prefix-phase0-analysis.json";
const OUT_MD = "reports/product-intel/prefix-phase0-analysis.md";
const PREFIX_LEN = 7;
const BRAND_CAP = 40; // cap distinct brands tracked per prefix (memory bound; 40+ => "very ambiguous")
const CAT_CAP = 40;

function checkDigitValid(c) {
  if (!/^\d+$/.test(c) || ![8, 12, 13, 14].includes(c.length)) return false;
  if (new Set(c).size === 1) return false;
  const ds = [...c].map(Number);
  const s = ds.slice(0, -1).reverse().reduce((a, d, i) => a + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (s % 10)) % 10 === ds[ds.length - 1];
}
function norm13(d) {
  if (d.length === 12) return "0" + d;
  if (d.length === 14) return d.slice(1);
  return d;
}
function firstCat(rec) {
  const m = (rec.main_category_en || "").trim();
  if (m) return m.toLowerCase();
  const ce = (rec.categories_en || "").trim();
  if (ce) return ce.split(",")[0].trim().toLowerCase();
  return "";
}
function brandOf(rec) {
  return ((rec.brands || "").split(",")[0].trim() || (rec.brand_owner || "").trim()).toLowerCase();
}

const stats = {
  rows: 0, withCode: 0, validStruct: 0, checkValid: 0,
  byLen: {}, ean8: 0,
  usableName: 0, usableBrand: 0, usableCat: 0, usableFull: 0,
};
const agg = new Map(); // prefix7 -> { total, usable, brands:Map, cats:Map, bOver:false, cOver:false }
const p6 = new Set(), p8 = new Set();

const rl = readline.createInterface({ input: fs.createReadStream(INPUT, { encoding: "utf8" }), crlfDelay: Infinity });
let parseErr = 0;
for await (const line of rl) {
  if (!line) continue;
  let rec; try { rec = JSON.parse(line); } catch { parseErr++; continue; }
  stats.rows++;
  const code = String(rec.code || "").trim();
  if (code) stats.withCode++;
  const digits = code.replace(/\D/g, "");
  const validStruct = /^\d+$/.test(digits) && [8, 12, 13, 14].includes(digits.length) && new Set(digits).size !== 1;
  if (!validStruct) continue;
  stats.validStruct++;
  stats.byLen[digits.length] = (stats.byLen[digits.length] || 0) + 1;
  if (checkDigitValid(digits)) stats.checkValid++;

  const name = (rec.product_name || "").trim();
  const brand = brandOf(rec);
  const cat = firstCat(rec);
  if (name) stats.usableName++;
  if (brand) stats.usableBrand++;
  if (cat) stats.usableCat++;
  const usable = !!(name && brand);
  if (name && brand && cat) stats.usableFull++;

  if (digits.length === 8) { stats.ean8++; continue; }
  const n13 = norm13(digits);
  if (n13.length < 13) continue;
  p6.add(n13.slice(0, 6));
  p8.add(n13.slice(0, 8));
  const pre = n13.slice(0, PREFIX_LEN);
  let e = agg.get(pre);
  if (!e) { e = { total: 0, usable: 0, brands: new Map(), cats: new Map(), bOver: false, cOver: false }; agg.set(pre, e); }
  e.total++;
  if (usable) {
    e.usable++;
    if (brand) {
      if (e.brands.has(brand)) e.brands.set(brand, e.brands.get(brand) + 1);
      else if (e.brands.size < BRAND_CAP) e.brands.set(brand, 1);
      else e.bOver = true;
    }
    if (cat) {
      if (e.cats.has(cat)) e.cats.set(cat, e.cats.get(cat) + 1);
      else if (e.cats.size < CAT_CAP) e.cats.set(cat, 1);
      else e.cOver = true;
    }
  }
}

// classify prefixes
function topShare(m, total) {
  let top = 0; let topKey = "";
  for (const [k, v] of m) if (v > top) { top = v; topKey = k; }
  return { share: total ? top / total : 0, key: topKey, count: top };
}
let ge10 = 0, strong = 0, weak = 0, moderate = 0;
const byDominant = new Map(); // brand -> [prefixes] (from dominant only; for multi-prefix-per-company)
let exMultiCompany = null, exStrongExamples = [], exCatSet = new Map();
for (const [pre, e] of agg) {
  if (e.usable < 10) { weak++; continue; }
  ge10++;
  const tb = topShare(e.brands, e.usable);
  const tc = topShare(e.cats, e.usable);
  const distinctBrands = e.brands.size + (e.bOver ? 1 : 0);
  const isStrong = tb.share >= 0.7 && distinctBrands <= 3 && tc.share >= 0.6 && !e.bOver;
  const isAmbiguous = e.bOver || distinctBrands >= 8 || tb.share < 0.4;
  if (isStrong) {
    strong++;
    if (tb.key && !byDominant.has(tb.key)) byDominant.set(tb.key, []);
    if (tb.key) byDominant.get(tb.key).push(pre);
    if (exStrongExamples.length < 12) exStrongExamples.push({ prefix: pre, brand: tb.key, brandShare: +tb.share.toFixed(2), category: tc.key, catShare: +tc.share.toFixed(2), usable: e.usable });
    if (tc.key && !exCatSet.has(tc.key)) exCatSet.set(tc.key, { prefix: pre, brand: tb.key, usable: e.usable });
  } else if (isAmbiguous) {
    weak++;
    if (!exMultiCompany && distinctBrands >= 4) {
      exMultiCompany = { prefix: pre, distinctBrands, topBrands: [...e.brands.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([b, c]) => `${b} x${c}`), topCategory: tc.key, usable: e.usable };
    }
  } else {
    moderate++;
  }
}
// multi-prefix-per-company example
let exMultiPrefix = null;
for (const [brand, prefixes] of byDominant) {
  if (prefixes.length >= 2) { exMultiPrefix = { company: brand, prefixCount: prefixes.length, prefixes: prefixes.slice(0, 6) }; break; }
}

const keptForIndex = strong + moderate; // prefixes we'd plausibly keep (>=10 usable, not pure noise)
const estBytesPerEntry = 320; // rough JSON bytes per PrefixEntry with a few candidates
const out = {
  input: INPUT, generatedRows: stats.rows, parseErrors: parseErr,
  q1_total_rows: stats.rows,
  q2_with_barcode: stats.withCode,
  q3_valid_structure: stats.validStruct,
  q3_by_length: stats.byLen, q3_ean8: stats.ean8,
  q4_check_digit_valid: stats.checkValid,
  q5_usable: { product_name: stats.usableName, brand_or_owner: stats.usableBrand, category: stats.usableCat, name_brand_category: stats.usableFull },
  q6_unique_prefixes: { len6: p6.size, len7: agg.size, len8: p8.size },
  q7_prefixes_ge10_usable: ge10,
  q8_strong_prefixes: strong,
  q9_weak_or_ambiguous_prefixes: weak,
  q9_moderate_prefixes: moderate,
  q10_est_index_entries: keptForIndex, q10_est_index_MB: +((keptForIndex * estBytesPerEntry) / 1048576).toFixed(1),
  q11_example_prefixes_by_category: [...exCatSet.entries()].slice(0, 10).map(([cat, v]) => ({ category: cat, ...v })),
  q11_strong_examples: exStrongExamples,
  q12_one_company_many_prefixes: exMultiPrefix,
  q13_one_prefix_many_companies: exMultiCompany,
};
fs.mkdirSync("reports/product-intel", { recursive: true });
fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
console.log(`\n[analyze] wrote ${OUT_JSON}`);
