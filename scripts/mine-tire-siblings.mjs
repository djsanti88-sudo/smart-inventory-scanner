// Find corporate-SIBLING brands that share an EXISTING FINAL prefix (e.g. Nitto on Toyo's 4981910,
// Ironman/Hercules on Cooper's 029142, Continental on General's 051342). Offline, deterministic, NO AI.
// Unlike mine-tire-prefixes.mjs (which adds NEW prefix blocks), this adds NEW BRANDS onto a FINAL prefix
// at the SAME length - so it can never shadow FINAL; the generator just merges the family wider.
// Reads the corpus (read-only) + tire_prefixes_FINAL.csv (read-only). Writes tire_prefixes_SIBLINGS.csv.
// Usage: node scripts/mine-tire-siblings.mjs
import fs from "node:fs";
import { normalizeToGtin13 } from "./lib/prefix-miner.mjs";

const CORPUS = "data/tire-knowledge/tire_corpus_flat.csv";
const OUT = "tire_prefixes_SIBLINGS.csv";
const REPORT = "data/tire-knowledge/siblings-report.md";
const MIN_CONFIRM = 5;   // owner rule: >= 5 corpus rows from the legitimate tire library == 100% strong proof.
const MIN_SHARE = 0.1;   // and >= 10% of the brand's barcodes (drops mislabel contamination)
const MAX_SIBLINGS_PER_PREFIX = 4; // more new brands than this on one prefix => an importer block, not a company prefix

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
const titleCase = (s) => String(s || "").trim().split(/\s+/).map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
const brandNorm = (b) => String(b || "").toLowerCase().replace(/\([^)]*\)/g, "").replace(/[^a-z0-9]/g, "");

// FINAL: prefix list + the STRONG brand family already on each prefix.
const finalRows = parseCSV(fs.readFileSync("tire_prefixes_FINAL.csv", "utf8"));
const fh = finalRows[0].map((h) => h.trim());
const fbi = fh.indexOf("brand"), fpi = fh.indexOf("prefix"), fti = fh.indexOf("ingest_tier");
const finalEntries = finalRows.slice(1).filter((r) => /^\d+$/.test((r[fpi] || "").trim()));
const finalPrefixes = [...new Set(finalEntries.map((r) => (r[fpi] || "").trim()))];
// The tier FINAL assigned each (prefix, brand). Auto-add only brands FINAL never tiered on that prefix.
// A brand FINAL HELD BACK (hint_weak / review_before_use / exclude_partnumber) that the corpus now confirms
// with >= 5 rows is a CONFLICT we surface to the owner to re-decide - never a silent override or skip.
const finalTierByPrefix = {}; // prefix -> { brandNorm -> tier }
for (const r of finalEntries) {
  const p = (r[fpi] || "").trim();
  (finalTierByPrefix[p] = finalTierByPrefix[p] || {})[brandNorm(r[fbi])] = (r[fti] || "").trim();
}
// Longest FINAL prefix matching a barcode (direct or one-zero-shifted), mirroring lookupTirePrefix.
function lookupFinalPrefix(code) {
  const g = normalizeToGtin13(code);
  if (!g) return null;
  let best = null;
  for (const p of finalPrefixes) if ((g.startsWith(p) || g.startsWith("0" + p)) && (!best || p.length > best.length)) best = p;
  return best;
}

// Corpus brand -> Set(barcodes)
const rows = parseCSV(fs.readFileSync(CORPUS, "utf8"));
const header = rows[0].map((h) => h.trim());
const bi = header.indexOf("brand"), ci = header.indexOf("barcode");
const byBrand = new Map();
for (const r of rows.slice(1)) {
  if (r.length <= Math.max(bi, ci)) continue;
  const brand = titleCase((r[bi] || "").trim()), code = (r[ci] || "").trim();
  if (!brand || !code) continue;
  if (!byBrand.has(brand)) byBrand.set(brand, new Set());
  byBrand.get(brand).add(code);
}

