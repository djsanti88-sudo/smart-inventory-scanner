<!-- subject=analyst case=bug-01-delete-product-drops-counts round=4 elapsed=250s rc=0 -->
**TRACE:**  
1. *Duplicate‑code deletion* – Assume state contains two products `P1` and `P2`, both having the same normalized barcode `"ABC123"`.  
   - Call `deleteProductsInternal(get, set, emitAudit, now, [P1.id], "Delete")`.  
   - `targetIds = {P1.id}`.  
   - `codes = productIdentityCodes(P1, state.aliases)` → `{“ABC123”}`.  
   - In the `set` callback: `catalog: s.catalog.filter(c => !(codes.has(c.normalizedBarcode) || codes.has(c.barcode)))`.  
   - The filter removes any catalog entry whose `normalizedBarcode` or `barcode` equals `"ABC123"`, which includes both P1’s and P2’s entries.  
   - Result: P2’s catalog row disappears even though it was not targeted.

2. *No‑code deletion* – Assume product `P3` has no identity codes (`productIdentityCodes(P3, …)` returns `[]`).  
   - Call `deleteProductsInternal(get, set, emitAudit, now, [P3.id], "Delete")`.  
   - `codes = new Set([])` → empty set.  
   - In the `set` callback: same catalog filter as above.  
   - Since `codes.has(...)` is always false, no catalog entry for P3 is removed; its catalog row remains orphaned.

**SYNTAX‑FILTER:** No candidate finding concerns spelling or missing identifiers; all claims refer to behavior only.

**VERDICT:** FLAWED – the function can unintentionally remove data belonging to other products and leave orphaned entries when a product has no identity codes.

**FINDINGS:**

1. **[Critical] Duplicate barcodes cause cross‑product catalog/shop‑override removal**  
   *Scenario:* Two active products share the same normalized barcode `"ABC123"`. Deleting one (`P1`) sets `codes = {“ABC123”}`. The `catalog` filter line  
   ```ts
   catalog: s.catalog.filter((c) => !(codes.has(c.normalizedBarcode) || codes.has(c.barcode))),
   ```  
   removes any catalog entry whose barcode matches `"ABC123"`, which includes the other product’s (`P2`) catalog row. The same applies to `shopOverrides`.  
   *Wrong outcome:* The non‑targeted product loses its catalog and override entries, breaking data integrity.  
   *Expected outcome:* Only the targeted product’s catalog/override rows should be removed.  

2. **[High] Products lacking identity codes leave orphaned catalog/shop‑override rows**  
   *Scenario:* A product `P3` has no identity codes (`productIdentityCodes(P3, …)` returns an empty array). Deleting it yields `codes = new Set([])`. The same `catalog` filter line above never matches any entry for `P3`, so its catalog row persists.  
   *Wrong outcome:* After deletion, the product’s catalog and override entries remain in the store, causing stale data that may be matched by future scans.  
   *Expected outcome:* All catalog/override rows associated with the deleted product should be removed.

**QUESTIONS:**  
- What exactly does `productIdentityCodes(p, aliases)` return when a product has no identity codes? (to confirm the orphan‑entry scenario)  
- Does any other part of the system ignore archived products (`status === "archived"`) during scanning or counting? (to assess potential double‑count risk)
