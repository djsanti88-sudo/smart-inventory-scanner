# Task 4 repair-tool fix round 1

Verified against `REPAIRED_TIRE_DATABASE.db` using the tool's readonly, `fileMustExist` dry-run only. No authoritative write was run.

The current exact plan is 9 child rows and 21 child field writes: brand 6, model 9, size 6. It has 17 distinct blank parent writes: brand 5, model 7, size 5; four duplicate child fields agree with an already-planned parent field: brand 1, model 2, size 1. Thus all 21 child field outcomes have a matching parent field outcome without overwriting a nonblank parent.

Fresh blank counts are calculated in the plan before execution and projected after execution by subtracting only the exact planned blank updates. The repair tool now verifies required columns before any query for: tires, canonical_tire_products, remaining_blank_fill_audit, provenance, tire_part_numbers, tire_product_part_number_aliases, and tire_barcode_aliases. The real read-only fingerprint confirmed the expected production column names, including `tire_part_numbers.normalized_part_number` and `tire_product_part_number_aliases.canonical_product_id`.

Verification passed: Node temporary-DB suite (child and parent `RAISE(IGNORE)` cardinality rollback, audit rollback, dry-run byte identity, conflict/orphan/schema guards) and Vitest parity proof. The parity test compares the Node CLI normalizer to `normalizeTireSize` for every authoritative same-UID candidate donor size plus adversarial inputs.
