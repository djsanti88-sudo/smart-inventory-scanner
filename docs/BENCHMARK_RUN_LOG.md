# Benchmark Run Log

Tracks each benchmark run for the Smart Inventory Scanner lookup pipeline.

## Honest naming (this task)
- **Real 100-code benchmark: BLOCKED** — no 100-code owner barcode file was provided. A template lives
  at `data/benchmark/100_code_template.csv`; drop a real file there to unblock it.
- Available real codes: **4** (`benchmarks/phase1_100_codes.csv`) — used for the *real-limited-4* run.
- Deterministic seed benchmark uses the 5 seed products in `src/seed/seedData.ts` (no spend).

## Caps
- Cash (Gemini/OpenAI/barcode APIs): tracked in `reports/spend-ledger.json`, hard cap $30 (benchmark sub-cap ~$5).
- Firecrawl: tracked in `reports/firecrawl-ledger.json`, prepaid, cap 500 credits / 50 pages per domain.

## Runs

| date | run | codes | metered $ | firecrawl credits | false_known | dup-prevention | notes |
|------|-----|-------|-----------|-------------------|-------------|----------------|-------|
| 2026-06-15 | seed_benchmark | 14 (5 products, 6 aliases, 2 repeats, 1 unknown) | $0.00 | 0 | 0 | 100% | deterministic resolver+inventory+CSV; 8/8 gated test passes; CSV round-trip PASS |
| 2026-06-15 | real_limited_4 | 4 real | ~$0.02 (est) | 14 | 0 | n/a (decode path) | live Gemini/OpenAI/Firecrawl; 3 resolved / 1 honest needs_review; cache 3/3 zero-spend on repeat |

## Result
- **Real 100-code benchmark: BLOCKED** — no 100-code owner file provided (template at `data/benchmark/100_code_template.csv`).
- Seed benchmark gates: false_known=0, duplicate prevention=100%, alias resolution 6/6, CSV round-trip PASS, $0 spend.
- Live 4-code benchmark: no wrong-product Known result; repeat scans served from cache at $0; metered spend ~$0.02 of $5 sub-cap; Firecrawl 14/500 credits.
- Artifacts: `reports/benchmark/seed_benchmark_*`, `reports/benchmark/real_limited_4_code_results.*`, `lookup_path_distribution.csv`, `cost_report.json`.
