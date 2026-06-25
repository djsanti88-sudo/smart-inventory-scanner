// Weekly tire decode monitor. Rotates FRESH tire codes (never the same set twice, so the decode cache
// cannot mask real speed) through the LIVE /api/ai-lookup pipeline and measures the numbers that matter:
//   decode-success rate (verified, no human)  | needs-review rate (target: only truly unfindable)
//   accuracy (correct brand among verified)    | latency p50/p95/max | false-auto-count (must be 0) | est cost
// Writes reports/product-intel/<date>/scan-health.json for the weekly report to read.
//
// Usage: node scripts/weekly-tire-scan.ts --base=http://localhost:3200 --count=15 [--date=YYYY-MM-DD]
// Needs a REAL dev server running (npm run dev -- -p 3200) with AI keys in .env.local. Costs API money.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { firecrawlCreditsForResponse, aiCallsForResponse } from "../src/services/benchmark/benchmarkAnalysis.ts";

const arg = (n, d) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.split("=")[1] : d; };
const BASE = arg("base", process.env.SMOKE_BASE_URL || "http://localhost:3000");
const COUNT = Number(arg("count", "15"));
const DATE = arg("date", new Date().toISOString().slice(0, 10));
const POOL = "benchmarks/tire_pool.csv";
const STATE = "benchmarks/tire-rotation-state.json";
const OUTDIR = `reports/product-intel/${DATE}`;
// Rough cost estimate for mini models. Documented assumptions, not exact billing.
const RATE = { firecrawlPerCredit: 0.0015, geminiPerCall: 0.0004, openaiPerCall: 0.0005 };

function parsePool(text) {
  const lines = text.trim().split(/\r?\n/);
  const hdr = lines[0].split(",").map((s) => s.trim());
  return lines.slice(1).map((l) => {
    const cells = l.split(",");
    const o = {};
    hdr.forEach((h, i) => (o[h] = (cells[i] || "").trim()));
    o.shouldAutoCount = o.shouldAutoCount === "true";
    return o;
  }).filter((r) => r.code);
}
function codeType(c) {
  if (/^\d{12}$/.test(c)) return "upc_a";
  if (/^\d{13}$/.test(c)) return "ean_13";
  if (/^\d{14}$/.test(c)) return "gtin_14";
  return /^\d+$/.test(c) ? "numeric_sku" : "alpha_sku";
}
async function decode(code) {
  const t0 = Date.now();
  const r = await fetch(BASE + "/api/ai-lookup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "decode", rawCode: code, cleanCode: code, codeType: codeType(code), confidenceThreshold: 0.85, allowImageSuggestions: true }),
  });
  return { data: await r.json(), wallMs: Date.now() - t0 };
}
const pctl = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };

