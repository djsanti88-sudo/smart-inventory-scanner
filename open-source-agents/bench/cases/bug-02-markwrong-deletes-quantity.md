# Case: bug-02-markwrong-deletes-quantity
## Task prompt (what the subject model sees)
Review the following code for real defects. This is part of a Zustand store managing barcode-scan inventory sessions; `markWrong` runs when a user flags a matched product as the wrong identity for a scanned code, so the app can un-link the bad match and send the code back to a review queue.
## Input code
```ts
// src/stores/scanStore.ts

markWrong: async (productId, opts) => {
  const state = get();
  const product = state.products.find((p) => p.id === productId);
  const count = state.finalCounts.find((c) => c.productId === productId);
  // Codes that resolved to this product this session (scan feed is the reliable source; the count's
  // aliasesSeen is a fallback). These approved aliases are the ones to deactivate.
  const seenCodes = Array.from(
    new Set([
      ...state.scanFeed.filter((e) => e.matchedProductId === productId).map((e) => e.cleanCode),
      ...(count?.aliasesSeen ?? []),
    ]),
  );
  // 1. Deactivate the APPROVED aliases that mapped the scanned code(s) to this (wrong) product.
  const deactivate = state.aliases.filter(
    (a) => a.productId === productId && a.approved && (seenCodes.length === 0 || seenCodes.includes(a.cleanCode)),
  );
  if (deactivate.length > 0) {
    const ids = new Set(deactivate.map((a) => a.id));
    const queued: PendingSyncItem[] = [];
    const updatedAliases = state.aliases.map((a) => {
      if (!ids.has(a.id)) return a;
      const key = buildIdempotencyKey(state.businessId, state.sessionId, `${a.id}:markwrong:${idFactory()}`, "RESOLVE_ALIAS");
      const u: Alias = { ...a, approved: false, updatedAt: now(), syncStatus: "pending", idempotencyKey: key };
      queued.push(makeQueueItem({ idFactory, now, businessId: state.businessId, sessionId: state.sessionId, entityType: "Alias", entityId: a.id, operation: "RESOLVE_ALIAS", payload: u, idempotencyKey: key, scanEventId: null }));
      emitAudit({ entityType: "Alias", entityId: a.id, action: "wrong_alias_removed", metadata: { productId, cleanCode: a.cleanCode, reason: opts?.reason ?? "marked_wrong" } });
      return u;
    });
    set((s) => ({ aliases: updatedAliases, pendingSyncQueue: [...s.pendingSyncQueue, ...queued] }));
  }
  // 1b. Un-verify the wrong product so the DETERMINISTIC resolver can no longer match it by its
  // identifier fields (matchProductByIdentifiers only trusts verified === true). Without this, the
  // next scan of the same barcode would re-match this wrong product and re-count it - bypassing the
  // firewall entirely. The product row is kept (status unchanged) for audit/repair, just untrusted.
  if (product && product.verified) {
    const key = buildIdempotencyKey(state.businessId, state.sessionId, `${product.id}:markwrong:unverify`, "SAVE_PRODUCT");
    const unverified: Product = { ...product, verified: false, updatedAt: now(), updatedBy: "human" };
    set((s) => ({
      products: s.products.map((p) => (p.id === productId ? unverified : p)),
      pendingSyncQueue: [
        ...s.pendingSyncQueue,
        makeQueueItem({ idFactory, now, businessId: state.businessId, sessionId: state.sessionId, entityType: "Product", entityId: productId, operation: "SAVE_PRODUCT", payload: unverified, idempotencyKey: key, scanEventId: null }),
      ],
    }));
    emitAudit({ entityType: "Product", entityId: productId, action: "product_unverified", metadata: { reason: opts?.reason ?? "marked_wrong" } });
  }
  // 2. Reset related feed rows to needs_review (scan history preserved; no longer "known").
  set((s) => ({
    scanFeed: s.scanFeed.map((e) =>
      e.matchedProductId === productId && (seenCodes.length === 0 || seenCodes.includes(e.cleanCode))
        ? { ...e, status: "needs_review" as const, resolverStatus: "needs_review" as const, matchedProductId: null }
        : e,
    ),
  }));
  // 3. Remove the session count (product + now-deactivated aliases are kept for audit/repair).
  if (count) {
    set((s) => ({ finalCounts: s.finalCounts.filter((c) => c.productId !== productId) }));
    emitAudit({ entityType: "InventoryCount", entityId: count.id, action: "count_removed", metadata: { productId, quantity: count.quantity, reason: "marked_wrong" } });
  }
  // 4. Reopen Needs Review for the representative scanned code.
  const code = seenCodes[0] || product?.primaryBarcode || "";
  const reviewId = code
    ? get().reopenNeedsReview(code, `Marked wrong by owner. Previous match ${product?.name ? `"${product.name}"` : ""} removed - re-identify the product.`)
    : null;
  if (reviewId) {
    emitAudit({ entityType: "UnknownCodeReview", entityId: reviewId, action: "needs_review_reopened", metadata: { code, fromProduct: productId } });
    // 5. Stronger Gemini Pro correction recheck (cost-guarded; never auto-saves or counts).
    await get().correctionRecheck(reviewId, { reason: opts?.reason });
  }
  return reviewId;
},
```
## GROUND TRUTH (never shown to subject)
- Defect: Step 3 (`finalCounts: s.finalCounts.filter((c) => c.productId !== productId)`) permanently deletes the counted quantity that had accumulated on the wrong product instead of transferring it anywhere. The scanned physical items are still on the shelf and the code is being sent back to Needs Review for re-identification (step 4), but the quantity that was already counted for those scans is simply thrown away — total counted inventory silently shrinks every time a user corrects a wrong match.
- Fix commit: 33614e0 fix(ledger): D2 - markWrong transfers quantity to Unidentified provisional (invariant total; example-gate locked)
- Key evidence: `if (count) { set((s) => ({ finalCounts: s.finalCounts.filter((c) => c.productId !== productId) })); emitAudit({ ... action: "count_removed" ... }); }` — the count row (and its quantity) is filtered out and never re-created on any other product, even though the same code is about to be reopened in Needs Review for re-identification.
- Scoring: HIT if the subject identifies that step 3 deletes the wrong product's counted quantity outright with no transfer/provisional to hold it, so marking a scan "wrong" permanently loses count of physical items that were actually scanned. PARTIAL if the subject flags "count_removed" as suspicious or notes the count is dropped but doesn't connect it to the physical-quantity-loss consequence. Plausible-but-wrong findings: (1) claiming step 1's alias deactivation is unsafe because it doesn't also delete the alias rows (this is intentional, for audit/repair); (2) claiming there's a race between the multiple sequential `set()` calls (they're all synchronous Zustand set calls, not actually racy); (3) flagging that `reopenNeedsReview` might create a duplicate review if called twice (not the historical bug — the real bug is the silent quantity deletion in step 3).