// brand -> (finalPrefix -> Set(barcodes on it))
const counts = new Map();
for (const [brand, codes] of byBrand) {
  for (const code of codes) {
    const p = lookupFinalPrefix(code);
    if (!p) continue;
    if (!counts.has(brand)) counts.set(brand, new Map());
    if (!counts.get(brand).has(p)) counts.get(brand).set(p, new Set());
    counts.get(brand).get(p).add(code);
  }
}

// Emit a sibling row when a brand is corpus-confirmed on a FINAL prefix it is NOT already STRONG on.
const byPrefix = new Map(); const dropped = []; const conflicts = [];
for (const [brand, pm] of counts) {
  const total = byBrand.get(brand).size;
  for (const [p, set] of pm) {
    if (set.size < MIN_CONFIRM) continue;
    if (set.size < MIN_SHARE * total) { dropped.push({ brand, p, count: set.size, total }); continue; }
    const tier = finalTierByPrefix[p] ? finalTierByPrefix[p][brandNorm(brand)] : undefined;
    if (tier === "hint_strong") continue; // already trusted
    if (tier) { conflicts.push({ brand, prefix: p, count: set.size, tier }); continue; } // held back, but corpus confirms >= 5
    if (!byPrefix.has(p)) byPrefix.set(p, []);
    byPrefix.get(p).push({ brand, count: set.size, example: [...set][0] });
  }
}

const emitted = [], skippedWide = [];
for (const [p, sibs] of [...byPrefix.entries()].sort()) {
  if (sibs.length > MAX_SIBLINGS_PER_PREFIX) { skippedWide.push({ p, brands: sibs.map((s) => s.brand) }); continue; }
  for (const s of sibs) emitted.push({ brand: s.brand, prefix: p, count: s.count, example: s.example });
}

const head = "brand,prefix,prefix_length,region,verification_status,ingest_tier,example_barcode,source_url,mapping_flag,notes";
const csv = emitted.map((e) => [e.brand, e.prefix, e.prefix.length, "sibling", "barcode_checked_crossconfirmed", "hint_strong", e.example, "", "OK", `corpus sibling on FINAL prefix: ${e.count} barcodes`].join(","));
fs.writeFileSync(OUT, head + "\n" + csv.join("\n") + "\n");

let md = `# Sibling brands sharing FINAL prefixes\n\nSource: ${CORPUS} + tire_prefixes_FINAL.csv (both read-only). Output: ${OUT}. No AI.\n\n`;
md += `- new sibling rows emitted: ${emitted.length} across ${byPrefix.size} FINAL prefixes\n- skipped (too-wide, > ${MAX_SIBLINGS_PER_PREFIX} new brands on one prefix): ${skippedWide.length}\n\n`;
md += `## Emitted siblings\n\n| prefix | new sibling brand | barcodes |\n|---|---|---|\n`;
for (const e of emitted.sort((a, b) => b.count - a.count)) md += `| ${e.prefix} | ${e.brand} | ${e.count} |\n`;
if (skippedWide.length) { md += `\n## Skipped (too-wide, likely importer block)\n\n`; for (const s of skippedWide) md += `- ${s.p}: ${s.brands.join(", ")}\n`; }
if (conflicts.length) {
  md += `\n## CONFLICTS - owner re-decision needed (corpus confirms >= ${MIN_CONFIRM} rows, but FINAL held it back)\n\n`;
  md += `| brand | prefix | FINAL tier | corpus barcodes |\n|---|---|---|---|\n`;
  for (const c of conflicts.sort((a, b) => b.count - a.count)) md += `| ${c.brand} | ${c.prefix} | ${c.tier} | ${c.count} |\n`;
}
fs.writeFileSync(REPORT, md);

console.log(`siblings=${emitted.length} prefixes=${byPrefix.size} CONFLICTS=${conflicts.length} skippedWide=${skippedWide.length} droppedMinor=${dropped.length}`);
if (conflicts.length) for (const c of conflicts.sort((a, b) => b.count - a.count)) console.log(`  CONFLICT: ${c.brand} on ${c.prefix} - FINAL=${c.tier}, corpus=${c.count} rows`);
console.log(`wrote ${OUT} + ${REPORT}`);
