# Task B - verified_db Tier Report

## Changes Made

### scripts/validate.py
- Added `is_trusted_db_identity(row)` function immediately before `is_trusted_identity`.
- Requires: valid GTIN + brand + model + size_canonical + size_compact. No MPN/SKU required.

### scripts/write_outputs.py
- `route_with_reason(identity)`: Added early branch — if `identity.get("evidence_level") == "verified_db"`, calls `v.is_trusted_db_identity(identity)` instead of `v.is_trusted_identity`. Rejected/backlog logic identical (rejected if reason contains "gtin" or "size", else backlog). All other identities use the original path unchanged (mpn->manufacturer_part_number merge + is_trusted_identity).
- `build_flat_row(identity, run_id)`: Changed `"evidence_level": "verified_1src_strong"` to `"evidence_level": identity.get("evidence_level") or "verified_1src_strong"`. All other logic unchanged.

## GTIN Validity of 840139631771
**VALID** — check digit 1 is correct. Used directly in the test.

## Test Output (scripts/tests/test_write_outputs.py -v)
```
tests/test_write_outputs.py::test_route PASSED
tests/test_write_outputs.py::test_write_is_idempotent PASSED
tests/test_write_outputs.py::test_route_parse_url_style_with_sku_is_trusted PASSED
tests/test_write_outputs.py::test_route_mpn_only_is_trusted_after_merge PASSED
tests/test_write_outputs.py::test_verified_db_row_is_trusted_without_mpn_or_sku PASSED
tests/test_write_outputs.py::test_non_db_row_still_needs_mpn_or_sku PASSED
tests/test_write_outputs.py::test_rejected_and_backlog_are_written_to_files PASSED
7 passed in 0.03s
```

## Full Suite
```
138 passed in 0.20s
```
136 original tests all still green. 2 new tests added.

## Concerns
None. Changes are narrowly scoped: the new `verified_db` branch in `route_with_reason` only activates when `evidence_level == "verified_db"` is explicitly set; all other rows take the unchanged original path.
