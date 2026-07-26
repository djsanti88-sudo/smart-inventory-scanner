<!-- subject=analyst case=bug-02-markwrong-deletes-quantity round=2 elapsed=168s rc=0 -->
**TRACE:**  
*Scenario:* `productId = "p1"`, `opts = {reason:"test"}`.  
State before call:  

```
products: [{id:"p1", verified:true, name:"Test"}]
finalCounts: [{productId:"p1", id:"c1", quantity:5}]
scanFeed: [
  {cleanCode:"codeA", matchedProductId:"p1"},
  {cleanCode:"codeB", matchedProductId:null}
]
aliases: [{id:"a1", productId:"p1", approved:true, cleanCode:"codeA"}]
businessId:"b1", sessionId:"s1"
```

Execution steps:

1. `seenCodes` → `["codeA"]`.  
2. `deactivate` → `[a1]`.  
3. Alias `a1` updated to `{approved:false}`; queued item added.  
4. Product `p1` unverified; queue item added.  
5. ScanFeed entry `e1` status set to `"needs_review"`, matchedProductId cleared.  
6. `finalCounts` filtered → empty array (removes count `c1`).  

**SYNTAX‑FILTER:**  
No candidate finding is a claim about spelling, an undefined identifier, or a missing declaration.

**VERDICT:**  
FLAWED – the function can delete quantity data that should be preserved for other sessions and may deactivate aliases that were never scanned in this session.

---

### FINDINGS

1. **[High] Correctness & data integrity – Deleting all counts for a product removes quantity from *other* sessions**  
   *Failure scenario:* Two concurrent sessions exist; `finalCounts` contains `[c1, c2]` both with `productId:"p1"`. Calling `markWrong("p1")` in session A executes the filter `s.finalCounts.filter((c)=>c.productId!==productId)` which removes **both** `c1` and `c2`, erasing quantity that should belong to session B.  
   *Evidence line:* `set((s) => ({ finalCounts: s.finalCounts.filter((c) => c.productId !== productId) }));` (lines 41‑43).  

2. **[Medium] Correctness & data integrity – Alias deactivation logic falls back to “deactivate all” when no codes seen**  
   *Failure scenario:* In a session where the user has not scanned any code for `productId:"p1"` but there exists an alias record with `cleanCode:"codeX"`. The filter `seenCodes.length === 0 || seenCodes.includes(a.cleanCode)` evaluates to true because `seenCodes` is empty, causing that alias (and potentially unrelated ones) to be deactivated.  
   *Evidence line:* `const deactivate = state.aliases.filter((a)=> a.productId===productId && a.approved && (seenCodes.length===0 || seenCodes.includes(a.cleanCode)), );` (lines 23‑27).  

3. **[Low] Security & tenancy – No check that the alias being deactivated actually belongs to this business**  
   The code filters by `a.productId === productId`, but does not verify that the alias’s `businessId` matches the current `state.businessId`. If an alias record from another business is present in the store (e.g., due to a stale import), it could be deactivated erroneously.  
   *Evidence line:* same filter as above, missing business check.  

4. **[Low] Failure modes & honesty – The function silently returns `reviewId` even if no review was reopened**  
   If `seenCodes` is empty and the product has no primaryBarcode, `code` becomes an empty string, `reopenNeedsReview` is not called, and `reviewId` remains `null`. The caller may assume a review was created. This silent failure could hide that the wrong product had no scanned code to reopen.  
   *Evidence line:* `const reviewId = code ? get().reopenNeedsReview(...) : null;` (lines 55‑58).  

---

### QUESTIONS

1. Does the application ever run multiple sessions concurrently such that `finalCounts` can contain more than one entry per `productId`? If not, the quantity deletion bug may be moot.  
2. Is there a business-level field on alias records that should be checked before deactivation to avoid cross‑tenant contamination?  
3. What is the intended behavior when no codes are seen for a product – should any alias be deactivated or only those explicitly scanned?  

---
