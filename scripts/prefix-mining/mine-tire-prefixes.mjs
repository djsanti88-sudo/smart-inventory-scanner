// Mine cross-confirmed GS1 prefixes from the local tire corpus. Offline, deterministic, NO AI.
// Reads data/tire-knowledge/tire_corpus_flat.csv (read-only), writes tire_prefixes_ADDITIONS.csv
// (NEW; never touches tire_prefixes_FINAL.csv) + data/tire-knowledge/mine-report.md.
// Usage: node scripts/mine-tire-prefixes.mjs
import fs from "node:fs";
import { deriveBrandPrefixes, normalizeToGtin13 } from "../lib/prefix-miner.mjs";

const CORPUS = "data/tire-knowledge/tire_corpus_flat.csv";
const ADDITIONS = "data/tire-knowledge/prefixes/tire_prefixes_ADDITIONS.csv";
const REPORT = "data/tire-knowledge/mine-report.md";
const MAX_BRANDS_PER_PREFIX = 6; // wider => likely a country/region block, not a company prefix -> skip

// Char-by-char CSV parser (handles quoted fields with commas), same shape as genTirePrefixHints.mjs.
function parseCSV(text) {
  const rows = [];
  let i = 0, field = "", row = [], inQ = false;
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; }
      field += c; i++; continue;
    }
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

// Only ADD prefixes for barcodes FINAL does NOT already cover. This guarantees no mined prefix can be a
// longer form of an existing FINAL prefix (which would shadow FINAL's curated family via longest-wins).
// FINAL stays authoritative; we extend coverage to genuinely-new GS1 blocks only.
const finalRows = parseCSV(fs.readFileSync("data/tire-knowledge/prefixes/tire_prefixes_FINAL.csv", "utf8"));
const fhdr = finalRows[0].map((h) => h.trim());
const fpi = fhdr.indexOf("prefix"), fbi2 = fhdr.indexOf("brand"), fti2 = fhdr.indexOf("ingest_tier");
const finalPrefixes = finalRows.slice(1).map((r) => (r[fpi] || "").trim()).filter((p) => /^\d+$/.test(p));
// Brands FINAL HELD BACK (needs-review or not-a-retail-barcode). If the corpus forms a NEW prefix for one
// of these, surface it as a CONFLICT (owner's prior call vs >= 5 rows of corpus proof), never a silent add.
const heldOutBrands = new Set(
  finalRows.slice(1).filter((r) => ["review_before_use", "exclude_partnumber"].includes((r[fti2] || "").trim())).map((r) => brandNorm(r[fbi2])),
);
function finalCovers(code) {
  const g = normalizeToGtin13(code);
  if (!g) return false;
  return finalPrefixes.some((p) => g.startsWith(p) || g.startsWith("0" + p));
}

const rows = parseCSV(fs.readFileSync(CORPUS, "utf8"));
const header = rows[0].map((h) => h.trim());
const bi = header.indexOf("brand");
const ci = header.indexOf("barcode");
if (bi < 0 || ci < 0) { console.error("corpus missing brand/barcode columns"); process.exit(1); }

// brand -> Set(barcodes)
const byBrand = new Map();
for (const r of rows.slice(1)) {
  if (r.length <= Math.max(bi, ci)) continue;
  const brand = titleCase((r[bi] || "").trim());
  const code = (r[ci] || "").trim();
  if (!brand || !code) continue;
  if (!byBrand.has(brand)) byBrand.set(brand, new Set());
  byBrand.get(brand).add(code);
}

// prefix -> Map(brand -> {count, example})
// SHARE filter: a (prefix,brand) link only counts if this prefix holds >= MIN_SHARE of THAT brand's
// barcodes. This drops contamination - a brand's stray/mislabeled codes sitting on ANOTHER brand's
// prefix (e.g. 42 "Toyo" rows on Bridgestone's 0092971) - which would otherwise risk a wrong-brand
// corroboration. A brand's real prefix holds the bulk of its barcodes; contamination is a tiny fraction.
const MIN_SHARE = 0.1;
const MIN_CONFIRM = 5; // owner rule: >= 5 corpus rows from the legitimate tire library == 100% strong proof.
const byPrefix = new Map();
const minor = []; const conflicts = [];
let skippedCoveredByFinal = 0;
for (const [brand, codes] of byBrand) {
  const total = codes.size;
  for (const p of deriveBrandPrefixes([...codes], { minConfirm: MIN_CONFIRM })) {
    if (p.count < MIN_SHARE * total) { minor.push({ brand, prefix: p.prefix, count: p.count, total }); continue; }
    if (finalCovers(p.examples[0])) { skippedCoveredByFinal++; continue; } // FINAL already covers these codes
    if (heldOutBrands.has(brandNorm(brand))) { conflicts.push({ brand, prefix: p.prefix, count: p.count }); continue; } // held back
    if (!byPrefix.has(p.prefix)) byPrefix.set(p.prefix, new Map());
    byPrefix.get(p.prefix).set(brand, { count: p.count, example: p.examples[0] });
  }
}

