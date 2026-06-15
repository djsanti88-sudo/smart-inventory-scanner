// Phase 1 decode benchmark runner. Hits the running dev server's /api/ai-lookup (the SAME route the app
// uses) so it exercises the real fast path, deep parallel fallback, decode cache, and honest diagnostics.
//
// Usage:
//   npm run dev            # terminal 1 (real keys, e2e off)
//   npm run benchmark      # terminal 2  -> reads benchmarks/phase1_100_codes.csv
//   node scripts/benchmark-decodes.ts --file=benchmarks/x.csv --concurrency=1 --no-cache-test
//
// Cost guard: tracks Firecrawl credits and HARD-STOPS at 400 for the run. Cached results never re-spend.
// Pure analysis lives in src/services/benchmark/benchmarkAnalysis.ts (unit-tested); this file is I/O only.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import {
  parseCsv,
  toInputRows,
  classifyPath,
  accuracyVerdict,
  firecrawlCreditsForResponse,
  aiCallsForResponse,
  summarize,
} from "../src/services/benchmark/benchmarkAnalysis.ts";

const BASE = process.env.SMOKE_BASE_URL || "http://localhost:3000";
const FIRECRAWL_CREDIT_CAP = Number(process.env.BENCHMARK_FIRECRAWL_CAP || 400);
const OUT_DIR = "benchmarks/results";

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : def;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

const FILE = arg("file", "benchmarks/phase1_100_codes.csv");
const CONCURRENCY = Math.max(1, Number(arg("concurrency", "1")));
const CACHE_TEST = !hasFlag("no-cache-test");
const CACHE_TEST_LIMIT = Number(arg("cache-test-limit", "10"));

function codeType(c) {
  if (/^\d{12}$/.test(c)) return "upc_a";
  if (/^\d{13}$/.test(c)) return "ean_13";
  if (/^\d{14}$/.test(c)) return "gtin_14";
  if (/^(X0|B0)[0-9A-Z]{8}$/i.test(c)) return "vendor_label";
  return /^\d+$/.test(c) ? "numeric_sku" : "alpha_sku";
}

async function decode(code) {
  const started = Date.now();
  const r = await fetch(BASE + "/api/ai-lookup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "decode", rawCode: code, cleanCode: code, codeType: codeType(code), confidenceThreshold: 0.85, allowImageSuggestions: true }),
  });
  const data = await r.json();
  return { data, wallMs: Date.now() - started };
}

function fmt(n) {
  return new Intl.NumberFormat("en-US").format(Math.round(n));
}

