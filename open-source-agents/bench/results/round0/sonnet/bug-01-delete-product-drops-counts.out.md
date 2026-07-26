# Review: bug-01-delete-product-drops-counts

## Defect 1 (Critical): Deleting a product silently destroys its counted quantity instead of transferring it

```ts
finalCounts: s.finalCounts.filter((c) => !targetIds.has(c.productId)),
```

The function snapshots `targetCounts` into `backup.counts` (good, for Undo/downloadable backup), but the live `finalCounts` rows for the deleted product(s) are simply filtered out of state — not transferred to any other row, not re-attached to anything.

Failure scenario: a user scans a barcode 12 times during a session (quantity = 12 in `finalCounts`), then deletes that product. The 12-unit count vanishes from the active session's totals. If the deleted product's identity was wrong and the code should really belong to a *different* product, there is no path in this function that moves the 12 units onto a new/placeholder row — the count is simply gone. Anyone reconciling "how many physical items did we scan today" against `finalCounts` after a delete will see a number lower than the number of scans that actually happened, which directly violates a "scan events must remain accounted for" invariant implied by the function's own docstring ("per-session counted quantities that must always stay consistent" with the scan feed).

Contrast with the scan-feed handling in the same function: `scanFeed` rows are not deleted, only detached (`matchedProductId: null`, `status: "needs_review"`) so history is preserved and the code can be reworked. `finalCounts` gets no equivalent treatment — it's an outright delete. That asymmetry is itself evidence of the bug: the code carefully preserves scan history but discards the aggregated quantity that history is supposed to justify.

## Defect 2 (High): Freed codes can be immediately re-scanned into a fresh product with no continuity, but old scanFeed rows referencing the deleted product become orphaned "needs_review" entries with quantityDelta data that no longer sums to anything

Because `finalCounts` for the deleted product is gone but the `scanFeed` rows that produced those counts still exist (now with `matchedProductId: null`), a later reconciliation between "sum of quantityDelta for this code in scanFeed" and "current finalCounts for this code" will disagree — the feed events look like they should have contributed quantity, but no live count row reflects it anymore. This is the concrete mechanism behind "drops counts": the scan feed retains a record that scans happened, while the authoritative counted-quantity ledger has erased the very rows those scans built.

## Not a defect
- Un-verifying the product and deactivating aliases so the deterministic resolver stops matching it is correct and intentional (comment explains it well).
- Dropping `catalog`/`shopOverrides` entries so a future scan re-decodes is a reasonable design choice, not a bug per se.
- The audit emission loop iterates `targetProducts` (captured before any mutation) so it reports pre-delete alias counts correctly — this part is fine.

## Recommendation
Before filtering `finalCounts`, the deleted product's quantity should either (a) be transferred to a residual/placeholder count row keyed by the freed code, consistent with how the codebase's ledger law treats "wrong identity" cases (transfer, never delete), or (b) explicitly zero-and-log an audit event stating quantity was discarded, if that is truly the intended product behavior — but silently filtering with no transfer and no audit trail of the lost quantity is the bug as shown.
