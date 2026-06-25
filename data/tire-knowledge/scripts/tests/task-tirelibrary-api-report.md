# Task: Tirelibrary API Harvester — Completion Report

## Status
COMPLETE. All tests pass. Live harvester was NOT run.

## Test Counts
- Before: 242 passed
- After:  283 passed (+41 new tests, 0 regressions)

## Files Created
- `scripts/tirelibrary_api_harvest.py` — Resumable rate-limited harvester (new)
- `scripts/tests/test_tirelibrary_api_harvest.py` — 41 offline unit tests (new)

## Files Modified
- `scripts/write_outputs.py` — Routing change: `verified_vendor` now uses the same no-MPN trusted path as `verified_db`.
- `scripts/tests/test_tirelibrary_import.py` — Updated `test_import_csv_row_without_mpn_goes_to_backlog` (renamed to `test_import_csv_row_without_mpn_is_trusted`) to reflect the intentional routing change.

## Routing Change Detail
In `write_outputs.route_with_reason`: `ev in ("verified_db", "verified_vendor")` now both call `v.is_trusted_db_identity` (valid GTIN + brand + model + size — no MPN required).

In `write_outputs.build_flat_row`: `uid_key` is now `identity["barcode"]` when `evidence_level in ("verified_db", "verified_vendor")` so two rows with the same brand/model/size but different barcodes get different UIDs.

`verified_1src_strong` and rows with no `evidence_level` continue to use `v.is_trusted_identity` (requires MPN or SKU).

## Write Function and Ledger Calls Used
- `write_outputs.write_rows(identities, paths, led, run_id)` — called per batch of 200 detail results
- `ledger.load_ledger(ledger_path)` — loaded once on startup
- `ledger.seen_barcode(led, barcode)` — used inside `write_rows` for dedup
- `ledger.record_row(led, flat)` — records each trusted row inside `write_rows`
- `ledger.save_ledger(led, ledger_path)` — called after each page's batch write

## Checkpoint
`outputs/tirelibrary_progress.json` — saved after every catalog page. Contains: `queue` (ordered brand list), `idx` (current brand index), `page` (current page within brand), `stats` (seen/barcoded/upc/ean/written/dup/no_barcode/bad_size/errors). Kill/resume loses at most one page of detail calls.

## Live Harvester NOT Run
Confirmed. No network calls were made. The harvester was built and unit-tested only.

## Concerns
1. The `tirelibrary_import.py` CSV importer also uses `evidence_level="verified_vendor"` — it now routes rows without MPN to TRUSTED instead of backlog. This is the correct new behavior per spec, but callers should be aware that MPN is no longer a gate for vendor-sourced barcodes with valid GTINs.
2. The API uses `requests` + `certifi`. If `certifi` is not in the venv, add it: `uv add certifi requests`.
3. Rate limit is documented at 60/min. The harvester sleeps 1.05s between detail calls (~57/min). At 308,420 total tires with ~39% barcoded coverage (~120K detail calls expected to yield barcodes), full harvest will take ~35 hours across all brands.
