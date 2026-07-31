# Task 4 repair-tool fix round 1

Verified against `REPAIRED_TIRE_DATABASE.db` using the tool's readonly, `fileMustExist` dry-run only. No authoritative write was run.

The current exact plan is 9 child rows and 21 child field writes: brand 6, model 9, size 6. It has 17 distinct blank parent writes: brand 5, model 7, size 5; four duplicate child fields agree with an already-planned parent field: brand 1, model 2, size 1. Thus all 21 child field outcomes have a matching parent field outcome without overwriting a nonblank parent.

Fresh blank counts are calculated in the plan before execution and projected after execution by subtracting only the exact planned blank updates. The repair tool now verifies required columns before any query for: tires, canonical_tire_products, remaining_blank_fill_audit, provenance, tire_part_numbers, tire_product_part_number_aliases, and tire_barcode_aliases. The real read-only fingerprint confirmed the expected production column names, including `tire_part_numbers.normalized_part_number` and `tire_product_part_number_aliases.canonical_product_id`.

Verification passed: Node temporary-DB suite (child and parent `RAISE(IGNORE)` cardinality rollback, audit rollback, dry-run byte identity, conflict/orphan/schema guards) and Vitest parity proof. The parity test compares the Node CLI normalizer to `normalizeTireSize` for every authoritative same-UID candidate donor size plus adversarial inputs.

## Review round 2

Fresh readonly evidence was `tires` blanks `{brand:1020, model:1111, size:1107}` and canonical-parent blanks `{brand:912, model:912, size:921}`. The exact write plan projects `{brand:1014, model:1102, size:1101}` for tires and `{brand:907, model:905, size:916}` for parents. The parent figures follow the observed `5/7/5` parent-write field split; they intentionally do not use the contradictory stale values in the reviewer brief. The authoritative execute guard now requires both maps, and the transaction re-reads observed post-write blanks before commit.

The Node parser now mirrors the shared `normalizeTireSize` metric, flotation, prefix-slash, and decimal-commercial grammar with the shared 22-44in / 4-18in / 8-30in flotation plausibility bounds. The Vitest parity corpus includes every authoritative candidate donor plus `99X12.50R20` and `11R99` counterexamples; it passed without drift.
