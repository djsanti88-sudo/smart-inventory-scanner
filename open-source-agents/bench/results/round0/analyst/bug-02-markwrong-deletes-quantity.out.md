<!-- subject=analyst case=bug-02-markwrong-deletes-quantity round=0 elapsed=1006s rc=0 -->
**VERDICT:** FLAWED – The function violates a core project law by generating unstable idempotency keys for alias deactivation, risking duplicate sync operations and data integrity issues.

---

### FINDINGS

1. **[critical] Correctness & data integrity**  
   Alias deactivation builds an idempotency key that includes `idFactory()` (`${a.id}:markwrong:${idFactory()}`), which generates a new random value on every call. This makes the key unstable; retries will produce different keys, causing duplicate queue items and potentially double‑syncing alias updates.  
   *Evidence:* line with `buildIdempotencyKey(state.businessId, state.sessionId, `${a.id}:markwrong:${idFactory()}`, "RESOLVE_ALIAS")`.

2. **[important] Correctness & data integrity**  
   The final count removal uses `s.finalCounts.filter((c)=>c.productId !== productId)`, which deletes *all* counts for that product ID. If multiple sessions have separate counts, this unintentionally removes other session’s data.  
   *Evidence:* line with `set((s) => ({ finalCounts: s.finalCounts.filter((c)=>c.productId !== productId)}));`.

3. **[important] Security & tenancy**  
   The optional reason (`opts?.reason`) is passed directly to `correctionRecheck` and audit logs without sanitisation. If the reason contains malicious content, downstream code that uses it could be vulnerable to injection or other attacks.  
   *Evidence:* lines with `await get().correctionRecheck(reviewId, { reason: opts?.reason });` and `emitAudit(... metadata: { reason: opts?.reason ?? "marked_wrong" } );`.

4. **[minor] Simplicity & scope**  
   The function mixes many responsibilities (alias deactivation, product unverify, scan feed reset, count removal, review reopening, correction recheck). Refactoring into smaller helper functions would improve readability and maintainability.  
   *Evidence:* entire body of `markWrong`.

5. **[minor] Failure modes & honesty**  
   If either `get().reopenNeedsReview` or `correctionRecheck` throws an error, the function rejects without rolling back earlier state changes (aliases updated, counts removed). This can leave the store in a partially‑updated state.  
   *Evidence:* absence of try/catch around awaited calls.

6. **[minor] Simplicity & scope**  
   The alias deactivation condition `(seenCodes.length === 0 || seenCodes.includes(a.cleanCode))` will deactivate all approved aliases for a product if no scanFeed rows matched that product, potentially over‑deactivating aliases that were never used in this session.  
   *Evidence:* line with `const deactivate = state.aliases.filter((a) => a.productId === productId && a.approved && (seenCodes.length === 0 || seenCodes.includes(a.cleanCode)), );`.

7. **[minor] Security & tenancy**  
   Audit logs include `productId` and `cleanCode`, which may expose sensitive identifiers if logs are accessed by unauthorized parties.  
   *Evidence:* lines with `emitAudit({ entityType: "Alias", ... metadata: { productId, cleanCode: a.cleanCode, … } });`.

---

### QUESTIONS

- **What does `buildIdempotencyKey` actually use to compute the key?** If it concatenates all arguments verbatim, then including `idFactory()` indeed makes the key unstable.  
- **Is there ever more than one `InventoryCount` per product in a session?** If not, the final count removal may be safe; if yes, the current filter could delete unrelated counts.  
- **How does `correctionRecheck` use the supplied `reason`?** Does it embed it into SQL or other commands that could be vulnerable to injection?  
- **Are there any safeguards elsewhere in the store to roll back state changes on error?** If not, partial updates may persist after a failure.  

---
