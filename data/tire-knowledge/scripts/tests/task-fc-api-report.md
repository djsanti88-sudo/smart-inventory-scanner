# task-fc-api-report.md

## Status
COMPLETE. All tests pass. No live harvest run. No task registered.

## Files Created
- `scripts/upcitemdb_firecrawl_api_harvest.py` — Deliverable A: Firecrawl-proxy depth harvester
- `scripts/run_api_daily.bat` — Deliverable B: daily scheduler bat file
- `scripts/setup_api_schedule.py` — Deliverable B: prints Register-ScheduledTask commands (does NOT execute them)
- `scripts/tests/test_upcitemdb_fc_api.py` — 13 new offline tests

## Files Modified
- `scripts/upcitemdb_api_harvest.py` — Added lock helpers (acquire_lock_api, release_lock_api, write_lock_api) + lock discipline in `__main__` so scheduled runs and manual runs never write concurrently.

## Test Summary
```
uv run python -m pytest scripts/tests/ -q
218 passed, 23 warnings in 32.73s
```
- Pre-existing: 205 tests (all still pass, nothing broken)
- New: 13 tests in test_upcitemdb_fc_api.py (all pass)

Test coverage for Deliverable A:
1. Tire items written with evidence_level=verified_db; junk (NHL cover, no size) skipped; offset advances
2. Junk NHL Tire Cover item specifically skipped (no tire size -> parse_name returns {})
3. Per-brand efficiency floor: moves to next brand after 3 pages at <4 rows/credit
4. Global efficiency floor: stops harvest after 5 brands at <4 rows/credit overall
5. RuntimeError from Firecrawl (cap/kill switch) caught cleanly -- no re-raise
6. Lock acquired at start, released on exit; second acquire with fresh lock returns False
7. Stale lock (>90 min) is reclaimed automatically
8. api_progress.json offset advances correctly after a brand
9. Credit budget respected: stops when credits_spent >= budget
10. JSON parse fallback: HTML-wrapped JSON extracted via re.search(r'\{.*\}', stdout, re.S)
11. Item's OWN brand field used (not the search slug)
12. Duplicate barcode in same run deduped (dup_skipped++)
13. PRIORITY_BRANDS contains all 26 required brands

## Confirmations
- NO live network calls made during tests (firecrawl_client.call monkeypatched throughout)
- NO task registered (setup_api_schedule.py only prints commands)
- NO corpus modified (all tests use tmp_path isolated roots)
- Existing 205-test suite: 205 passed

## Concerns / Warnings
- SyntaxWarning in docstring: raw string r'\{' in a triple-quoted docstring comment triggers
  "invalid escape sequence" in Python 3.13. This is cosmetic (in a docstring, not live code)
  and does not affect functionality. The actual code uses r'\{.*\}' correctly.
- DeprecationWarning: datetime.utcnow() is deprecated in Python 3.12+. The existing codebase
  uses it throughout; this is consistent with the existing pattern. No behavioral impact.
- The lock helpers in upcitemdb_api_harvest.py use _api suffix names to avoid shadowing
  module-level names, since that file imports from run_once.py patterns but doesn't import
  run_once.py directly.
