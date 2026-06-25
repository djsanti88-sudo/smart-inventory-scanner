# task-api-harvest-report.md

## What Was Built

`scripts/upcitemdb_api_harvest.py` — a FREE trial-API harvester for upcitemdb.com
that uses the search endpoint (`GET https://api.upcitemdb.com/prod/trial/search?s={query}&offset={n}`)
to page past the 45-item HTML cap and collect deeper brand coverage.

### Key components

- `PRIORITY_BRANDS` — niche/budget brands listed first (fortune, blackhawk, milestar,
  delinte, federal, nexen, nokian, toyo, falken, dunlop, ironman, hercules, kumho), then
  all remaining BRAND_SLUGS from upcitemdb_harvest.py, deduplicated and order-preserved.

- `search_brand(query, start_offset, budget)` — pages the trial search API starting at
  `start_offset`, sleeping `_SLEEP_S` (16 s) between calls. Stops when: offset >= total,
  items list is empty, or `budget` hits 0. Returns `(items, requests_used, total)`.

- `_item_to_identity(item, brand_slug)` — converts a raw API item dict to an identity
  dict. Calls `parse_name(title)` from upcitemdb_parse.py; skips the item if parse_name
  returns {} (not a tire or no valid size). Derives 12-digit UPC from `upc` field or by
  stripping the leading zero from a 13-digit EAN. Sets `evidence_level="verified_db"` and
  `source_url="https://api.upcitemdb.com/prod/trial/search"`.

- `harvest(root, daily_request_cap=95)` — loads `api_progress.json` for resume state,
  iterates PRIORITY_BRANDS, calls `search_brand` per brand, calls `write_rows` (dedup
  against ledger), saves progress + ledger after every brand, runs QA checkpoints, and
  returns a summary dict.

## Rate-Limit Handling

- `_SLEEP_S = 16.0` seconds between every API call (respects the ~2 calls/30 s burst limit
  with margin).
- `daily_request_cap` defaults to 95 (hard-stops before the 100/day trial limit). The
  `budget` counter is decremented per call; when it reaches 0 the harvest loop exits.
- `search_brand` accepts a `budget` argument and stops paging immediately when it hits 0.

## Resume Logic

- `api_progress.json` at the corpus root persists `{brand_slug: next_offset}` after
  each brand is processed.
- On the next `harvest()` call, `load_progress()` reads this file; `start_offset` for
  each brand is taken from the saved value (default 0 if not present).
- Brands whose offset reached `api_total` are stored at `api_total` and will return
  an empty page immediately on the next run (no wasted requests).
- Network errors do NOT advance the offset, so the brand will be retried on the next day.

## QA Checkpoints

- Every `_CHECKPOINT_EVERY = 2000` new trusted rows: `verify_corpus_full.py` runs via
  subprocess (free, deterministic). A FAIL halts the harvest immediately.
- `gemini_verify_sample.py --n 25` runs as advisory at the same threshold. Its exit code
  does NOT halt the harvest; results are logged to `run-log.md`.

## Test Results

Command: `uv run python -m pytest scripts/tests/ -q`

```
205 passed, 7 warnings in 32.60s
```

- 16 new tests in `test_upcitemdb_api_harvest.py` — all pass.
- 189 pre-existing tests — all still pass. Zero regressions.

### New tests cover

1. Tire items written with `evidence_level="verified_db"` and correct barcode.
2. Non-tire item (parse_name returns {}) is skipped.
3. Item with missing barcode is skipped.
4. Offset paging advances across multiple pages and stops at total.
5. Paging stops when API returns an empty items list.
6. `daily_request_cap` respected in `harvest()` (cap=2 stops after 2 calls).
7. `daily_request_cap` respected in `search_brand()` (budget=2).
8. `api_progress.json` is written with the advanced offset after harvest.
9. Resume: second run starts at the saved offset, never re-fetches offset 0.
10. EAN->UPC barcode derivation (strip leading zero from 13-digit EAN).
11. `_barcode_from_item` prefers upc over ean.
12. `_barcode_from_item` returns empty string when both fields are absent.
13. `harvest()` returns `audit_ok=True` with a clean temp corpus.
14. `PRIORITY_BRANDS` starts with niche brands in the correct order.
15. `PRIORITY_BRANDS` contains no duplicates.
16. All slugs from `BRAND_SLUGS` are present in `PRIORITY_BRANDS`.

## Confirmation: NOT Run Live

The harvester was NOT executed against the live upcitemdb API. All tests use
`monkeypatch` to replace `_search_page()` with fake responses. Zero network calls
were made. The corpus (26,241 rows) and all 205 tests are unchanged.

## Concerns / Notes

- The `utcnow()` deprecation warning is cosmetic (Python 3.12+ discourages it); it
  does not affect correctness. The same pattern is used in existing scripts.
- The 16-second sleep between calls means a full day's 95-request budget covers
  ~9-10 brands at ~10 pages each. Multi-day runs via `api_progress.json` resume
  correctly across sessions.
- The `_FORTUNE_UPC_2 = "840139631788"` test barcode used in pagination tests has
  the correct GTIN check digit (verified by the GTIN algorithm in validate.py).
