// Independent Gemini Flash check of the prefix CONFLICTS before promoting them. For each held-back brand
// the corpus confirms (>= 5 rows), decode one real example barcode through the LIVE pipeline (Gemini Flash
// + page fetch; the conflict brands are NOT in the prefix table, so the brand comes from Gemini/web, not the
// prefix). If Gemini independently names the same brand, the corpus + AI agree -> safe to promote.
// Usage: node scripts/check-conflicts-gemini.mjs [--base=http://localhost:3200]
import fs from "node:fs";
import { deriveBrandPrefixes, normalizeToGtin13 } from "../lib/prefix-miner.mjs";

const BASE = (process.argv.find((a) => a.startsWith("--base=")) || "--base=http://localhost:3200").split("=")[1];

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

// FINAL tiers + prefixes
const finalRows = parseCSV(fs.readFileSync("data/tire-knowledge/prefixes/tire_prefixes_FINAL.csv", "utf8"));
const fh = finalRows[0].map((h) => h.trim());
const fbi = fh.indexOf("brand"), fpi = fh.indexOf("prefix"), fti = fh.indexOf("ingest_tier");
const finalEntries = finalRows.slice(1).filter((r) => /^\d+$/.test((r[fpi] || "").trim()));
const finalPrefixes = [...new Set(finalEntries.map((r) => (r[fpi] || "").trim()))];
const finalTierByPrefix = {};
for (const r of finalEntries) { const p = (r[fpi] || "").trim(); (finalTierByPrefix[p] = finalTierByPrefix[p] || {})[brandNorm(r[fbi])] = (r[fti] || "").trim(); }
const heldOutBrands = new Set(finalRows.slice(1).filter((r) => ["review_before_use", "exclude_partnumber"].includes((r[fti] || "").trim())).map((r) => brandNorm(r[fbi])));
function lookupFinalPrefix(code) { const g = normalizeToGtin13(code); if (!g) return null; let best = null; for (const p of finalPrefixes) if ((g.startsWith(p) || g.startsWith("0" + p)) && (!best || p.length > best.length)) best = p; return best; }
function finalCovers(code) { const g = normalizeToGtin13(code); if (!g) return false; return finalPrefixes.some((p) => g.startsWith(p) || g.startsWith("0" + p)); }

// corpus brand -> Set(barcodes)
const crows = parseCSV(fs.readFileSync("data/tire-knowledge/tire_corpus_flat.csv", "utf8"));
const ch = crows[0].map((h) => h.trim());
const bi = ch.indexOf("brand"), ci = ch.indexOf("barcode");
const byBrand = new Map();
for (const r of crows.slice(1)) { if (r.length <= Math.max(bi, ci)) continue; const brand = titleCase((r[bi] || "").trim()), code = (r[ci] || "").trim(); if (!brand || !code) continue; if (!byBrand.has(brand)) byBrand.set(brand, new Set()); byBrand.get(brand).add(code); }

// Recompute the conflicts (same logic as the miners) WITH an example barcode each.
const MIN_CONFIRM = 5, MIN_SHARE = 0.1;
const conflicts = [];
for (const [brand, codes] of byBrand) {
  const total = codes.size;
  // sibling-style: brand lands on an existing FINAL prefix that held this brand back
  const onPrefix = new Map();
  for (const code of codes) { const p = lookupFinalPrefix(code); if (!p) continue; (onPrefix.get(p) || onPrefix.set(p, new Set()).get(p)).add(code); }
  for (const [p, set] of onPrefix) {
    if (set.size < MIN_CONFIRM || set.size < MIN_SHARE * total) continue;
    const tier = finalTierByPrefix[p] ? finalTierByPrefix[p][brandNorm(brand)] : undefined;
    if (tier && tier !== "hint_strong") conflicts.push({ brand, prefix: p, tier, count: set.size, example: [...set][0] });
  }
  // new-prefix style: a held-out brand forming a brand-new prefix block
  if (heldOutBrands.has(brandNorm(brand))) {
    for (const pp of deriveBrandPrefixes([...codes], { minConfirm: MIN_CONFIRM })) {
      if (pp.count < MIN_SHARE * total || finalCovers(pp.examples[0])) continue;
      conflicts.push({ brand, prefix: pp.prefix, tier: "held_out(new prefix)", count: pp.count, example: pp.examples[0] });
    }
  }
}

(async () => {
  try { const s = await (await fetch(BASE + "/api/ai-lookup")).json(); if (s.e2e) { console.error("server is e2e mock-only"); process.exit(1); } }
  catch { console.error(`cannot reach ${BASE}`); process.exit(1); }
  console.log(`Independent Gemini check of ${conflicts.length} conflicts via ${BASE} (conflict brands are NOT in the prefix table)\n`);
  let agree = 0;
  for (const c of conflicts.sort((a, b) => b.count - a.count)) {
    const codeType = c.example.length === 13 ? "ean_13" : "upc_a";
    const body = JSON.stringify({ mode: "decode-deep", scanContext: "tire", rawCode: c.example, cleanCode: c.example, codeType, confidenceThreshold: 0.85 });
    try {
      const r = await fetch(BASE + "/api/ai-lookup", { method: "POST", headers: { "Content-Type": "application/json" }, body });
      const data = await r.json();
      const txt = `${data?.results?.[0]?.productName || ""} ${data?.results?.[0]?.brand || ""}`.toLowerCase();
      const ok = txt.includes(brandNorm(c.brand)) || txt.replace(/[^a-z0-9]/g, "").includes(brandNorm(c.brand));
      if (ok) agree++;
      console.log(`  ${ok ? "AGREE " : "DIFFER"}  ${c.brand.padEnd(14)} ${c.prefix.padEnd(9)} corpus=${String(c.count).padStart(4)}  gemini="${(data?.results?.[0]?.productName || "").slice(0, 44)}"`);
    } catch (e) { console.log(`  ERROR   ${c.brand} ${e}`); }
  }
  console.log(`\nGemini agreed with the corpus on ${agree}/${conflicts.length} conflicts.`);
})();
