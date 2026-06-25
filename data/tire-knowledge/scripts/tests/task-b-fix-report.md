# Task B Fix Report — MPN Data-Quality Bug

## Fix Summary

**Bug:** upcitemdb_harvest.py was storing the barcode (or `mpn_barcode` compound) in the
`manufacturer_part_number` field to keep `canonical_product_uid` unique across rows that
shared brand/model/size but had different barcodes. This polluted the MPN field with
non-MPN data.

**Fix (3 parts):**

### Part 1 — `scripts/write_outputs.py` `build_flat_row`
- `manufacturer_part_number` now always holds the clean model code (`mpn` from parse, may be "").
- For `evidence_level == "verified_db"` rows, `uid_key = identity["barcode"]` is passed to
  `v.make_uid()`, making the UID unique per barcode without touching the MPN field.
- Retailer rows (no `evidence_level` / `verified_1src_strong`) keep exactly the prior behavior
  (uid from mpn). No retailer rows were affected.

### Part 2 — `scripts/upcitemdb_harvest.py`
- Removed the `{mpn}_{barcode}` / barcode-as-mpn hack (lines ~186-189).
- Clean parsed `mpn` (model code, may be "") is now passed through unchanged.
- UID uniqueness is fully delegated to `build_flat_row`.

### Part 3 — Cleanup + Re-harvest
- Added `rebuild_ledger_from_corpus(root)` to `scripts/ledger.py` which rebuilds all four
  seen-sets and `total_trusted_barcode_rows` from the current CSV.
- Dropped all 910 `verified_db` rows from `tire_corpus_flat.csv` (21,978 retailer rows preserved).
- Rebuilt `coverage_ledger.json` from cleaned corpus (21,978 rows).
- Re-ran `uv run python scripts/upcitemdb_harvest.py` — 910 rows re-added with clean MPNs.

## Cleanup Result

| Phase | Row Count |
|-------|-----------|
| Before cleanup | 22,888 |
| After dropping verified_db | 21,978 |
| After re-harvest | 22,888 |

## Re-harvest Counts

- brands_hit: 46
- brands_missed: 2 (gt_radial 404, venom_power 404)
- products_parsed: 1,202
- trusted_added: 910
- dup_skipped: 265
- rejected: 0
- backlog: 27
- audit_ok: True

## Test Results

- New test added: `test_verified_db_two_barcodes_same_model_get_different_uids_and_clean_mpn`
  - Verifies two verified_db rows with same brand/model/size but different barcodes both write
    as trusted, get different UIDs, and both have `manufacturer_part_number == ""`.
- Full suite: **144 passed, 0 failed** (143 original + 1 new).

## QA Verification

`uv run python scripts/verify_corpus_full.py`:
- ALL DETERMINISTIC CHECKS PASS (22,888 rows)
- 0 duplicate barcodes
- 0 duplicate canonical_product_uid
- 0 invalid GTIN check digits
- 0 URL mismatches, 0 conflicts

`uv run python scripts/audit_corpus.py`: **AUDIT PASS**

## MPN Pollution Check

```
verified_db rows 910 | mpn==barcode (should be 0): 0
```

**mpn==barcode count: 0** (was 580 before fix)

## Retailer Row Safety

- Retailer rows before: 21,978
- Retailer rows after: 21,978
- No retailer rows were modified or dropped.

## Concerns

None. The fix is contained to the two harvest scripts and ledger. Retailer rows and their
UIDs are unchanged. The 27 backlog rows are from upcitemdb entries that lack a valid
size canonical parse — unchanged from the original harvest behavior.
