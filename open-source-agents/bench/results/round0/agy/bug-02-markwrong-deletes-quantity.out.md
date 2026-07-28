# Code Review: bug-02-markwrong-deletes-quantity

## Overview
Review of `markWrong` in `src/stores/scanStore.ts`. The function is intended to un-link a wrong product identity match from a scanned barcode/alias and return the code to the review queue.

---

## Defect 1: Unconditional Deletion of `finalCounts` Row (Wiping Inventory Quantity)

### Concrete Failure Scenario
A product has recorded inventory counts in `finalCounts` (e.g., 10 units counted from valid base barcode scans, and 2 units scanned via a newly flagged bad alias). The user flags the bad alias using `markWrong`. 

While Step 2 correctly un-links only the scan feed events matching `seenCodes`, Step 3 completely purges the product's count entry from `finalCounts`:
```ts
if (count) {
  set((s) => ({ finalCounts: s.finalCounts.filter((c) => c.productId !== productId) }));
  ...
}
```
This wipes out all 12 units of recorded inventory quantity for `productId` from `finalCounts` rather than recalculating or adjusting the quantity for the remaining valid scans.

### Root Cause
Line 63 filters out `c.productId !== productId` entirely, treating `markWrong` as a complete count deletion instead of deducting the quantity associated with the flagged code/alias.

---

## Defect 2: Indiscriminate Alias Deactivation when `seenCodes` is Empty

### Concrete Failure Scenario
`markWrong` is called on a product that has no matching events in `scanFeed` and no entries in `count.aliasesSeen` (resulting in `seenCodes = []`). 

In Step 1, line 22 checks:
```ts
(seenCodes.length === 0 || seenCodes.includes(a.cleanCode))
```
Because `seenCodes.length === 0` evaluates to `true`, the condition matches every approved alias associated with `productId`. As a result, `markWrong` deactivates ALL approved aliases for the product instead of targeting a specific wrong code.

### Root Cause
The guard `seenCodes.length === 0` treats an empty list of seen codes as a wildcard matching all aliases rather than aborting or requiring a explicit target code.

---

## Defect 3: Bypass of Product Un-verification Sync Item for Already Unverified Products

### Concrete Failure Scenario
A product has `verified === false`. A user invokes `markWrong` to decouple an incorrect alias from this unverified product. 

Step 1b contains the conditional:
```ts
if (product && product.verified) { ... }
```
Because `product.verified` is `false`, Step 1b is skipped. Consequently:
1. No `Product` update with `updatedAt: now()` or `updatedBy: "human"` occurs.
2. No `SAVE_PRODUCT` item is added to `pendingSyncQueue`.
The cloud backend never receives an update for the product entity, leading to state divergence between client and cloud.

### Root Cause
Step 1b gates product state updates and cloud queue item creation on `product.verified === true`, ignoring state updates required for unverified products.
