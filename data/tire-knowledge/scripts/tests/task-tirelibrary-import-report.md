# Task: Tirelibrary CSV Importer — Status Report

## Status
COMPLETE — all 24 new tests pass; all 218 pre-existing tests still pass (242 total).

## Files Created

### `scripts/tirelibrary_import.py`
Main importer module. Implements:

- **`detect_columns(header) -> dict`**
  Case-insensitive alias matching for all 10 logical fields. Aliases include CamelCase variants
  (`loadindex`, `speedrating`) in addition to the spec-required snake_case forms. Raises
  `ValueError` with a clear message listing headers seen if required fields are missing.

- **`row_to_identity(row, colmap) -> dict | None`**
  Builds tire identity dict from a raw CSV row. Derives 12-digit UPC from EAN-13 (strips leading
  `0`) when no UPC column is available. Falls back to `parse_name()` for size when no discrete
  size column is matched. Returns `None` on invalid/missing barcode or non-normalizable size.
  Sets `evidence_level='verified_vendor'`, `source_url='tirelibrary'`.

- **`import_csv(csv_path, root) -> dict`**
  Streams CSV, batches 500 rows at a time through `write_rows`, deduplicates via ledger, saves
  ledger, runs `audit(root)`. Prints progress every 10,000 rows. Returns summary dict with
  `total_rows, parsed, trusted, dup_skipped, backlog, rejected, audit_ok`.

- **`__main__`**
  argparse CLI: `uv run python scripts/tirelibrary_import.py <csv_path> [--root ROOT]`.
  Prints summary and AUDIT PASS/FAIL; exits 0 on pass.

### `scripts/tests/test_tirelibrary_import.py`
24 tests covering:
- `detect_columns`: finds all mapped fields, case-insensitive, raises on missing required,
  accepts EAN-only, handles gtin12 alias, manufacturer alias, pattern alias
- `row_to_identity`: valid row, EAN-only derivation, junk/invalid returns None,
  no barcode returns None, non-normalizable size returns None
- `import_csv` integration: valid rows trusted, correct evidence_level, EAN-only derives
  12-digit barcode, junk skipped, dedup on re-import, audit passes, ledger matches CSV,
  correct FLAT_COLS schema, all trusted rows pass GTIN check, no-MPN row goes to backlog
- Safety: asserts tmp_path != live corpus root

## Test Summary

```
242 passed, 23 warnings in 32.72s
```

- 218 pre-existing tests: ALL PASS (no regressions)
- 24 new tirelibrary import tests: ALL PASS

## Corpus Change Confirmation

NO changes to the live corpus (26,771 rows). All tests use `pytest tmp_path` as the corpus
root. The live `tire_corpus_flat.csv`, `coverage_ledger.json`, and related files are untouched.
The safety assertion `test_import_csv_no_corpus_modification_of_live_data` verifies this at
test runtime.

## Design Notes

### Routing for `verified_vendor` rows
`verified_vendor` evidence level routes through `is_trusted_identity()` (same as all non-`verified_db`
rows). This requires a valid GTIN + (MPN or SKU) + brand + model + size. Rows with an MPN in
the MPC/mpn column are trusted; rows without MPN go to backlog. This is correct behavior and
was not changed in `write_outputs.py`.

### `build_flat_row` — no modification needed
The `verified_vendor` level uses the MPN as the UID disambiguator (the `else` branch on line 41
of `write_outputs.py`). This is correct for vendor rows that carry a meaningful part number.

### CamelCase alias additions
The spec-required aliases (`load_index`, `speed_rating`) did not cover CamelCase CSV headers
common in Tirelibrary exports (`LoadIndex`, `SpeedRating`). Added `loadindex` and `speedrating`
aliases to cover these variants without breaking any existing functionality.

## Concerns / Known Limitations

1. **No-MPN rows go to backlog, not trusted**: this is intentional and correct per the existing
   routing rules. A Tirelibrary CSV with no MPC/mpn column will produce 0 trusted rows. The
   importer does not invent MPNs.

2. **EAN-13 not starting with '0'**: a pure 13-digit EAN (non-UPC) that doesn't start with `0`
   is stored as a 13-digit barcode (`barcode_type='ean'`), which passes `gtin_check_digit_valid`.
   The audit and ledger handle 13-digit barcodes correctly.

3. **`verified_vendor` is a new evidence_level string** not previously used in the corpus.
   It does not appear in any existing row, so there is no migration concern. The `audit_corpus.py`
   audit does not filter by evidence_level — it checks GTIN validity, size presence, and UID
   uniqueness only, all of which pass for verified_vendor rows.
