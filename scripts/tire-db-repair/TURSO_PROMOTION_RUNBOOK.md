# Turso promotion and rollback runbook

This runbook is for an owner-approved production promotion only. Local `file:` proof does not
authorize a Turso write.

## Required write freeze

Before `backup`, pause every other Turso writer and keep it paused until the promotion is accepted
or rollback recovery is complete. This includes `scripts/pilot-apply-turso.mjs`, scheduled tire or
retail harvest/import jobs, repair scripts, and any manual SQL console work. Record the operator,
UTC start time, intended staging artifact, and promotion timestamp (`PROMOTE_TS`).

Do not rely on the manifest digest as a substitute for this freeze. The CLI compares the bound
backup manifest before `stage`, `verify`, and immediately before `promote`, but a writer could still
land after that final comparison and before the rename transaction. If any writer cannot be paused,
do not promote.

## Supervised promotion

1. Confirm the five reviewed staging SQL files and approved part-number drops are the intended
   artifact. Set a unique `PROMOTE_TS` and retain the command output.
2. With the freeze active, run `backup`, then inspect its manifest. It must contain all five swapped
   tables: `tires`, `tire_part_numbers`, `tire_product_part_number_aliases`,
   `canonical_tire_products`, and `provenance`. On a first promotion the final three must be
   recorded as `ABSENT`, not as empty tables. The command also prints `manifest SHA-256: <digest>`.
   Record that exact digest in the operator record or another location outside the mutable backup
   and staging directories before continuing; do not derive it again later from `manifest.json`.
3. Run `stage`, then `verify`, bound to that exact manifest and independently recorded digest:
   `--manifest <path-to-manifest.json> --expected-manifest-sha256 <recorded-digest>`. Use the same
   flags for `promote`. The CLI refuses a missing or mismatched digest, including when a manifest
   was rewritten to match edited source-artifact hashes. Stop on any failure; do not edit or
   regenerate staging files after backup without starting again at backup and recording its new digest.
4. Run `promote` while the freeze remains active, passing the same `--manifest` and
   `--expected-manifest-sha256` values. Preserve the manifest, schema dump, JSONL dumps,
   command output, and the `*_old_<PROMOTE_TS>` rollback tables.
5. Review the CLI's all-five-table post-swap checks. Only then either accept the promotion and end
   the freeze, or begin rollback while writers remain paused.

## Rollback and recovery of concurrent writes

`rollback --ts <PROMOTE_TS>` renames the currently-live tables to
`*_failed_promotion_<PROMOTE_TS>` and restores `*_old_<PROMOTE_TS>`. It does not capture or replay
deltas. Keep the write freeze active through rollback and recovery.

If a writer ran despite the freeze, the rows it wrote after promotion are retained only in the
corresponding `*_failed_promotion_<PROMOTE_TS>` tables. Do not drop those tables. First identify
the write window from logs and compare each failed-promotion table with the restored live table by
its primary key:

- `tires(barcode)`
- `tire_part_numbers(normalized_part_number)`
- `tire_product_part_number_aliases(canonical_product_id, normalized_part_number)`
- `canonical_tire_products(canonical_product_id)`
- `provenance(id)`

Export the candidate delta, classify every row as a safe replay, a duplicate, or a conflict, and
have a reviewer approve conflict resolution. Replay only approved rows using a separately reviewed,
idempotent reconciliation script in a maintenance window; never use blind `REPLACE INTO`, because
it can overwrite the restored pre-promotion record. Re-run the lookup and count checks after replay,
archive the failed-promotion tables and reconciliation evidence, and only then end the freeze.

If the timestamp is uncertain, stop. The CLI intentionally refuses to guess when multiple
`*_old_<ts>` generations exist; inspect the saved manifest and operator record rather than selecting
a generation by table-name order.