// conflict guard + emit
const emitted = [], skipped = [];
for (const [prefix, brands] of [...byPrefix.entries()].sort()) {
  if (brands.size > MAX_BRANDS_PER_PREFIX) { skipped.push({ prefix, brands: [...brands.keys()] }); continue; }
  for (const [brand, info] of brands) emitted.push({ brand, prefix, count: info.count, example: info.example });
}

// write ADDITIONS.csv (columns identical to tire_prefixes_FINAL.csv)
const head = "brand,prefix,prefix_length,region,verification_status,ingest_tier,example_barcode,source_url,mapping_flag,notes";
const lines = emitted.map((e) => [
  e.brand, e.prefix, e.prefix.length, "mined", "barcode_checked_crossconfirmed", "hint_strong",
  e.example, "", "OK", `mined from corpus: ${e.count} barcodes`,
].join(","));
fs.writeFileSync(ADDITIONS, head + "\n" + lines.join("\n") + "\n");

// report
const distinctPrefixes = new Set(emitted.map((e) => e.prefix)).size;
const top = [...byPrefix.entries()].filter(([, b]) => b.size <= MAX_BRANDS_PER_PREFIX)
  .map(([p, b]) => ({ p, brand: [...b.keys()][0], total: [...b.values()].reduce((a, v) => a + v.count, 0), nbrands: b.size }))
  .sort((a, b) => b.total - a.total).slice(0, 20);
let md = `# Mined prefix report\n\nSource: ${CORPUS} (read-only). Output: ${ADDITIONS}. No AI used.\n\n`;
md += `- brands processed: ${byBrand.size}\n- distinct prefixes emitted: ${distinctPrefixes}\n- (prefix,brand) rows emitted: ${emitted.length}\n- skipped (too-wide, > ${MAX_BRANDS_PER_PREFIX} brands on one prefix): ${skipped.length}\n\n`;
md += `## Top 20 emitted prefixes (by confirming barcodes)\n\n| prefix | brand | brands | barcodes |\n|---|---|---|---|\n`;
for (const t of top) md += `| ${t.p} | ${t.brand} | ${t.nbrands} | ${t.total} |\n`;
md += `\n## Skipped (too-wide, flagged for manual review)\n\n`;
for (const s of skipped) md += `- ${s.prefix}: ${s.brands.length} brands (${s.brands.slice(0, 8).join(", ")}${s.brands.length > 8 ? ", ..." : ""})\n`;
md += `\n## Dropped (minor share < ${Math.round(MIN_SHARE * 100)}% of the brand's barcodes - likely contamination)\n\n`;
for (const m of minor.sort((a, b) => b.count - a.count).slice(0, 40)) md += `- ${m.brand} on ${m.prefix}: ${m.count} of ${m.total} (${(100 * m.count / m.total).toFixed(1)}%)\n`;
if (minor.length > 40) md += `- ... and ${minor.length - 40} more\n`;
fs.writeFileSync(REPORT, md);

console.log(`brands=${byBrand.size} distinctPrefixes=${distinctPrefixes} rows=${emitted.length} CONFLICTS=${conflicts.length} skippedCoveredByFinal=${skippedCoveredByFinal} skippedTooWide=${skipped.length} droppedMinor=${minor.length}`);
if (conflicts.length) for (const c of conflicts.sort((a, b) => b.count - a.count)) console.log(`  CONFLICT: ${c.brand} forms NEW prefix ${c.prefix} - corpus=${c.count} rows (FINAL held this brand back)`);
console.log(`wrote ${ADDITIONS} + ${REPORT}`);
