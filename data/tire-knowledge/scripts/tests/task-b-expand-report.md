# Task B Expand Report

## Brand Count
- **Final BRAND_SLUGS list: 120 slugs** (48 original + 72 new; deduplicated in-place at module load).

## Changes Made

### `scripts/upcitemdb_harvest.py`

1. **BRAND_SLUGS expanded** from 48 to 120 entries covering all major and budget tire brands
   (goodyear through zeta). A dedup guard at module load removes any future accidental overlap.

2. **Rate-limit resilience**
   - `_SLEEP_S` raised from 1.5 s to **4.0 s** (first pass).
   - After the first pass, any brand that returned a 200 response but **0 products** is collected
     into `zero_first_pass[]`.
   - A **30-second pause** (`_RETRY_PAUSE_S`) is inserted before the retry pass begins.
   - Retry pass uses **6 s** between requests (`_RETRY_SLEEP_S`).
   - A brand still returning 0 on retry is treated as genuinely empty / absent and counted as
     `brands_missed`.  A brand that failed outright (HTTP error / None) on the first pass is NOT
     retried (that's a hard miss, not a throttle).

3. **QA checkpoint every 1000 new rows**
   - Pure function `crossed_1000(prev, now) -> bool` detects when `cumulative_trusted` crosses
     a new multiple of 1000.
   - `run_qa_checkpoint(cumulative, root, log_path)` launches `verify_corpus_full.py` via
     `subprocess` (`uv run python scripts/verify_corpus_full.py`), captures stdout/stderr,
     extracts the corpus total and PASS/FAIL verdict, appends a `## QA CHECKPOINT @ N rows`
     block to `run-log.md`, and returns `True` (pass) or `False` (fail).
   - If `run_qa_checkpoint` returns `False` the harvest loop sets `qa_aborted = True` and
     breaks immediately — no further brands are fetched.
   - `fetch()` signature simplified to `fetch(slug)` — sleep is now the caller's responsibility
     inside `_process_slug`, which keeps the monkeypatch contract in the existing tests intact.

## Test Results

```
uv run python -m pytest scripts/tests/ -q
154 passed in 28.36s
```

- All 5 pre-existing offline harvest tests: **PASS**
- 10 new `crossed_1000` unit tests: **PASS**

### New `crossed_1000` test cases
| Test | Scenario | Expected |
|------|----------|----------|
| exact_boundary | 0 -> 1000 | True |
| crosses_over | 999 -> 1001 | True |
| large_jump_2000 | 1500 -> 2100 | True |
| same_band | 1000 -> 1500 | False |
| below_first | 500 -> 800 | False |
| zero_delta | 1000 -> 1000 | False |
| decreasing | 2000 -> 1500 | False |
| multiple_boundaries | 0 -> 3500 | True |
| exactly_2000 | 1999 -> 2000 | True |
| equal_at_1000 | 1000 -> 1000 | False |

## Live Harvest
**NOT run.** The controller will run `uv run python scripts/upcitemdb_harvest.py` in background.

## Concerns
- Estimated first-pass time at 4 s/brand: ~8 min for 120 brands (plus retry pass if throttled).
- `verify_corpus_full.py` reads `tire_corpus_flat.csv` at module level (top-of-file `rows =
  list(csv.DictReader(open(...)))`). This means each checkpoint run takes as long as the CSV
  has grown. On a large corpus this adds wall time but does not affect correctness.
- The `fetch()` function no longer sleeps internally — sleep is in `_process_slug`. This is
  only relevant if `fetch()` is called directly outside of `_process_slug`; there are no such
  call sites in the codebase.
