<!-- subject=analyst case=bug-02-markwrong-deletes-quantity round=4 elapsed=132s rc=0 -->
**TRACE:**  
1. **Scenario A – no scans for the product**  
   *State:* `state.products` contains a product with `id = 123`, `primaryBarcode = "XYZ"`.  
   `state.scanFeed` has no entries whose `matchedProductId === 123`.  
   `state.aliases` may contain approved aliases for this product.  

   Call: `markWrong(123, {})`.

   *Execution:*  
   - `seenCodes` becomes an empty array (`Array.from(new Set([...]))`).  
   - Alias deactivation filter (line ~12) evaluates to **true** for every alias with `productId = 123` because `(seenCodes.length === 0 || …)` is true.  
   - All such aliases are mapped to a new object with `approved: false`.  
   - Queue items are created and appended to `pendingSyncQueue`.  

   - Product unverification (line ~22) queues an update for the product.  

   - Scan‑feed mapping (line ~37) finds no entries, so nothing changes.  

   - Final‑count removal (line ~47) finds none, so nothing changes.  

   - `code` is set to `product?.primaryBarcode`, i.e. `"XYZ"` (line ~52).  
   - `reopenNeedsReview("XYZ", …)` is called and creates a review for code `"XYZ"`.  

   *Result:* A review is opened for a barcode that was never scanned in this session.

2. **Scenario B – aliases over‑deactivated when no scans**  
   Same initial state as above, but `state.aliases` contains two approved aliases: `{id: 1, cleanCode:"A"}` and `{id: 2, cleanCode:"B"}`.  

   Call: `markWrong(123, {})`.

   *Execution:*  
   - Alias deactivation filter (line ~12) again evaluates to **true** for both aliases because `(seenCodes.length === 0 || …)` is true.  
   - Both aliases are set to `approved: false`.  

   *Result:* All approved aliases of the product are deactivated, even though no code was scanned in this session.

---

**SYNTAX-FILTER:** No candidate finding is about spelling or missing identifiers; all candidates refer to runtime behavior.

**VERDICT:** SOUND – the function behaves as written but contains defects that violate data‑integrity expectations.

**FINDINGS:**

1. **[Critical] Wrong review creation for unscanned code**  
   *Defect:* `markWrong` may create a review for a barcode that was never scanned in the current session, because it falls back to `product.primaryBarcode`.  
   *Failure scenario:*  
     - Starting state: product with `primaryBarcode = "XYZ"`, no scanFeed entries matched to this product.  
     - Action sequence: call `markWrong(productId)` where `productId` refers to that product.  
     - Wrong outcome: a review is created for code `"XYZ"` even though the user never scanned it.  
   *Expected outcome:* No review should be opened unless at least one scan of that barcode exists in this session.  
   *Evidence line:*  
   ```ts
   const code = seenCodes[0] || product?.primaryBarcode || "";
   // …
   const reviewId = get().reopenNeedsReview(code, …);
   ```

2. **[High] Over‑deactivation of aliases when no scans**  
   *Defect:* The alias deactivation logic deactivates all approved aliases for the product whenever `seenCodes` is empty, potentially removing aliases that were never used in this session.  
   *Failure scenario:*  
     - Starting state: product with `id = 123`, `state.aliases` contains two approved aliases `{id:1, cleanCode:"A"}` and `{id:2, cleanCode:"B"}`.  
     - Action sequence: call `markWrong(123, {})`.  
     - Wrong outcome: both aliases are set to `approved: false`.  
   *Expected outcome:* Only aliases whose `cleanCode` appears in `seenCodes` should be deactivated; if no scans exist, none should change.  
   *Evidence line:*  
   ```ts
   const deactivate = state.aliases.filter(
     (a) => a.productId === productId && a.approved &&
       (seenCodes.length === 0 || seenCodes.includes(a.cleanCode)),
   );
   ```

---

**QUESTIONS:**  

- Does the application ever call `markWrong` on a product that has no scans in the current session?  
- Is it acceptable for `reopenNeedsReview` to create a review for a barcode that was never scanned, or should it only act when at least one scan exists?  
- Should alias deactivation be conditioned strictly on `seenCodes.includes(a.cleanCode)` rather than also allowing `seenCodes.length === 0`?  

These clarifications would determine whether the identified behaviors are indeed defects or intentional design choices.
