# Barcode Enricher — Task Report

## Status
DONE — all tests pass, no live calls made, no corpus changes.

## Files Created
- `scripts/barcode_enrich.py` — full enricher with `build_brand_prefixes`, `prefix_matches`, `verify_candidate`, daily cap, resumable state, pacing, QA gate, batch flush, CLI.

## Files Modified
- `scripts/write_outputs.py` — added `"verified_ai"` to the no-MPN trusted route in `route_with_reason` and `build_flat_row` (uid_key uses barcode for `verified_ai`).
- `scripts/qa_corpus_full.py` — added `"verified_ai"` to `_EVIDENCE_OK`. Vendor URL check was already scoped to `verified_vendor` only — no change needed there.

## Tests Created
- `scripts/tests/test_barcode_enrich.py` — 34 new offline tests.

## Test Counts
- Before: 329 passed
- After: 363 passed (329 existing + 34 new)
- Regressions: 0

## Live Call Confirmation
No live Gemini or network calls in tests. All test functions inject `_fetch` or `_transport` callables. `_date_str` is injectable so no `datetime.now()` in test code.

## Launch Command

```
uv run python scripts/barcode_enrich.py
```

Options:
- `--max-calls N` — limit calls this run (default: remaining daily cap of 1400)
- `--model gemini-2.5-flash` — model to use
- `--brands nokian,toyo,falken` — optional brand allowlist override

State files (auto-created in `outputs/`):
- `enrich_daily.json` — today's UTC call count; resets at midnight UTC
- `enrich_processed.json` — set of tire ids already attempted; enables resume
- `ai_barcode_candidates.csv` — rejected candidates for manual review
