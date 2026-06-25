# Task 11 Report — run_once.py Orchestrator + Preflight (Gate 1)

## Files Created
- `scripts/run_once.py` — Main orchestrator entry point
- `scripts/tests/test_run_once.py` — Unit tests (14 tests, all mocked, 0 credits)

## Unit Test Output
```
============================= test session starts =============================
platform win32 -- Python 3.13.13, pytest-9.0.3
collected 14 items

scripts/tests/test_run_once.py::test_preflight_reclaims_stale_lock PASSED
scripts/tests/test_run_once.py::test_preflight_fails_on_fresh_lock PASSED
scripts/tests/test_run_once.py::test_preflight_reclaims_unparseable_lock PASSED
scripts/tests/test_run_once.py::test_preflight_passes_with_no_lock PASSED
scripts/tests/test_run_once.py::test_preflight_fails_when_kill_switch_active PASSED
scripts/tests/test_run_once.py::test_preflight_fails_when_credits_unreadable PASSED
scripts/tests/test_run_once.py::test_write_and_release_lock PASSED
scripts/tests/test_run_once.py::test_release_lock_noop_when_no_lock PASSED
scripts/tests/test_run_once.py::test_make_run_id_format PASSED
scripts/tests/test_run_once.py::test_lock_is_stale_with_old_timestamp PASSED
scripts/tests/test_run_once.py::test_lock_is_stale_with_fresh_timestamp PASSED
scripts/tests/test_run_once.py::test_lock_is_stale_with_bad_timestamp PASSED
scripts/tests/test_run_once.py::test_lock_is_stale_with_missing_key PASSED
scripts/tests/test_run_once.py::test_preflight_all_pass_happy_path PASSED

14 passed in 0.09s
```

## Preflight-Only Output
```
=== Preflight checks ===
  [OK] root directory is writable
  [OK] firecrawl credits readable: 153 remaining
  [OK] policy loaded: PER_RUN_CAP=15, TOTAL_CAP=50, total_spent=7
  [OK] kill switch not active
  [OK] no lock file present

[OK] All preflight checks passed.
[INFO] --preflight-only flag set. Exiting without spending credits.
```
Exit code: 0. Credits spent: 0.

## --max-credits 1 Smoke Run Output
```
=== Preflight checks ===
  [OK] root directory is writable
  [OK] firecrawl credits readable: 153 remaining
  [OK] policy loaded: PER_RUN_CAP=15, TOTAL_CAP=50, total_spent=7
  [OK] kill switch not active
  [OK] no lock file present

[OK] All preflight checks passed.

[INFO] Lock acquired. run_id=run_20260623_012323
[INFO] Queue has 1370 rows ready.

[INFO] Starting harvest: max_credits=1
[INFO] Harvest complete: {'models_scraped': 1, 'trusted_added': 4, 'backlog': 0, 'rejected': 0, 'dup_skipped': 0, 'credits_spent': 1, 'rows_per_credit': 4.0, 'remaining_credits': 152}

[OK] AUDIT PASS
[INFO] run-log.md updated. current_run_progress.json written.
[INFO] Lock released (harvest.lock removed).

=== Run summary ===
  run_id: run_20260623_012323
  models_scraped: 1
  trusted_added: 4
  backlog: 0
  rejected: 0
  dup_skipped: 0
  credits_spent: 1
  rows_per_credit: 4.0
  remaining_credits: 152
  audit_ok: True
```

## Credits Summary
- Task credits spent: 1 (preflight-only = 0; --max-credits 1 run = 1)
- Remaining credits after task: 152 (was 153 before run)
- firecrawl_policy.json total_credits_spent: 8 (was 7)

## Proof Checklist
- [x] harvest.lock is ABSENT after run (confirmed: `Test-Path` returned False)
- [x] run-log.md got a new block appended (confirmed: tail shows run_20260623_012323 block)
- [x] current_run_progress.json updated (confirmed: audit_ok=true, result fields correct)
- [x] AUDIT PASS in run
- [x] 14 unit tests pass, all mocked, 0 credits
- [x] --preflight-only exits 0 with 0 credits
- [x] Lock released in finally: block (crash-safe)

## Concerns / Notes
- rows_per_credit=4.0 this run vs 10.8 from Task 9. Variance is normal — individual model pages vary in product count. The firewall cap enforces the single-credit stop cleanly.
- 1370 rows remain queued. Future batches: `uv run python scripts/run_once.py --max-credits N` (up to PER_RUN_CAP=15 per run, TOTAL_CAP=50 lifetime).
