// Validate the prefix + AI decode path on UNKNOWN tires - the pre-publish stress test.
// Samples real barcodes from the corpus and decodes them through the LIVE pipeline (prefix table +
// Gemini Flash ONLY; the corpus is never consulted by the decoder). Measures verify rate, latency, cost.
// Usage: node scripts/validate-prefix-decode.mjs --count=20 [--base=http://localhost:3200]
import fs from "node:fs";
import path from "node:path";

const arg = (n, d) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.split("=")[1] : d; };
const BASE = arg("base", "http://localhost:3200");
const COUNT = Number(arg("count", "20"));
const date = new Date().toISOString().slice(0, 10);

const lines = fs.readFileSync("data/tire-knowledge/tire_corpus_flat.csv", "utf8").split(/\r?\n/).slice(1).filter(Boolean);
// brand=col 1, barcode=col 9; columns before barcode contain no commas in this corpus, so a plain split is safe.
const step = Math.max(1, Math.floor(lines.length / COUNT));
const sample = [];
for (let i = 0; i < lines.length && sample.length < COUNT; i += step) {
  const c = lines[i].split(",");
  const brand = (c[1] || "").trim(), code = (c[9] || "").trim();
  if (code && /^\d{12,13}$/.test(code)) sample.push({ brand, code });
}

const pctl = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const RATE = { firecrawlPerCredit: 0.0015, geminiPerCall: 0.0004, openaiPerCall: 0.0005 };

(async () => {
  // precheck
  try { const s = await (await fetch(BASE + "/api/ai-lookup")).json(); if (s.e2e) { console.error("server is e2e mock-only"); process.exit(1); } }
  catch { console.error(`cannot reach ${BASE}; start: npm run dev -- -p 3200`); process.exit(1); }

  console.log(`Validating prefix + AI decode on ${sample.length} corpus tires via ${BASE} (decoder uses prefix table + Gemini Flash only)\n`);
  const per = [];
  for (const t of sample) {
    const codeType = t.code.length === 13 ? "ean_13" : "upc_a";
    const body = JSON.stringify({ mode: "decode-deep", scanContext: "tire", rawCode: t.code, cleanCode: t.code, codeType, confidenceThreshold: 0.85, allowImageSuggestions: true });
    const t0 = Date.now();
    try {
      const r = await fetch(BASE + "/api/ai-lookup", { method: "POST", headers: { "Content-Type": "application/json" }, body });
      const data = await r.json();
      const wall = Date.now() - t0;
      const decision = String((data.decision && data.decision.status) || "").toLowerCase();
      const prod = `${(data.results && data.results[0] && data.results[0].productName) || ""} ${(data.results && data.results[0] && data.results[0].brand) || ""}`.toLowerCase();
      const brandHit = t.brand ? prod.includes(t.brand.toLowerCase()) : false;
      per.push({ code: t.code, brand: t.brand, decision, brandHit, wall, debug: data.debug || {} });
      console.log(`  ${t.code} ${(t.brand || "").padEnd(14)} ${String(wall).padStart(6)}ms  ${decision.padEnd(12)} brand:${brandHit ? "Y" : "-"}`);
    } catch (e) { per.push({ code: t.code, brand: t.brand, decision: "error", brandHit: false, wall: 0, debug: {} }); console.error(`  ${t.code} ERROR ${e}`); }
  }

  const n = per.length;
  const verified = per.filter((r) => r.decision === "verified").length;
  const review = per.filter((r) => r.decision === "needs_review" || r.decision === "suggested").length;
  const lat = per.filter((r) => r.wall > 0).map((r) => r.wall);
  const fc = per.reduce((a, r) => a + (Number(r.debug.firecrawlCredits) || 0), 0);
  const gem = per.reduce((a, r) => a + (Number(r.debug.geminiCalls) || 0), 0);
  const oai = per.reduce((a, r) => a + (Number(r.debug.openaiCalls) || 0), 0);
  const cost = +(fc * RATE.firecrawlPerCredit + gem * RATE.geminiPerCall + oai * RATE.openaiPerCall).toFixed(3);
  const out = {
    date, base: BASE, sampled: n,
    verifiedPct: n ? Math.round((100 * verified) / n) : 0,
    needsReviewPct: n ? Math.round((100 * review) / n) : 0,
    brandCorrectPct: n ? Math.round((100 * per.filter((r) => r.brandHit).length) / n) : 0,
    latencyMs: { p50: pctl(lat, 50), p95: pctl(lat, 95), max: lat.length ? Math.max(...lat) : 0 },
    cost: { firecrawlCredits: fc, geminiCalls: gem, openaiCalls: oai, estUsd: cost },
    perCode: per.map(({ debug, ...r }) => r),
  };
  const dir = path.resolve("reports/product-intel", date);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "prefix-decode-validation.json"), JSON.stringify(out, null, 2));

  console.log(`\n== Prefix + AI decode on unknown tires ==`);
  console.log(`sampled:        ${n}`);
  console.log(`auto-verified:  ${out.verifiedPct}%  (was ~30% with the 45-strong table)`);
  console.log(`needs review:   ${out.needsReviewPct}%`);
  console.log(`brand correct:  ${out.brandCorrectPct}%`);
  console.log(`latency:        p50 ${out.latencyMs.p50}ms  p95 ${out.latencyMs.p95}ms`);
  console.log(`est cost:       $${cost}  (fc:${fc} gem:${gem} oai:${oai})`);
  console.log(`wrote ${path.join(dir, "prefix-decode-validation.json")}`);
})();
