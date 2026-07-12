# Phase 1 Report - Decode Benchmark (2026-06-14)

## Executive summary

The Phase 1 benchmark **harness is built, unit-tested, and validated live** against the real
`/api/ai-lookup` engine. Because no 100-code list existed and I will not invent live barcodes, this run
is an **honest harness validation on the 4 real codes we have ground truth for** - NOT the full 100-code
benchmark. The full 100-code run is one command (`npm run benchmark`) away once you drop your real codes
into `benchmarks/phase1_100_codes.csv`.

The validation already proves the engine's behavior: the fast path is **~85-101ms / 0 credits** for
barcode-DB hits, the open-web fallback resolves a hard code in **~14s / 7 credits**, a true not-found
fails honestly in ~40s, and the **cache is perfect (3/3 repeats served in 20-31ms, 0 spend)**.

## Benchmark result (4 real codes)

| code | path | latency | accuracy | Firecrawl | product |
|------|------|--------:|----------|----------:|---------|
| 070330645936 | fast_page_fetch | 85ms | partial | 0 | "Exclusive Smokes Bic Lighter Texas" (BIC) |
| 6977228152610 | fast_page_fetch | 101ms | partial | 0 | "Phatoil Lavender Essential Oil 100ml" (PHATOIL) |
| 810118139604 | firecrawl_fallback | 14,274ms | partial | 7 | "Wholesale Acrylic Paint Markers Set, 24 Metallic Colors" (KINGART) |
| 710154236681 | needs_review | 40,073ms | needs_review | 7 | (honest not-found - no ground truth) |

"partial" here = the **correct product** with a verbose listing-title vs my short expected name (the
grader is deliberately conservative; none are wrong).

## Speed

| metric | ms |
|--------|---:|
| average | 13,633 |
| median (p50) | **101** |
| p95 | 40,073 |
| min | 85 |
| max | 40,073 |

p50 of 101ms shows the fast path is genuinely instant; the average is dragged up by the one fallback
(14s) and the one true not-found (40s). On a real 100-code retail mix (most codes in barcode DBs) the
average will be far lower - the full run will quantify it.

## Lookup path breakdown

fast_page_fetch **2** | firecrawl_fallback **1** | needs_review **1** | failed **0**. Resolved 3/4.

## Cost estimate (this run)

- **Firecrawl credits: 14** (7 for the fallback resolve + 7 reserved/spent on the not-found search).
- **Gemini calls: 3 | OpenAI calls: 3** (mostly on the fallback codes; all grounded AI calls timed out
  and contributed **no** wins - page-fetch + Firecrawl did the resolving).
- Per-1,000 projection is **deliberately not extrapolated from 4 codes** - the 2-of-4 fallback rate is
  not representative of a real retail mix. The full 100-code run produces the trustworthy per-1,000.

## Cache savings (proven)

3/3 resolved codes re-scanned were served from cache in **20-31ms with 0 Firecrawl + 0 AI**. Repeat
scans of any decoded code are effectively free.

## Provider diagnostics summary

Honest per-provider status throughout: page-fetch ok/no_match, gemini/openai `timeout` (10s fast / 25s
deep), firecrawl ok/no_match with credit count. The generic "no provider returned a usable product"
message is gone; needs-review rows show the specific reason.

## Bugs found and fixed (caught by the validation run)

1. **Cache-confirmation false negative** - a cached payload still carries the original credit number, so
   the runner wrongly flagged a real cache hit as "NOT cached". Fixed: confirmation keys off
   `debug.cached` (a hit spends nothing by definition). Re-run: 3/3 confirmed.
2. **Firecrawl cost under-count on cap-abort** - when the fallback hard-cap fired, the Firecrawl finder's
   credit count was lost (showed 0). Fixed: reserve worst-case credits up front, refine to actual.
   Re-run: the not-found code correctly shows 7 credits.

## Findings (no fix required now - the benchmark doing its job)

- **Fast path depends on barcode-DB availability.** 6977228152610 failed under back-to-back load
  (go-upc rate-limited us after heavy session use) but resolved in 101ms on the clean run. Phase 2's
  preloaded catalog removes this dependency for tires.
- **Grounded AI providers consistently time out** (10s/25s) and won nothing here; Firecrawl + page-fetch
  carried every resolution. Worth considering trimming grounded AI from the fallback later (separate
  tuning decision - not changed now).

## Files changed / added

- new: `src/services/benchmark/benchmarkAnalysis.ts` (+ test), `scripts/benchmark-decodes.ts`,
  `benchmarks/{phase1_100_codes.csv, phase1_100_codes.sample.csv, README.md}`,
  `e2e/phase1-benchmark.spec.ts`, `PHASE2_TIRE_DB_PLAN.md`, this report.
- changed: `src/app/api/ai-lookup/route.ts` (debug cost fields), `package.json` (`benchmark` script).
- outputs: `benchmarks/results/phase1_benchmark_{results.csv,results.json,summary.md,cost_estimate.md}`.

## Tests run (exit codes)

- `npx vitest run` -> **313 passed** (exit 0)
- `npx tsc --noEmit` -> clean (exit 0)
- `npx eslint src e2e scripts` -> clean (exit 0)
- `npx next build` -> success
- `npx playwright test` -> **11 passed** (exit 0)

## Proof

- Headless benchmark: `benchmarks/results/` (csv/json/summary.md/cost_estimate.md).
- Playwright UI proof: `e2e/proof/phase1-100-code-benchmark.png`.
- Live: real `/api/ai-lookup` with `firecrawlConfigured:true`, `e2e:false`.

## Caps / usage

- Firecrawl used: **yes** (14 credits, far under the 400 hard cap). Gemini Flash used: yes (primary).
  OpenAI mini used: yes (fallback). No cap hit. No runaway.

## Phase 2 recommendation

Phase 2 is **planned, not started** (PHASE2_TIRE_DB_PLAN.md). Recommended when you're ready:
- **Pilot size: start 100** (Tier-1 brands) to measure real per-record cost of catalog-page harvesting
  before scaling.
- **Full target: 5,000 first, measured path to 10,000** (build 5,000, measure real-scan miss rate,
  expand only for proven gaps).
- Critical cost insight: tires are not in consumer barcode DBs, so naive per-barcode decode would cost
  ~7 credits each (~35k for 5,000). Phase 2 uses bulk catalog-page harvesting instead - the pilot
  measures the real (much lower) per-record cost.

## Known limitations

- The "100-code benchmark" numbers await your real list; current numbers are a 4-code validation.
- Per-1,000 cost is not extrapolated from 4 codes (unrepresentative mix) - the full run provides it.
- AI dollar figures are call-count-based estimates; exact $ needs token accounting + your Firecrawl rate.

## Next exact owner decision

1. Drop ~100 real barcodes (at least the `code` column) into `benchmarks/phase1_100_codes.csv`, then I
   run the full benchmark (or you run `npm run benchmark`). 2. Separately, say **"approve Phase 2"** to
   start the 100-record tire pilot. Phase 2 does not run until then.
