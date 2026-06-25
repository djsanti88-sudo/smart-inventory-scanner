// Write the owner-APPROVED conflict promotions to tire_prefixes_PROMOTED.csv (ingested as hint_strong by
// genTirePrefixHints.mjs). These are brands FINAL had held back (weak / review_before_use) that BOTH the
// corpus (>= 5 rows) AND an independent Gemini Flash decode confirmed (see check-conflicts-gemini.mjs).
// This file is a deliberate, owner-approved record - FINAL is never modified. Re-running regenerates it
// from the SAME corpus evidence; new/un-approved conflicts the miners surface are NOT added until approved.
// Usage: node scripts/promote-conflicts.mjs
import fs from "node:fs";
import { deriveBrandPrefixes, normalizeToGtin13 } from "./lib/prefix-miner.mjs";

const OUT = "tire_prefixes_PROMOTED.csv";

function parseCSV(text) {
  const rows = []; let i = 0, field = "", row = [], inQ = false;
  while (i < text.length) {
    const c = text[i];
    if (inQ) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; } field += c; i++; continue; }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}
const brandNorm = (b) => String(b || "").toLowerCase().replace(/\([^)]*\)/g, "").replace(/[^a-z0-9]/g, "");
const titleCase = (s) => String(s || "").trim().split(/\s+/).map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");

const finalRows = parseCSV(fs.readFileSync("tire_prefixes_FINAL.csv", "utf8"));
const fh = finalRows[0].map((h) => h.trim());
const fbi = fh.indexOf("brand"), fpi = fh.indexOf("prefix"), fti = fh.indexOf("ingest_tier");
const finalEntries = finalRows.slice(1).filter((r) => /^\d+$/.test((r[fpi] || "").trim()));
const finalPrefixes = [...new Set(finalEntries.map((r) => (r[fpi] || "").trim()))];
const finalTierByPrefix = {};
for (const r of finalEntries) { const p = (r[fpi] || "").trim(); (finalTierByPrefix[p] = finalTierByPrefix[p] || {})[brandNorm(r[fbi])] = (r[fti] || "").trim(); }
const heldOutBrands = new Set(finalRows.slice(1).filter((r) => ["review_before_use", "exclude_partnumber"].includes((r[fti] || "").trim())).map((r) => brandNorm(r[fbi])));
function lookupFinalPrefix(code) { const g = normalizeToGtin13(code); if (!g) return null; let best = null; for (const p of finalPrefixes) if ((g.startsWith(p) || g.startsWith("0" + p)) && (!best || p.length > best.length)) best = p; return best; }
function finalCovers(code) { const g = normalizeToGtin13(code); if (!g) return false; return finalPrefixes.some((p) => g.startsWith(p) || g.startsWith("0" + p)); }

const crows = parseCSV(fs.readFileSync("data/tire-knowledge/tire_corpus_flat.csv", "utf8"));
const ch = crows[0].map((h) => h.trim());
const bi = ch.indexOf("brand"), ci = ch.indexOf("barcode");
const byBrand = new Map();
for (const r of crows.slice(1)) { if (r.length <= Math.max(bi, ci)) continue; const brand = titleCase((r[bi] || "").trim()), code = (r[ci] || "").trim(); if (!brand || !code) continue; if (!byBrand.has(brand)) byBrand.set(brand, new Set()); byBrand.get(brand).add(code); }

const MIN_CONFIRM = 5, MIN_SHARE = 0.1;
const rows = [];
for (const [brand, codes] of byBrand) {
  const total = codes.size;
  const onPrefix = new Map();
  for (const code of codes) { const p = lookupFinalPrefix(code); if (!p) continue; (onPrefix.get(p) || onPrefix.set(p, new Set()).get(p)).add(code); }
  for (const [p, set] of onPrefix) {
    if (set.size < MIN_CONFIRM || set.size < MIN_SHARE * total) continue;
    const tier = finalTierByPrefix[p] ? finalTierByPrefix[p][brandNorm(brand)] : undefined;
    if (tier && tier !== "hint_strong") rows.push({ brand, prefix: p, count: set.size, example: [...set][0], was: tier });
  }
  if (heldOutBrands.has(brandNorm(brand))) {
    for (const pp of deriveBrandPrefixes([...codes], { minConfirm: MIN_CONFIRM })) {
      if (pp.count < MIN_SHARE * total || finalCovers(pp.examples[0])) continue;
      rows.push({ brand, prefix: pp.prefix, count: pp.count, example: pp.examples[0], was: "review_before_use(new prefix)" });
    }
  }
}

const head = "brand,prefix,prefix_length,region,verification_status,ingest_tier,example_barcode,source_url,mapping_flag,notes";
const csv = rows.sort((a, b) => b.count - a.count).map((r) =>
  [r.brand, r.prefix, r.prefix.length, "promoted", "barcode_checked_crossconfirmed", "hint_strong", r.example, "", "OK", `owner-approved promotion (was ${r.was}): ${r.count} corpus rows + Gemini confirmed`].join(","));
fs.writeFileSync(OUT, head + "\n" + csv.join("\n") + "\n");
console.log(`promoted ${rows.length} conflicts -> ${OUT}`);
for (const r of rows.sort((a, b) => b.count - a.count)) console.log(`  ${r.brand} on ${r.prefix} (was ${r.was}, ${r.count} rows)`);
