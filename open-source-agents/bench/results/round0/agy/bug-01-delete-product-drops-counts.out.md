# Code Review: bug-01-delete-product-drops-counts

## Overview
Review of `deleteProductsInternal` in `src/stores/scanStore.ts`. The function handles batch deletion/archiving of product rows while updating aliases, session counts (`finalCounts`), catalog entries, shop overrides, scan feed entries, and audit logs.

---

## Defect 1: Inconsistency & Loss of Session Count State (`finalCounts` vs `scanFeed`)

### Concrete Failure Scenario
A user deletes a product from an active scan session. `deleteProductsInternal` removes all count entries for `targetIds` from `finalCounts` (`s.finalCounts.filter((c) => !targetIds.has(c.productId))`). At the same time, the corresponding scan feed entries in `scanFeed` are kept and updated to `matchedProductId: null` and `status: "needs_review"`. 

Because `finalCounts` entries are deleted outright while scan feed entries remain as unassigned "needs review" items:
1. Per-session counted quantities for the product drop to zero immediately in `finalCounts`, breaking consistency with the persistent scan feed.
2. If the user later restores the product or re-links the scan feed items, `finalCounts` remains wiped and out of sync with historical scan feed data unless explicitly restored from backup.

### Root Cause
Line 45 removes matching count rows from `finalCounts` (`finalCounts: s.finalCounts.filter((c) => !targetIds.has(c.productId))`) rather than updating or archiving them in sync with `scanFeed`.

---

## Defect 2: Global Over-Deletion of Shared Catalog Entries and Shop Overrides

### Concrete Failure Scenario
`codes` is constructed on Line 21 by aggregating all barcodes across all target products in the batch:
```ts
const codes = new Set(targetProducts.flatMap((p) => productIdentityCodes(p, state.aliases)));
```
Lines 47-48 then filter out catalog items and shop overrides that match any code in `codes`:
```ts
catalog: s.catalog.filter((c) => !(codes.has(c.normalizedBarcode) || codes.has(c.barcode))),
shopOverrides: s.shopOverrides.filter((o) => !codes.has(o.normalizedBarcode)),
```
If a catalog entry or shop override is associated with a barcode that is shared with or referenced by another active (non-deleted) product in the store, deleting `targetProducts` globally purges the catalog entry and shop override for the active non-deleted product as well.

### Root Cause
Catalog and shop override deletions are scoped globally to barcode matches (`codes.has(...)`) without checking whether those codes are still referenced by other active products in `s.products`.

---

## Defect 3: Audit Log Metadata Cross-Contamination in Batch Deletion Loop

### Concrete Failure Scenario
When deleting multiple products in a single call (e.g., Product A with barcode `111` and Product B with barcode `222`), lines 58-60 log an audit event for each product:
```ts
for (const p of targetProducts) {
  emitAudit({
    entityType: "Product",
    entityId: p.id,
    action: auditAction,
    metadata: {
      name: p.name,
      codes: [...codes].join(" | "),
      aliasesDeactivated: targetAliases.filter((a) => a.productId === p.id).length,
    },
  });
}
```
Because `codes` contains the set of all barcodes across all deleted products, Product A's individual audit log record will report `"111 | 222"` as its barcodes, falsely attributing Product B's barcodes to Product A in the audit history.

### Root Cause
`metadata.codes` formats the aggregated `codes` set for the entire batch rather than isolating the specific codes belonging to product `p`.
