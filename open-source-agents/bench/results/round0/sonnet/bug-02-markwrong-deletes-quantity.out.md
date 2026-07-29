# Review: bug-02-markwrong-deletes-quantity

## Defect 1 (Critical): The counted quantity is deleted, not transferred, when a match is marked wrong

```ts
// 3. Remove the session count (product + now-deactivated aliases are kept for audit/repair).
if (count) {
  set((s) => ({ finalCounts: s.finalCounts.filter((c) => c.productId !== productId) }));
  emitAudit({ entityType: "InventoryCount", entityId: count.id, action: "count_removed", metadata: { productId, quantity: count.quantity, reason: "marked_wrong" } });
}
```

Failure scenario: a scanned code was matched (wrongly) to Product A and counted 5 times (`finalCounts` quantity = 5). The user calls `markWrong`. This block deletes the `finalCounts` row outright — the 5 units are gone from the session total. Step 4 reopens Needs Review for the code so a human can re-identify it, but nothing in this function re-creates a provisional count or carries the quantity of 5 onto the reopened review item. If the human later resolves the review to the correct Product B, Product B starts from 0, not 5 — the 5 physical scans that already happened are lost from any product's count. The audit log records `quantity: count.quantity` as metadata (so the number is *logged*), but logging it in an audit trail is not the same as it remaining in the live, user-facing session totals — the actual `finalCounts` ledger permanently loses those units.

This directly contradicts the surrounding domain invariant (also enforced elsewhere in this codebase) that a "wrong identity" correction must be a **quantity transfer**, never a delete: physical items were scanned and must keep counting toward *something* until a human re-resolves them. Here they count toward nothing.

## Defect 2 (Medium): Count is removed unconditionally even when reopening Needs Review fails to produce a code

```ts
const code = seenCodes[0] || product?.primaryBarcode || "";
const reviewId = code
  ? get().reopenNeedsReview(code, ...)
  : null;
```

If `seenCodes` is empty and the product has no `primaryBarcode`, `code` is `""`, so `reviewId` is `null` — no Needs Review item is (re)created at all for this correction. But step 3, which deletes the count, has already run unconditionally before this check. In that scenario the quantity is deleted and there isn't even a review row generated to eventually re-attach it to — the units are lost with no recovery path whatsoever, not even a manual one via the Needs Review queue.

## Defect 3 (Low/Design smell): Ordering makes the loss irreversible before the correction pipeline has a chance to succeed

The function deletes the count (step 3) and only afterward attempts `reopenNeedsReview` and the async `correctionRecheck` (steps 4–5). If `reopenNeedsReview` or `correctionRecheck` throw (they are called without a try/catch shown here, and `correctionRecheck` is awaited), the function may reject after the quantity has already been deleted from `finalCounts`, leaving the store in a state where the count is gone but no review record exists to recover it — the caller has no way to know the count silently vanished.

## Not a defect
- Deactivating approved aliases matching `seenCodes` (step 1) and un-verifying the product (step 1b) are both correct: they prevent the deterministic resolver from re-matching the same wrong product on the next scan of the same code, which is the intended firewall behavior.
- Resetting the matching `scanFeed` rows to `needs_review` (step 2) preserves scan history correctly, consistent with the delete-product code path.
- `correctionRecheck` is documented as "never auto-saves or counts," so its later AI recheck is not itself a source of the double-count/lost-count issue — it only affects the review's suggested identity, not the ledger.

## Recommendation
Replace the unconditional `filter` removal in step 3 with a transfer: move the deleted count's quantity onto a fresh provisional count row associated with the reopened Needs Review item (or the freed code), so the same "quantity survives a wrong-match correction" guarantee that presumably exists elsewhere in the ledger (e.g., delete-product transfer logic) also applies here.
