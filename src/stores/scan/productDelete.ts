import type { Alias, PendingSyncItem, Product } from "@/types";
import type { IncrementPayload } from "@/sync-database/mock/mockDb";
import type { ProductDeleteBackup, ScanState } from "@/stores/scanStore";
import { detectCodeType } from "@/products/match/codeTypeDetector";
import { prefixFloorName } from "@/products/catalog/prefixFloor";
import { buildIdempotencyKey } from "@/inventory/idempotency";
import { makeQueueItem } from "@/stores/scan/queueItem";
import { provisionalPlaceholderName } from "@/stores/scan/placeholders";

/** All identity codes a product owns: its identifier fields + every alias clean/normalized code. */
function productIdentityCodes(p: Product, aliases: Alias[]): string[] {
  const own = [p.primaryBarcode, p.gtin, p.upc, p.ean, p.primarySku].filter(Boolean) as string[];
  const aliasCodes = aliases.filter((a) => a.productId === p.id).flatMap((a) => [a.cleanCode, a.normalizedCode].filter(Boolean) as string[]);
  return [...new Set([...own, ...aliasCodes])];
}

// Known non-matching / poison codes that must never re-trust. 745125495781 is "not a valid UPC" at go-upc
// (which returns a DIFFERENT EAN 7451254957818 = Manstel rivet kit); the codes do not match.
const POISON_CODES = new Set(["745125495781"]);

/**
 * Shared delete engine for deleteProduct + purgePoisonedProducts. Archives each product (status archived +
 * verified false), deactivates ALL its aliases, removes its count rows, detaches its scan-feed rows, and
 * drops catalog/shop-override entries keyed to its codes. Snapshots everything BEFORE mutating for an exact
 * Undo. Idempotent (unknown/already-archived ids are skipped) and audited.
 */
