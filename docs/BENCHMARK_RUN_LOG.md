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
| _pending_ | seed_benchmark | 5 (+repeat,+unknown) | 0 | 0 | — | — | deterministic, mock path |
| _pending_ | real_limited_4 | 4 real | — | — | — | — | live providers, 4 real codes only |
