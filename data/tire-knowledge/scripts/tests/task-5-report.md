# Task 5: audit_corpus.py — Implementation Report

## File Created
- `scripts/audit_corpus.py` — corpus auditor per HARVESTER_PLAN_v4.md Task 5

## Verification Command & Output

```bash
cd /c/Users/djsan/inventory/data/tire-knowledge && uv run python scripts/audit_corpus.py
```

**Output:**
```
AUDIT PASS
EXIT_CODE=0
```

## What Was Verified

1. **Schema header check:** `tire_corpus_flat.csv` header matches `validate.FLAT_COLS` exactly (20 columns).
2. **Empty-but-header corpus state:** The corpus contains only the schema header row, zero data rows.
3. **Empty ledger state:** `coverage_ledger.json` has `total_trusted_barcode_rows=0` and empty seen-* arrays.
4. **Ledger-CSV count match:** With both at 0 data rows, ledger counts match the CSV (no mismatch error).
5. **No duplicate checks triggered:** No barcodes or UIDs to check for duplicates (no rows present).
6. **No GTIN/size validation errors:** No rows to validate (empty corpus is valid).
7. **Exit code:** Script exits with code 0 (success).

## Implementation Details

The script:
- Imports `validate` (for `FLAT_COLS` and `gtin_check_digit_valid`) and `ledger` (for `load_ledger`, `counts_match_csv`).
- Defines `audit(root: str) -> tuple[bool, list[str]]` per spec.
- Reads the flat CSV header and compares to `FLAT_COLS` exactly.
- Scans all data rows checking for duplicate barcodes, duplicate `canonical_product_uid`, invalid GTINs, and missing size fields.
- Loads the ledger and calls `counts_match_csv` to verify row counts match.
- Returns `(True, [])` on success, `(False, [errors])` on failure.
- CLI `__main__` prints "AUDIT PASS" or "AUDIT FAIL", lists errors, and exits 0/1.
- Includes Windows UTF-8 safety guard in `__main__`.

## Concerns

None. The auditor is ready and correctly validates an empty-but-schema-correct corpus.
