<!-- subject=analyst case=bug-01-delete-product-drops-counts round=3 elapsed=261s rc=0 -->
**TRACE:**  
Pick a concrete product `P1` with id `"P1"`, barcode `"ABC"` and an alias for the same code, and another product `P2` also sharing barcode `"ABC"`. The catalog contains entries for both products keyed by that barcode.  
Call `deleteProductsInternal(get, set, emitAudit, now, ["P1"], "Delete")`.  
The function builds `codes = {"ABC"}` from `productIdentityCodes(P1)`, then removes catalog entries where `codes.has(c.normalizedBarcode)` or `codes.has(c.barcode)`. Thus the catalog entry for `P2` is also removed. The scanFeed event for `P1` has its `matchedProductId` nulled and status set to `"needs_review"`.  

**SYNTAX‑FILTER:**  
No candidate finding is a claim about spelling, an undefined identifier, or a missing declaration.

**VERDICT:** FLAWED – data loss due to shared codes across products.

**FINDINGS:**

1. **[Critical] [Correctness & data integrity]** Deleting a product removes catalog and shop‑override entries keyed by any code that the product uses, even if those codes belong to other products.  
   *Failure scenario:* Starting state contains two products `P1` and `P2` that share barcode `"ABC"`. The catalog holds entries for both. Call `deleteProductsInternal(..., ["P1"], ...)`. After execution, the catalog entry for `P2` is also removed because `codes.has(c.normalizedBarcode)` matches `"ABC"`.  
   *Wrong outcome:* Scanning `P2`’s barcode thereafter yields no feed row or count, violating the TOP LAW that every scanned code must appear on the scan feed and be counted.  
   *Expected outcome:* The catalog entry for `P2` should remain; scanning it should produce a feed row and increment its count.  
   *Evidence line:* `catalog: s.catalog.filter((c) => !(codes.has(c.normalizedBarcode) || codes.has(c.barcode)))`.

2. **[High] [Correctness & data integrity]** The function archives the product but never removes it from `state.products`. Archived products stay in the array, potentially confusing UI and inflating memory.  
   *Failure scenario:* Starting state has active product `P1` with id `"P1"`. After calling `deleteProductsInternal(..., ["P1"], ...)`, `state.products` still contains an entry for `P1` but with `status: "archived"`. The rest of the system may still list all products, including archived ones.  
   *Wrong outcome:* Archived product remains visible in product listings and could be mistakenly considered active by other logic that does not check `verified`.  
   *Expected outcome:* The product should be removed from `state.products` to avoid confusion and unnecessary memory usage.  
   *Evidence line:* `products: s.products.map((p) => (targetIds.has(p.id) ? { ...p, status: "archived" as const, verified: false, updatedBy: "human" } : p))`.

3. **[Medium] [Correctness & data integrity]** The function changes the status of any scan‑feed event matched to the deleted product to `"needs_review"` even if it was previously `"resolved"`.  
   *Failure scenario:* Starting state has a feed event `e1` with `matchedProductId: "P1"` and `status: "resolved"`. After deletion, `scanFeed` mapping sets `status: "needs_review"` and `resolverStatus: "needs_review"`, overriding the previous resolved status.  
   *Wrong outcome:* The event is incorrectly downgraded to needing review, potentially causing unnecessary manual intervention.  
   *Expected outcome:* Status should either remain unchanged or be removed entirely; it should not downgrade a previously resolved event.  
   *Evidence line:* `scanFeed: s.scanFeed.map((e) => e.matchedProductId !== null && targetIds.has(e.matchedProductId) ? { ...e, matchedProductId: null, status: "needs_review" as const, resolverStatus: "needs_review" as const } : e)`.

4. **[Low] [Security & tenancy]** Audit events expose raw product codes in their metadata. The `codes` string is built from the set of all codes for the deleted product and logged verbatim.  
   *Failure scenario:* Starting state has auditAction `"Delete"` and product `P1` with code `"ABC"`. After deletion, `emitAudit` logs `{ ...metadata: { codes: [...codes].join(" | ") }}` which includes `"ABC"`. If the audit log is accessible by other tenants or stored in a shared location, this leaks internal barcode data.  
   *Wrong outcome:* Sensitive product codes become visible in audit logs that may be read by unauthorized parties.  
   *Expected outcome:* Audit logs should not include raw barcodes or should sanitize them before logging.  
   *Evidence line:* `emitAudit({ entityType: "Product", entityId: p.id, action: auditAction, metadata: { name: p.name, codes: [...codes].join(" | "), aliasesDeactivated: targetAliases.filter((a) => a.productId === p.id).length } });`.

**QUESTIONS:**  
1. Does `productIdentityCodes` include alias codes for *all* products or only those with `approved: true`? If it includes all, the shared‑code deletion defect is confirmed.  
2. Can catalog entries legitimately share the same barcode across different products? If so, how should deletions avoid removing unrelated entries?  
3. Is there an intentional reason to keep archived products in `state.products` rather than removing them entirely?  
4. Should audit logs sanitize or omit raw product codes before logging?
