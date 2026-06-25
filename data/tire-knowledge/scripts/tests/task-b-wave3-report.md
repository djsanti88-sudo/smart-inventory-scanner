# Wave-3 Harvest Report

**Date:** 2026-06-23

## What Was Done

- Appended 62 new brand slugs (wave-3 Wikipedia-derived, bicycle brands excluded) to `BRAND_SLUGS` in `scripts/upcitemdb_harvest.py`.
- Dedup loop at module load automatically handled ~20 slugs that were already present from prior waves (aeolus, blacklion, capitol, cooper, deestone, dextero, double_coin, durun, goform, grenlander, headway, hifly, jinyu, kenda, kingstar, marshal, maxxis, sunfull, sunwide, fronway).
- 168 tests: all passed before and after the slug additions.

## Harvest Run Results

| Metric | Value |
|---|---|
| brands_skipped (already done) | 160 |
| brands_hit_new (new trusted rows added) | 0 |
| trusted_added this wave | 0 |
| brands_missed (429/404, will retry next run) | 118 |
| qa_aborted | False |
| audit_ok | True |

**Why 0 hits:** upcitemdb.com returned HTTP 429 (rate-limited) for nearly all wave-3 slugs immediately after the wave-2 run. Per harvester design, 429s are MISS (not zero-product), so the new slugs are NOT marked done in `harvested_brands.json` — they will be automatically attempted on the next free run.

## Corpus Status

| Metric | Value |
|---|---|
| Corpus total rows | 26,241 |
| verified_db rows | unchanged (see verify output) |
| New rows added this wave | 0 |

## QA / Verification

- `verify_corpus_full.py` VERDICT: **ALL DETERMINISTIC CHECKS PASS**
- All 11 deterministic checks: OK
- 168 pytest tests: PASS

## Concerns

- All wave-3 brand slugs got 429'd this run. They remain unharvested but are queued for the next run (not in `harvested_brands.json`).
- Some slugs also 404'd (omni_united, vee_rubber, three_a, jk_tyre, gt_radial, venom_power, mickey_thompson, double_coin) — these will also retry but may simply not exist on upcitemdb.
- No data corruption. Corpus is fully intact.
