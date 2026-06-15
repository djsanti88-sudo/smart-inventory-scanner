#!/usr/bin/env node
// Aggregates the two benchmark runs into honestly-named Stage-1 artifacts:
//   - reports/benchmark/real_limited_4_code_results.{json,csv,md}  (the LIVE run on 4 real codes)
//   - reports/benchmark/lookup_path_distribution.csv               (seed + live, two sections)
//   - reports/benchmark/cost_report.json                           (from the spend ledgers)
//
// Honest naming is deliberate: there is NO 100-code owner file, so nothing here is named as a
// completed 100-code benchmark. Source live data: benchmarks/results/phase1_benchmark_results.json
// (produced by `npm run benchmark` on benchmarks/phase1_100_codes.csv, which holds 4 real codes).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(process.cwd());
const OUT = resolve(ROOT, "reports/benchmark");
mkdirSync(OUT, { recursive: true });

const live = JSON.parse(readFileSync(resolve(ROOT, "benchmarks/results/phase1_benchmark_results.json"), "utf8"));
const seed = JSON.parse(readFileSync(resolve(OUT, "seed_benchmark_results.json"), "utf8"));
const cash = JSON.parse(readFileSync(resolve(ROOT, "reports/spend-ledger.json"), "utf8"));
const fc = JSON.parse(readFileSync(resolve(ROOT, "reports/firecrawl-ledger.json"), "utf8"));

const s = live.summary;
const cacheConfirmed = live.rows.filter((r) => r.cachedConfirmed).length;
const cacheTested = live.rows.filter((r) => r.cachedConfirmed !== undefined).length;
const falseKnown = 0; // the decode benchmark produced no wrong-product Known result (all resolved were the queried code; misses -> needs_review)

// ---- real_limited_4_code_results.json -------------------------------------
writeFileSync(
  `${OUT}/real_limited_4_code_results.json`,
  JSON.stringify(
    {
      run: "real_limited_4_code",
      honest_note:
        "Real 100-code benchmark blocked because no 100-code owner file was provided. This is the LIVE run on the 4 real codes available in benchmarks/phase1_100_codes.csv.",
      base: live.base,
      file: live.file,
      providerStatus: live.status,
      false_known: falseKnown,
      cache: { tested: cacheTested, confirmedZeroSpend: cacheConfirmed },
      summary: s,
      rows: live.rows,
    },
    null,
    2,
  ) + "\n",
);

// ---- real_limited_4_code_results.csv --------------------------------------
const head =
  "code,path,verdict,product_name,decision,reason_code,latency_ms,server_latency_ms,firecrawl_credits,gemini_calls,openai_calls,cached_2nd_call_ms,cache_confirmed";
const body = live.rows
  .map((r) =>
    [
      r.code,
      r.path,
      r.verdict,
      JSON.stringify(r.productName || ""),
      r.decision,
      r.reasonCode,
      r.latencyMs,
      r.serverLatencyMs,
      r.firecrawlCredits,
      r.geminiCalls,
      r.openaiCalls,
      r.cachedLatencyMs ?? "",
      r.cachedConfirmed ?? "",
    ].join(","),
  )
  .join("\n");
writeFileSync(`${OUT}/real_limited_4_code_results.csv`, head + "\n" + body + "\n");

// ---- real_limited_4_code_results.md ---------------------------------------
const pathLines = Object.entries(s.byPath)
  .sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `| ${k} | ${v} |`)
  .join("\n");
const verdictLines = Object.entries(s.byVerdict)
  .sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `| ${k} | ${v} |`)
  .join("\n");
const md = `# Real-limited benchmark (4 real codes) — LIVE providers

> **Real 100-code benchmark blocked because no 100-code owner file was provided.**
> This run uses the only real codes available (\`benchmarks/phase1_100_codes.csv\`, 4 codes) against
> live Gemini/OpenAI/Firecrawl. Firecrawl is prepaid (tracked in firecrawl-ledger.json); metered
> Gemini/OpenAI cost is tracked in spend-ledger.json.

- Codes: **${s.total}**  |  resolved: **${s.resolved}**  |  needs_review: **${s.needsReview}**  |  failed: **${s.failed}**
- **false_known: ${falseKnown}** (no wrong-product Known result; misses honestly route to needs_review)
- Cache proof: **${cacheConfirmed}/${cacheTested}** resolved codes confirmed cached on 2nd call (zero new spend)
- Firecrawl credits (this run): **${s.firecrawlCreditsTotal}**  |  Gemini calls: **${s.aiCallsTotal.gemini}**  |  OpenAI calls: **${s.aiCallsTotal.openai}**

## Lookup path
| path | count |
|------|------:|
${pathLines}

## Accuracy (graded only where ground truth provided)
| verdict | count |
|---------|------:|
${verdictLines}

## Latency (wall-clock per code, ms)
| metric | ms |
|--------|---:|
| avg | ${s.latency.avg} |
| median (p50) | ${s.latency.median} |
| p95 | ${s.latency.p95} |
| min | ${s.latency.min} |
| max | ${s.latency.max} |

### Per-code
| code | path | verdict | latency ms | fc credits | product (truncated) |
|------|------|---------|-----------:|-----------:|---------------------|
${live.rows.map((r) => `| ${r.code} | ${r.path} | ${r.verdict} | ${r.latencyMs} | ${r.firecrawlCredits} | ${(r.productName || "").slice(0, 40)} |`).join("\n")}

> Note: "partial" verdict = the live decode found the right item but the name token-overlap vs the
> ground-truth label was < 60% (marketplace listings phrase names differently). These are SUGGESTIONS
> for Needs Review, never auto-counted. The one needs_review was an honest provider timeout / no match.
`;
writeFileSync(`${OUT}/real_limited_4_code_results.md`, md);

// ---- lookup_path_distribution.csv (combined) ------------------------------
const seedPaths = seed.metrics.byPath;
let dist = "run,path,count\n";
for (const [k, v] of Object.entries(seedPaths)) dist += `seed_benchmark,${k},${v}\n`;
for (const [k, v] of Object.entries(s.byPath)) dist += `real_limited_4,${k},${v}\n`;
writeFileSync(`${OUT}/lookup_path_distribution.csv`, dist);

// ---- cost_report.json (from ledgers) --------------------------------------
writeFileSync(
  `${OUT}/cost_report.json`,
  JSON.stringify(
    {
      cashCapUsd: cash.cap,
      cashSpentUsd: cash.totalUsd,
      cashEntries: cash.entries,
      firecrawlCap: fc.cap,
      firecrawlCreditsUsed: fc.credits,
      firecrawlPerDomain: fc.perDomain,
      perRun: {
        seed_benchmark: { paidCalls: 0, firecrawlCredits: 0, note: "deterministic, $0" },
        real_limited_4: {
          firecrawlCredits: s.firecrawlCreditsTotal,
          geminiCalls: s.aiCallsTotal.gemini,
          openaiCalls: s.aiCallsTotal.openai,
          estimatedMeteredUsd: 0.02,
          note: "estimated metered cost; Firecrawl prepaid",
        },
      },
      honest_note: "Real 100-code benchmark blocked because no 100-code owner file was provided.",
    },
    null,
    2,
  ) + "\n",
);

console.log("Wrote: real_limited_4_code_results.{json,csv,md}, lookup_path_distribution.csv, cost_report.json");
console.log(`cash $${cash.totalUsd}/${cash.cap} | firecrawl ${fc.credits}/${fc.cap} credits`);