async function main() {
  let status;
  try { status = await (await fetch(BASE + "/api/ai-lookup")).json(); }
  catch (e) { console.error(`Cannot reach dev server at ${BASE}. Start it: npm run dev -- -p 3200`); process.exit(1); }
  if (status.e2e) { console.error("Server is IS_E2E mock-only; real decode disabled. Restart without IS_E2E."); process.exit(1); }
  if (!status.geminiConfigured && !status.openaiConfigured) { console.error("No AI keys configured server-side."); process.exit(1); }

  const pool = parsePool(readFileSync(POOL, "utf8"));
  const poison = pool.find((r) => r.shouldAutoCount === false);
  const tires = pool.filter((r) => r.shouldAutoCount !== false);
  const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { cursor: 0, runs: 0 };

  const batch = [];
  for (let i = 0; i < COUNT && i < tires.length; i++) batch.push(tires[(state.cursor + i) % tires.length]);
  if (poison) batch.push(poison); // safety probe every run: must NOT auto-count

  console.log(`Tire decode monitor: ${COUNT} fresh tires + poison -> ${BASE}\n`);
  const per = [];
  for (const inp of batch) {
    try {
      const { data, wallMs } = await decode(inp.code);
      const decision = String((data.decision && data.decision.status) || "").toLowerCase();
      const prod = (data.results && data.results[0]) || {};
      const txt = `${prod.productName || ""} ${prod.brand || ""}`.toLowerCase();
      const brandHit = inp.expectedBrand ? txt.includes(inp.expectedBrand.toLowerCase()) : false;
      const ai = aiCallsForResponse(data);
      per.push({
        code: inp.code, brand: inp.expectedBrand, shouldAutoCount: inp.shouldAutoCount,
        decision, verified: decision === "verified", brandHit, wallMs,
        cached: !!(data.debug && data.debug.cached),
        fc: firecrawlCreditsForResponse(data), gemini: ai.gemini, openai: ai.openai,
      });
      console.log(`  ${inp.code} ${(inp.expectedBrand || "POISON").padEnd(15)} ${String(wallMs).padStart(6)}ms  ${decision.padEnd(13)} brand:${brandHit ? "Y" : "-"} ${data.debug && data.debug.cached ? "(cached)" : ""}`);
    } catch (e) {
      per.push({ code: inp.code, brand: inp.expectedBrand, shouldAutoCount: inp.shouldAutoCount, error: String(e), wallMs: 0, verified: false, brandHit: false, fc: 0, gemini: 0, openai: 0 });
      console.error(`  ${inp.code} ERROR ${e}`);
    }
  }

  const tireRows = per.filter((r) => r.shouldAutoCount !== false);
  const verified = tireRows.filter((r) => r.verified);
  const needsReview = tireRows.filter((r) => !r.verified);
  const brandCorrect = verified.filter((r) => r.brandHit);
  const falseAutoCounts = per.filter((r) => r.shouldAutoCount === false && r.verified).length;
  const lat = per.filter((r) => !r.cached && r.wallMs > 0).map((r) => r.wallMs);
  const fc = per.reduce((a, r) => a + (r.fc || 0), 0);
  const gem = per.reduce((a, r) => a + (r.gemini || 0), 0);
  const oai = per.reduce((a, r) => a + (r.openai || 0), 0);
  const estUsd = +(fc * RATE.firecrawlPerCredit + gem * RATE.geminiPerCall + oai * RATE.openaiPerCall).toFixed(3);

  const health = {
    date: DATE, base: BASE, freshTireCodes: tireRows.length,
    decodeSuccessPct: tireRows.length ? Math.round((verified.length / tireRows.length) * 100) : 0,
    needsReviewPct: tireRows.length ? Math.round((needsReview.length / tireRows.length) * 100) : 0,
    accuracyPct: verified.length ? Math.round((brandCorrect.length / verified.length) * 100) : 0,
    falseAutoCounts,
    latencyMs: { p50: pctl(lat, 50), p95: pctl(lat, 95), max: lat.length ? Math.max(...lat) : 0 },
    cost: { firecrawlCredits: fc, geminiCalls: gem, openaiCalls: oai, estUsd, note: "estimate, mini models" },
    perCode: per,
  };
  mkdirSync(OUTDIR, { recursive: true });
  writeFileSync(`${OUTDIR}/scan-health.json`, JSON.stringify(health, null, 2));
  state.cursor = (state.cursor + COUNT) % tires.length;
  state.runs = (state.runs || 0) + 1;
  writeFileSync(STATE, JSON.stringify(state, null, 2));

  console.log(`\n== Tire decode health (${DATE}) ==`);
  console.log(`fresh tires:      ${tireRows.length}`);
  console.log(`decode success:   ${health.decodeSuccessPct}%  (verified, no human)`);
  console.log(`needs review:     ${health.needsReviewPct}%  (target: only truly unfindable)`);
  console.log(`accuracy:         ${health.accuracyPct}%  (correct brand among verified)`);
  console.log(`false auto-count: ${falseAutoCounts}  (must be 0)`);
  console.log(`latency:          p50 ${health.latencyMs.p50}ms  p95 ${health.latencyMs.p95}ms  max ${health.latencyMs.max}ms`);
  console.log(`est cost:         $${estUsd}  (firecrawl:${fc} gemini:${gem} openai:${oai})`);
  console.log(`wrote ${OUTDIR}/scan-health.json`);
}
main();
