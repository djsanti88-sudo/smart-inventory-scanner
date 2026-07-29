# Case: bug-01-delete-product-drops-counts
## Task prompt (what the subject model sees)
Review the following code for real defects. This is part of a Zustand store managing barcode-scan inventory sessions; `deleteProductsInternal` is called when a user deletes a product row, and the store also tracks a running scan feed and per-session counted quantities that must always stay consistent with each other.
## Input code
```ts
// src/stores/scanStore.ts

function deleteProductsInternal(
  get: () => ScanState,
  set: (partial: Partial<ScanState> | ((s: ScanState) => Partial<ScanState>)) => void,
  emitAudit: (e: { entityType: string; entityId: string; action: string; metadata?: Record<string, unknown> }) => void,
  now: () => string,
  productIds: string[],
  auditAction: string,
): { backup: ProductDeleteBackup | null } {
  const state = get();
  const targetIds = new Set(productIds.filter((id) => state.products.some((p) => p.id === id)));
  if (targetIds.size === 0) return { backup: null };

  const targetProducts = state.products.filter((p) => targetIds.has(p.id));
  const codes = new Set(targetProducts.flatMap((p) => productIdentityCodes(p, state.aliases)));
  const targetAliases = state.aliases.filter((a) => targetIds.has(a.productId));
  const targetCounts = state.finalCounts.filter((c) => targetIds.has(c.productId));
  const targetCatalog = state.catalog.filter((c) => codes.has(c.normalizedBarcode) || codes.has(c.barcode));
  const targetOverrides = state.shopOverrides.filter((o) => codes.has(o.normalizedBarcode));
  const touchedFeed = state.scanFeed.filter((e) => e.matchedProductId !== null && targetIds.has(e.matchedProductId));

  // Snapshot the PRE-delete values for an exact Undo (+ for the downloadable JSON backup in the UI).
  const backup: ProductDeleteBackup = {
    products: targetProducts.map((p) => ({ ...p })),
    aliases: targetAliases.map((a) => ({ ...a })),
    counts: targetCounts.map((c) => ({ ...c })),
    catalog: targetCatalog.map((c) => ({ ...c })),
    shopOverrides: targetOverrides.map((o) => ({ ...o })),
    feed: touchedFeed.map((e) => ({ ...e })),
    deletedAt: now(),
  };

  set((s) => ({
    // Archive + un-verify so the deterministic resolver/matcher (verified === true only) stops matching it.
    products: s.products.map((p) => (targetIds.has(p.id) ? { ...p, status: "archived" as const, verified: false, updatedBy: "human" } : p)),
    // Deactivate ALL aliases so an approved alias can no longer resolve the freed code.
    aliases: s.aliases.map((a) => (targetIds.has(a.productId) ? { ...a, approved: false } : a)),
    // Remove the session count rows.
    finalCounts: s.finalCounts.filter((c) => !targetIds.has(c.productId)),
    // Drop catalog / shop-override entries keyed to the freed codes so a future scan re-decodes them.
    catalog: s.catalog.filter((c) => !(codes.has(c.normalizedBarcode) || codes.has(c.barcode))),
    shopOverrides: s.shopOverrides.filter((o) => !codes.has(o.normalizedBarcode)),
    // Detach scan-feed rows (history kept, but no longer "known" / pointing at the deleted product).
    scanFeed: s.scanFeed.map((e) =>
      e.matchedProductId !== null && targetIds.has(e.matchedProductId)
        ? { ...e, matchedProductId: null, status: "needs_review" as const, resolverStatus: "needs_review" as const }
        : e,
    ),
    lastProductDeleteBackup: backup,
  }));

  for (const p of targetProducts) {
    emitAudit({ entityType: "Product", entityId: p.id, action: auditAction, metadata: { name: p.name, codes: [...codes].join(" | "), aliasesDeactivated: targetAliases.filter((a) => a.productId === p.id).length } });
  }
  return { backup };
}
```
## GROUND TRUTH (never shown to subject)
- Defect: Deleting a product removes its `finalCounts` rows entirely (`finalCounts: s.finalCounts.filter((c) => !targetIds.has(c.productId))`) while the matching `scanFeed` rows are only detached (kept, `matchedProductId: null`, still present and still counted toward the feed). The feed total and the session's counted total diverge silently — physical quantity that was already scanned and counted just vanishes from the books (the "feed 124 / counts 122" class of bug). The product's identity should be discardable without the counted quantity disappearing.
- Fix commit: a142eb1 fix(ledger): deleteProduct transfers counted quantity to an Unidentified provisional; transferOrphanCount is session-scoped
- Key evidence: `finalCounts: s.finalCounts.filter((c) => !targetIds.has(c.productId))` unconditionally drops every count row for the deleted product(s) with no replacement/transfer, while `scanFeed` rows for the same product are preserved (just detached), so the feed and the count ledger no longer agree on total quantity.
- Scoring: HIT if the subject identifies that deleting a product silently deletes its counted quantity (finalCounts rows dropped) without transferring/preserving that quantity anywhere, causing feed-vs-count total mismatch or "lost inventory" on delete. PARTIAL if the subject notices the asymmetry between how scanFeed rows are handled (kept, detached) vs finalCounts rows (deleted outright) but doesn't state the total-quantity-loss consequence. Plausible-but-wrong findings: (1) flagging that aliases are deactivated but not deleted as an inconsistency (this is intentional, for audit/repair); (2) claiming the catalog/shopOverrides removal is a bug (also intentional, to force re-decode); (3) suggesting the backup snapshot is incomplete/wrong (it is actually a correct pre-delete snapshot for undo, unrelated to the real bug).
