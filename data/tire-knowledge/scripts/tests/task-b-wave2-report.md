# Task B Wave-2 Report

## New brand count

- Original BRAND_SLUGS: 125 slugs
- Wave-2 additions: 95 slugs (deduped; `vitour` and `achilles`/`americus` already existed in the expanded list — the dedup block at module load removes duplicates automatically)
- Final BRAND_SLUGS after dedup: **216 slugs**

## harvested_brands.json seeding

`harvested_brands.json` was initialized with the **99 slugs** from `BRAND_SLUGS` that already produced rows in `tire_corpus_flat.csv` (evidence_level == `verified_db`). Mapping was done by matching each slug against the corpus brand column (with underscore-stripping normalization). The file is a sorted JSON list at the tire-knowledge root.

Brands NOT in the done list (will be fetched this run): **117 slugs**
- 26 from the original/expanded list that produced no rows (michelin, bridgestone, continental, gt_radial, etc.)
- 91 from the new wave-2 list

## Incremental logic

- `should_skip(slug, done_set) -> bool` — pure function, no I/O. Returns `True` if slug is already in the done set.
- `load_harvested_brands(root) -> set` — reads `harvested_brands.json`; returns empty set if missing or malformed (safe fallback).
- `save_harvested_brands(root, done)` — writes sorted JSON list atomically.
- `harvest()` calls `load_harvested_brands()` at startup, then for each slug calls `should_skip()` before fetching. A slug is added to done and saved to disk after: (a) a successful first-pass parse with >0 products, or (b) confirmed empty after retry (200 + 0 products both passes). Network errors / non-200 responses are NOT marked done so they retry next run.

## Test results

```
168 passed in 32.45s
```

- **154 pre-existing tests**: all green
- **14 new incremental tests** in `scripts/tests/test_upcitemdb_incremental.py`:
  - `test_should_skip_returns_true_when_slug_in_done_set`
  - `test_should_skip_returns_false_when_slug_not_in_done_set`
  - `test_should_skip_empty_done_set_never_skips`
  - `test_should_skip_exact_match_only`
  - `test_load_harvested_brands_missing_file_returns_empty_set`
  - `test_save_and_load_round_trip`
  - `test_save_produces_sorted_json_list`
  - `test_load_handles_empty_list`
  - `test_load_handles_malformed_json`
  - `test_load_handles_non_list_json`
  - `test_harvest_skips_brand_in_harvested_brands_json`
  - `test_harvest_network_error_not_marked_done`
  - `test_harvest_successful_slug_marked_done`
  - `test_harvest_empty_after_retry_marked_done`
- One pre-existing test (`test_harvest_idempotent`) was updated: the second-run assertion now checks `brands_skipped == 1` instead of `dup_skipped == trusted_added`, because incremental skipping takes precedence over ledger dedup on repeat runs.

## Live harvest NOT run

The harvest script was not executed. No network calls were made. The controller runs the live harvest separately.

## Concerns

- **~117 slugs to fetch**: at 4 s polite delay, first pass alone is ~7.8 min; plus retry pass for any zero-result brands. Normal.
- **`vitour` and `americus`/`achilles` dedup**: these slugs appeared in both the original expanded list and the wave-2 additions. The module-level dedup loop at load time handles this silently and correctly.
- **26 original slugs still not done** (michelin, bridgestone, continental, pirelli, cooper, general, bfgoodrich, hercules, kenda, gt_radial, venom_power, uniroyal, austone, carlisle, double_coin, firemax, jk_tyre, mickey_thompson, monsta, pace, sonar, starfire, tracmax, vee_rubber, vercelli, americus): these will be re-attempted this run. Most are major brands — they may 404 on upcitemdb or throttle heavily.
- Corpus integrity: existing 24,743 rows untouched. QA checkpoints remain active every 1,000 new trusted rows.
