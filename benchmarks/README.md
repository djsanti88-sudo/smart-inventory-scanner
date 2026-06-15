# Phase 1 decode benchmark

Measures the REAL decode engine (speed, lookup path, cache behavior, Firecrawl/AI usage, cost) against
a list of barcodes. It hits the running dev server's `/api/ai-lookup` - the same route the app uses - so
it exercises the fast path, the deep parallel fallback, the decode cache, and honest diagnostics.

## How to run

1. Put your real barcodes in `phase1_100_codes.csv`. Only the `code` column is required. Fill
   `expectedName` / `expectedBrand` where you can - that is the only way accuracy can be claimed.
2. Start the dev server with real keys (in another terminal):  `npm run dev`
   - Confirm `GET http://localhost:3000/api/ai-lookup` shows `firecrawlConfigured: true` and `e2e: false`.
3. Run:  `npm run benchmark`
   - Sequential by default (simulates real scanning). Optional: `node scripts/benchmark-decodes.ts --concurrency=3`.
   - Cache proof: it re-runs successful codes and confirms the 2nd call is `cached` with zero spend.

## Cost guard (hard)

The runner tracks Firecrawl credits (1 search + 1 per opened candidate, or the API's reported value) and
**stops at 400 credits** for the run. It also stops if a single decode looks abnormal. Cached results do
not re-spend, so a repeat benchmark run is cheap.

## Input columns

`code` (required), `expectedName`, `expectedBrand`, `expectedCategory`, `expectedSku`,
`expectedSource`, `notes`.

- With `expectedName`/`expectedBrand`: accuracy is graded pass / partial / fail / needs_manual_review.
- Without ground truth: results are `resolved_without_ground_truth` / `needs_review` / `failed` / `cached`
  and are NEVER counted as accuracy successes.

## Outputs (written to `benchmarks/results/`)

- `phase1_benchmark_results.csv` - per-code rows
- `phase1_benchmark_results.json` - full machine-readable run
- `phase1_benchmark_summary.md` - speed / path / accuracy breakdown
- `phase1_cost_estimate.md` - Firecrawl + AI usage and cost-per-100 / per-1,000 projections

`phase1_100_codes.csv` ships seeded with 4 real codes for harness validation. Replace/extend it with
your ~100 real barcodes for the full benchmark.
