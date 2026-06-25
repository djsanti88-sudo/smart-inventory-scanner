# Task 1: Harden validate.py — Report

## Files Created/Modified

### Created:
- `scripts/tests/test_validate.py` — 6 test cases covering barcode type labels, trusted identity validation, and fixture integrity
- `scripts/tests/fixtures/tire_c_1.csv` — 100-row fixture copied verbatim from source (C:\Users\djsan\Downloads\TIRE_C_1 (1).CSV)
- `seed/TIRE_C_1.csv` — identical copy for seeding

### Modified:
- `scripts/validate.py`
  - Changed `barcode_type_label` len-14 return from `"gtin"` to `"gtin14"`
  - Appended `is_trusted_identity(row: dict) -> tuple[bool, str]` function implementing trusted bar: valid GTIN + (MPN or SKU) + brand + model + size_canonical + size_compact

## Test Results

### pytest command:
```
cd C:\Users\djsan\inventory\data\tire-knowledge
pytest scripts/tests/test_validate.py -v
```

### Full output:
```
============================= test session starts =============================
platform win32 -- Python 3.13.13, pytest-9.0.3, pluggy-1.6.0
collected 6 items

scripts/tests/test_validate.py::test_barcode_type_label_aligned PASSED   [ 16%]
scripts/tests/test_validate.py::test_trusted_identity_accepts_full_row PASSED [ 33%]
scripts/tests/test_validate.py::test_trusted_identity_rejects_missing_mpn_and_sku PASSED [ 50%]
scripts/tests/test_validate.py::test_trusted_identity_rejects_bad_gtin PASSED [ 66%]
scripts/tests/test_validate.py::test_every_fixture_barcode_is_valid_gtin PASSED [ 83%]
scripts/tests/test_validate.py::test_every_fixture_size_normalizes PASSED [100%]

============================== 6 passed in 0.02s ==============================
```

### Self-test (validate.py):
```
=== validate.py self-test ===
  size 225/65R17            -> (225/65R17,2256517) ✓
  size P225/65R17           -> (P225/65R17,2256517) ✓
  size LT275/70R18          -> (LT275/70R18,2757018) ✓
  size 33x12.50R20          -> (33x12.50R20,33125020) ✓
  size 295/75R22.5          -> (295/75R22.5,29575225) ✓
  size 11R22.5              -> (11R22.5,11225) ✓
  gtin 036000291452: True ✓
  gtin 012345678905: True ✓
  gtin 000000000000: False ✓
  gtin 1234: False ✓
  gtin 4006381333931: True ✓

ALL TESTS PASSED
```

## Implementation Details

### barcode_type_label change:
Changed line 31 from `return "gtin"` to `return "gtin14"` for 14-digit barcodes. This aligns the label with industry standard terminology.

### is_trusted_identity function:
Implements the specification's trusted-bar requirement:
- Valid GTIN check digit (via existing `gtin_check_digit_valid`)
- At least one of: manufacturer_part_number OR retailer_sku
- Required fields: brand, model, size_canonical, size_compact
- Returns tuple: (bool, reason_string) where reason is empty string on success

### Fixture verification:
- Fixture: 100 rows, all with valid GTIN barcodes
- All rows normalize to valid size formats (no size failures)
- Leading zeros preserved in all barcode strings

## Concerns

None. All tests pass; self-test passes; fixture is valid and complete.
