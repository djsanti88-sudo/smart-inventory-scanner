<!-- subject=analyst case=bug-01-delete-product-drops-counts round=1 elapsed=283s rc=0 -->
VERDICT: FLAWED – wrong product identity removal due to overlapping barcodes between products.  

FINDINGS:  
1. [severity: critical] [Correctness & data integrity] Deleting a product removes catalog entries and shop‑override rows keyed by any code belonging to that product, even if another product shares the same code; thus deleting one product can inadvertently delete data for another. Concrete failure scenario: `state.catalog` contains two entries with `normalizedBarcode === "ABC123"` – one for Product A (id = "a") and one for Product B (id = "b"). Calling `deleteProductsInternal(..., ["a"], …)` sets `codes = new Set(["ABC123"])`. The line  
   ```ts
   targetCatalog = state.catalog.filter((c) => codes.has(c.normalizedBarcode) || codes.has(c.barcode))
   ```  
   removes *both* catalog entries because the filter only checks the barcode, not the product id. Expected outcome: only Product A’s entry removed; actual outcome: both A and B are removed.  

2. [severity: important] [Correctness & data integrity] The function does not remove a deleted product from `state.products`; it merely marks it as `"archived"`. If any downstream logic fails to filter by status, the archived product may still be matched during scans, violating the invariant that only active products are considered. Concrete failure scenario: after deletion, a new scan for Product A’s barcode is processed; because the product remains in `state.products` with id = "a`, the matcher will incorrectly associate the scan to the archived product instead of rejecting it. The line  
   ```ts
   products: s.products.map((p) => (targetIds.has(p.id) ? { ...p, status: "archived" as const, verified: false, updatedBy: "human" } : p))
   ```  
   shows the product is left in the array.  

3. [severity: minor] [Correctness & data integrity] The backup copies are shallow; nested objects inside products, aliases, counts, etc., are not deep‑cloned. If any part of the store mutates a nested property after deletion, the backup will reflect that mutation instead of the original state. Concrete failure scenario: `targetProducts[0].details.foo` is changed to `"bar"` after the delete; because the backup was created with  
   ```ts
   products: targetProducts.map((p) => ({ ...p }))
   ```  
   the same object reference is stored in both `state.products` and `backup.products`.  

4. [severity: minor] [Correctness & data integrity] The code does not guard against `productIdentityCodes` returning `undefined` or `null`, which would insert those values into the `codes` set and cause unintended removal of catalog entries whose barcode fields are also `undefined`/`null`. Concrete failure scenario: if a product’s alias list is empty, `productIdentityCodes(p, state.aliases)` might return `[undefined]`; then `codes.has(undefined)` becomes true. The filter  
   ```ts
   targetCatalog = state.catalog.filter((c) => codes.has(c.normalizedBarcode) || codes.has(c.barcode))
   ```  
   would remove any catalog entry whose `normalizedBarcode` or `barcode` is also `undefined`.  

QUESTIONS:  
- What guarantees does `productIdentityCodes` provide about uniqueness of returned codes per product?  
- Are there legitimate cases where two distinct products share the same barcode or alias code in this system?  
- Does downstream logic consistently filter out archived products (`status === "archived"`) when matching scans?