async function main() {
  console.log("=== Phase 1 decode benchmark ===");
  console.log("base:", BASE, "| file:", FILE, "| concurrency:", CONCURRENCY, "| cache-test:", CACHE_TEST);

  // Clean-env precheck: server reachable, live (not e2e), keys present.
  let status;
  try {
    status = await (await fetch(BASE + "/api/ai-lookup")).json();
  } catch (e) {
    console.error("Cannot reach the dev server at", BASE, "- start it with `npm run dev`.", String(e));
    process.exit(1);
  }
  if (status.e2e) { console.error("Server is in IS_E2E mock-only mode. Unset IS_E2E and restart for a real benchmark."); process.exit(1); }
  if (!status.geminiConfigured && !status.openaiConfigured) { console.error("No AI keys configured server-side. Add them to .env.local and restart."); process.exit(1); }
  if (!status.firecrawlConfigured) console.warn("WARNING: firecrawlConfigured=false -> open-web fallback is disabled; fallback-only products will be needs_review.");

  const rows = toInputRows(parseCsv(readFileSync(FILE, "utf8")));
  if (rows.length === 0) { console.error(`No codes in ${FILE}. Add at least the 'code' column.`); process.exit(1); }
  console.log(`Loaded ${rows.length} codes.\n`);

  const results = [];
  let firecrawlCreditsTotal = 0;
  let stoppedEarly = null;

  // First pass (sequential by default; optional small pool).
  let idx = 0;
  async function worker() {
    while (idx < rows.length) {
      if (firecrawlCreditsTotal >= FIRECRAWL_CREDIT_CAP) { stoppedEarly = `Firecrawl credit cap (${FIRECRAWL_CREDIT_CAP}) reached`; return; }
      const myIdx = idx++;
      const input = rows[myIdx];
      try {
        const { data, wallMs } = await decode(input.code);
        const path = classifyPath(data);
        const acc = accuracyVerdict(data, input);
        const credits = firecrawlCreditsForResponse(data);
        firecrawlCreditsTotal += credits;
        const ai = aiCallsForResponse(data);
        const row = {
          code: input.code,
          path,
          verdict: acc.verdict,
          verdictReason: acc.reason,
          productName: (data.results && data.results[0] && data.results[0].productName) || "",
          decision: (data.decision && data.decision.status) || "",
          reasonCode: data.reasonCode || "",
          latencyMs: wallMs,
          serverLatencyMs: (data.debug && data.debug.latencyMs) || 0,
          cached: !!(data.debug && data.debug.cached),
          firecrawlCredits: credits,
          geminiCalls: ai.gemini,
          openaiCalls: ai.openai,
        };
        results[myIdx] = row;
        console.log(`[${myIdx + 1}/${rows.length}] ${input.code}  ${path.padEnd(20)} ${String(wallMs).padStart(6)}ms  ${acc.verdict}  fc:${credits}  "${row.productName.slice(0, 48)}"`);
      } catch (e) {
        results[myIdx] = { code: input.code, path: "failed", verdict: "failed", verdictReason: String(e), productName: "", decision: "error", reasonCode: "request_error", latencyMs: 0, serverLatencyMs: 0, cached: false, firecrawlCredits: 0, geminiCalls: 0, openaiCalls: 0 };
        console.error(`[${myIdx + 1}/${rows.length}] ${input.code}  REQUEST ERROR: ${String(e)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const firstPass = results.filter(Boolean);

  // Cache proof: re-run up to N resolved codes, confirm 2nd call is cached + spends nothing.
  if (CACHE_TEST && !stoppedEarly) {
    const resolvedPaths = ["fast_page_fetch", "gemini_flash", "openai_mini", "firecrawl_fallback", "ai_deep_fallback"];
    const toRetest = firstPass.filter((r) => resolvedPaths.includes(r.path)).slice(0, CACHE_TEST_LIMIT);
    console.log(`\n--- Cache proof: re-running ${toRetest.length} resolved codes ---`);
    for (const r of toRetest) {
      try {
        const { data, wallMs } = await decode(r.code);
        // A cache HIT short-circuits before any provider call, so new spend is 0 by definition. (The
        // cached payload still carries the ORIGINAL credit number, so don't infer spend from it.)
        const cachedHit = !!(data.debug && data.debug.cached);
        const newSpend = cachedHit ? 0 : firecrawlCreditsForResponse(data);
        r.cachedLatencyMs = wallMs;
        r.cachedConfirmed = cachedHit;
        console.log(`  ${r.code}  2nd call ${String(wallMs).padStart(5)}ms  cached:${cachedHit}  newSpend:${newSpend}  -> ${cachedHit ? "CONFIRMED" : "NOT cached"}`);
      } catch (e) {
        r.cachedConfirmed = false;
        console.error(`  ${r.code} cache re-run error: ${String(e)}`);
      }
    }
  }

  // ---- summary + outputs ----
  const summary = summarize(firstPass);
  summary.aiCallsTotal = {
    gemini: firstPass.reduce((a, r) => a + (r.geminiCalls || 0), 0),
    openai: firstPass.reduce((a, r) => a + (r.openaiCalls || 0), 0),
  };
  const n = firstPass.length || 1;
  const perCodeCredits = summary.firecrawlCreditsTotal / n;
  const cacheConfirmed = firstPass.filter((r) => r.cachedConfirmed).length;

  mkdirSync(OUT_DIR, { recursive: true });

  // CSV
  const csvHead = "code,path,verdict,productName,decision,reasonCode,latencyMs,serverLatencyMs,cached,firecrawlCredits,geminiCalls,openaiCalls,cachedLatencyMs,cachedConfirmed,verdictReason";
  const csvBody = firstPass.map((r) => [r.code, r.path, r.verdict, JSON.stringify(r.productName), r.decision, r.reasonCode, r.latencyMs, r.serverLatencyMs, r.cached, r.firecrawlCredits, r.geminiCalls, r.openaiCalls, r.cachedLatencyMs ?? "", r.cachedConfirmed ?? "", JSON.stringify(r.verdictReason)].join(",")).join("\n");
  writeFileSync(`${OUT_DIR}/phase1_benchmark_results.csv`, csvHead + "\n" + csvBody + "\n");

  // JSON
  writeFileSync(`${OUT_DIR}/phase1_benchmark_results.json`, JSON.stringify({ base: BASE, file: FILE, status, stoppedEarly, summary, rows: firstPass }, null, 2));

  // Summary markdown
  const pathLines = Object.entries(summary.byPath).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v} |`).join("\n");
  const verdictLines = Object.entries(summary.byVerdict).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v} |`).join("\n");
  const slowLines = summary.slowest.map((s, i) => `| ${i + 1} | ${s.code} | ${s.path} | ${fmt(s.latencyMs)} |`).join("\n");
  const L = summary.latency;
  const summaryMd = `# Phase 1 benchmark summary

- Source file: \`${FILE}\`  |  codes tested: **${summary.total}**  |  generated against ${BASE}
${stoppedEarly ? `- **STOPPED EARLY: ${stoppedEarly}**\n` : ""}
## Lookup path breakdown
| path | count |
|------|------:|
${pathLines}

Resolved: **${summary.resolved}** / ${summary.total}  |  Needs Review: **${summary.needsReview}**  |  Failed: **${summary.failed}**

## Accuracy (honest - only graded when ground truth was provided)
| verdict | count |
|---------|------:|
${verdictLines}

## Latency (wall-clock per code, ms)
| metric | ms |
|--------|---:|
| average | ${fmt(L.avg)} |
| median (p50) | ${fmt(L.median)} |
| p95 | ${fmt(L.p95)} |
| min | ${fmt(L.min)} |
| max | ${fmt(L.max)} |

### Slowest 10
| # | code | path | ms |
|--:|------|------|---:|
${slowLines}

## Cache proof
- resolved codes re-run: **${firstPass.filter((r) => r.cachedConfirmed !== undefined).length}**
- confirmed cached on 2nd call (zero spend): **${cacheConfirmed}**

## Provider usage
- Firecrawl credits (this run): **${summary.firecrawlCreditsTotal}**
- Gemini calls: **${summary.aiCallsTotal.gemini}**  |  OpenAI calls: **${summary.aiCallsTotal.openai}**
`;
  writeFileSync(`${OUT_DIR}/phase1_benchmark_summary.md`, summaryMd);

  // Cost estimate markdown (Firecrawl concrete; AI as call-counts with a clearly-labeled estimate band)
  const GEM = Number(process.env.EST_GEMINI_FLASH_USD_PER_CALL || 0.0008);
  const OAI = Number(process.env.EST_OPENAI_MINI_USD_PER_CALL || 0.002);
  const aiUsd = summary.aiCallsTotal.gemini * GEM + summary.aiCallsTotal.openai * OAI;
  const per1000Credits = perCodeCredits * 1000;
  const costMd = `# Phase 1 cost estimate

> Firecrawl credits are measured. AI dollar figures are ESTIMATES (per-call placeholders; set
> EST_GEMINI_FLASH_USD_PER_CALL / EST_OPENAI_MINI_USD_PER_CALL to your real rates). Real $ needs token
> accounting - this run reports call COUNTS, which are exact.

## This run (${summary.total} codes)
- Firecrawl credits: **${summary.firecrawlCreditsTotal}**  (avg **${perCodeCredits.toFixed(2)}**/code)
- Gemini calls: **${summary.aiCallsTotal.gemini}**  |  OpenAI calls: **${summary.aiCallsTotal.openai}**
- Estimated AI $ (placeholder rates): **$${aiUsd.toFixed(4)}**

## Projected
- Firecrawl credits per 100 codes: **${(perCodeCredits * 100).toFixed(0)}**
- Firecrawl credits per 1,000 codes: **${per1000Credits.toFixed(0)}**
- NOTE: cache means repeat lookups of the same code cost **0**. Projections assume all-new codes
  (worst case). Real catalogs with repeats cost less.

## Cache savings
- ${cacheConfirmed} codes confirmed cached on 2nd lookup -> those repeats cost **0** Firecrawl + **0** AI.
`;
  writeFileSync(`${OUT_DIR}/phase1_cost_estimate.md`, costMd);

  console.log("\n=== DONE ===");
  console.log(`codes: ${summary.total} | resolved: ${summary.resolved} | needs_review: ${summary.needsReview} | failed: ${summary.failed}`);
  console.log(`latency avg ${fmt(L.avg)}ms | p50 ${fmt(L.median)}ms | p95 ${fmt(L.p95)}ms | max ${fmt(L.max)}ms`);
  console.log(`firecrawl credits: ${summary.firecrawlCreditsTotal} | gemini calls: ${summary.aiCallsTotal.gemini} | openai calls: ${summary.aiCallsTotal.openai}`);
  console.log(`cache confirmed: ${cacheConfirmed}`);
  if (stoppedEarly) console.log(`STOPPED EARLY: ${stoppedEarly}`);
  console.log(`outputs -> ${OUT_DIR}/`);
}

main().catch((e) => { console.error("benchmark failed:", e); process.exit(1); });