function deleteProductsInternal(
  get: () => ScanState,
  set: (partial: Partial<ScanState> | ((s: ScanState) => Partial<ScanState>)) => void,
  emitAudit: (e: { entityType: string; entityId: string; action: string; metadata?: Record<string, unknown> }) => void,
  now: () => string,
  idFactory: () => string,
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

  // TOP-LEVEL LAW (feed-124/counts-122 root cause, fixed 2026-07-22): deleting a product must never
  // make counted quantity vanish - the physical items were scanned and are still on the shelf; only
  // the identity is being discarded. For every deleted product that carries counted quantity, mint an
  // "Unidentified item" provisional (same shape as ensureProvisionalCount's) and REPOINT the count
  // rows onto it (ids/sessionIds/scanEventIds untouched, so undo's upsert-by-id restores them
  // exactly and the ledger replay stays reproducible). Feed rows repoint to the provisional too.
  const provisionalByProduct = new Map<string, Product>();
  for (const p of targetProducts) {
    const qty = targetCounts.filter((c) => c.productId === p.id).reduce((s, c) => s + c.quantity, 0);
    if (qty <= 0) continue; // nothing counted -> nothing to preserve, mint no ghost row
    const code =
      touchedFeed.find((e) => e.matchedProductId === p.id)?.cleanCode ||
      (p.primaryBarcode ?? "").trim() ||
      productIdentityCodes(p, state.aliases)[0] ||
      "";
    const ct = code ? detectCodeType(code) : null;
    const floor = code && ct ? prefixFloorName(code, ct) : null;
    provisionalByProduct.set(p.id, {
      id: `prod-${idFactory()}`, businessId: state.businessId,
      name: code ? provisionalPlaceholderName(code) : "Unidentified item (deleted product)",
      brand: floor?.brand ?? "", category: "", specsShort: "", specsFull: "", primarySku: "",
      primaryBarcode: code, gtin: "", upc: "", ean: "", vendorCodes: [], aliases: [], imageUrl: "",
      productUrl: "", location: "", notes: "", status: "active", source: "ai_openai", confidence: 0,
      verified: false, provisional: true, provenanceTier: "provisional",
      createdAt: now(), createdBy: "human", updatedAt: now(), updatedBy: "human",
    });
  }
  const mintedProvisionalIds = [...provisionalByProduct.values()].map((p) => p.id);

  // Snapshot the PRE-delete values for an exact Undo (+ for the downloadable JSON backup in the UI).
  const backup: ProductDeleteBackup = {
    products: targetProducts.map((p) => ({ ...p })),
    aliases: targetAliases.map((a) => ({ ...a })),
    counts: targetCounts.map((c) => ({ ...c })),
    catalog: targetCatalog.map((c) => ({ ...c })),
    shopOverrides: targetOverrides.map((o) => ({ ...o })),
    feed: touchedFeed.map((e) => ({ ...e })),
    deletedAt: now(),
    mintedProvisionalIds,
  };

  // SYNC THE REPOINT (reviewed defect 2026-07-22): the transfer above is local-only; without these
  // ops the backend still holds the count row keyed (sessionId, deletedProductId), and the next
  // refreshFromCloud would re-add it ALONGSIDE the repointed provisional row - doubling the
  // quantity (2 became 4). Ship the archived product, the minted provisional, and a zero-out /
  // re-add increment PAIR per transferred count row (net zero per session: quantity is
  // transferred, never created). The synthetic scanEventId only marks the transfer in the remote
  // row's trace; the appliedKeys dedupe makes a re-drained op a safe no-op.
  const bid = state.businessId;
  const syncOps: PendingSyncItem[] = [];
  for (const p of targetProducts) {
    const archived: Product = { ...p, status: "archived", verified: false, updatedBy: "human" };
    syncOps.push(
      makeQueueItem({ idFactory, now, businessId: bid, sessionId: state.sessionId, entityType: "Product", entityId: p.id, operation: "SAVE_PRODUCT", payload: archived, idempotencyKey: buildIdempotencyKey(bid, state.sessionId, `${p.id}:delete:archive`, "SAVE_PRODUCT"), scanEventId: null }),
    );
  }
  for (const prov of provisionalByProduct.values()) {
    syncOps.push(
      makeQueueItem({ idFactory, now, businessId: bid, sessionId: state.sessionId, entityType: "Product", entityId: prov.id, operation: "SAVE_PRODUCT", payload: prov, idempotencyKey: buildIdempotencyKey(bid, state.sessionId, `${prov.id}:provisional`, "SAVE_PRODUCT"), scanEventId: null }),
    );
  }
  for (const c of targetCounts) {
    if (c.quantity <= 0) continue; // zero rows are dropped locally and carry nothing to transfer
    const prov = provisionalByProduct.get(c.productId);
    const outKey = buildIdempotencyKey(bid, c.sessionId, `${c.id}:delete-transfer-out`, "INCREMENT_COUNT");
    const outPayload: IncrementPayload = { businessId: bid, sessionId: c.sessionId, productId: c.productId, scanEventId: `${c.id}:delete-transfer`, quantityDelta: -c.quantity, idempotencyKey: outKey };
    syncOps.push(
      makeQueueItem({ idFactory, now, businessId: bid, sessionId: c.sessionId, entityType: "InventoryCount", entityId: c.id, operation: "INCREMENT_COUNT", payload: outPayload, idempotencyKey: outKey, scanEventId: null }),
    );
    if (prov) {
      const inKey = buildIdempotencyKey(bid, c.sessionId, `${c.id}:delete-transfer-in`, "INCREMENT_COUNT");
      const inPayload: IncrementPayload = { businessId: bid, sessionId: c.sessionId, productId: prov.id, scanEventId: `${c.id}:delete-transfer`, quantityDelta: c.quantity, idempotencyKey: inKey };
      syncOps.push(
        makeQueueItem({ idFactory, now, businessId: bid, sessionId: c.sessionId, entityType: "InventoryCount", entityId: c.id, operation: "INCREMENT_COUNT", payload: inPayload, idempotencyKey: inKey, scanEventId: null }),
      );
    }
  }

  set((s) => ({
    // Archive + un-verify so the deterministic resolver/matcher (verified === true only) stops matching it.
    products: [
      ...s.products.map((p) => (targetIds.has(p.id) ? { ...p, status: "archived" as const, verified: false, updatedBy: "human" } : p)),
      ...provisionalByProduct.values(),
    ],
    // Deactivate ALL aliases so an approved alias can no longer resolve the freed code.
    aliases: s.aliases.map((a) => (targetIds.has(a.productId) ? { ...a, approved: false } : a)),
    // Repoint counted rows onto the minted provisional (quantity INVARIANT); drop only zero-qty rows.
    finalCounts: s.finalCounts.flatMap((c) => {
      if (!targetIds.has(c.productId)) return [c];
      const prov = provisionalByProduct.get(c.productId);
      return prov ? [{ ...c, productId: prov.id, updatedAt: now() }] : [];
    }),
    // Drop catalog / shop-override entries keyed to the freed codes so a future scan re-decodes them.
    catalog: s.catalog.filter((c) => !(codes.has(c.normalizedBarcode) || codes.has(c.barcode))),
    shopOverrides: s.shopOverrides.filter((o) => !codes.has(o.normalizedBarcode)),
    // Repoint scan-feed rows at the provisional carrying their quantity (history kept, identity
    // reopened); rows of a zero-count product detach to null exactly as before.
    scanFeed: s.scanFeed.map((e) =>
      e.matchedProductId !== null && targetIds.has(e.matchedProductId)
        ? {
            ...e,
            matchedProductId: provisionalByProduct.get(e.matchedProductId)?.id ?? null,
            status: "needs_review" as const,
            resolverStatus: "needs_review" as const,
          }
        : e,
    ),
    pendingSyncQueue: [...s.pendingSyncQueue, ...syncOps],
    lastProductDeleteBackup: backup,
  }));
  get().syncPending(); // drain the transfer ops now (same pattern as enqueueAndSync)

  for (const p of targetProducts) {
    emitAudit({ entityType: "Product", entityId: p.id, action: auditAction, metadata: { name: p.name, codes: [...codes].join(" | "), aliasesDeactivated: targetAliases.filter((a) => a.productId === p.id).length } });
  }
  return { backup };
}
export { deleteProductsInternal, POISON_CODES, productIdentityCodes };
