import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";
import { replayLedgerCounts } from "@/services/inventory.replay";
import { buildIdempotencyKey as buildIdempotencyKeyForTest } from "@/services/idempotency";

// F-03 (audit remediation 2026-07-29): markWrong repoints local state (D2's total-quantity-invariant
// behavior, proven by markWrongTransfer.store.test.ts) but historically REUSED the original scan
// event's idempotency keys when repointing it onto the fresh "Unidentified item" provisional.
// FirebaseSyncTarget's applied-key dedupe stores the ORIGINAL marker (targetId = old productId); a
// replay with the SAME key but a DIFFERENT productId payload fails `markerMatches` and is rejected as
// idempotency_conflict (retryable:false) - the corrected cloud write never lands, so a reload / second
// device restores the WRONG cloud count. This test proves the durable ledger side (the pendingSyncQueue
// contract): the transfer must be a BALANCED pair using FRESH keys, never the original counting key.

function seedKnown(store: ReturnType<typeof createTestScanStore>, code: string) {
  const s = store.getState();
  const productId = "seed-wrong-durable-1";
  store.setState((prev) => ({
    products: [
      ...prev.products,
      {
        id: productId, businessId: s.businessId, name: "Wrongly Mapped Tire", brand: "Cooper", category: "tire",
        specsShort: "", specsFull: "", primarySku: "", primaryBarcode: code, gtin: "", upc: "", ean: "",
        vendorCodes: [], aliases: [], imageUrl: "", productUrl: "", location: "", notes: "", status: "active",
        source: "seed", confidence: 1, verified: true, createdAt: s.sessionId, updatedAt: s.sessionId, createdBy: "seed", updatedBy: "seed",
      },
    ],
    aliases: [
      ...prev.aliases,
      {
        id: "alias-wrong-durable-1", businessId: s.businessId, productId, rawCodeExample: code, cleanCode: code,
        normalizedCode: code, aliasType: "barcode", source: "seed", confidence: 1, approved: true,
        createdAt: s.sessionId, updatedAt: s.sessionId, createdBy: "seed", lastSeenAt: s.sessionId,
        syncStatus: "synced", idempotencyKey: "seed-alias-wrong-durable-1",
      },
    ],
  }));
  return productId;
}

describe("F-03: markWrong is a durable balanced ledger transfer (fresh keys, never reused)", () => {
  it("queues a balanced transfer with FRESH keys - never the original counting key - and replay lands on the corrected identity", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: false });
    const code = "049000006399";
    const productId = seedKnown(store, code);

    // The scan syncs normally (default MockDb, no simulated failure) so its ORIGINAL keys are already
    // applied to the backend by the time markWrong runs - the exact real-world scenario F-03 fixes.
    const ev = store.getState().processScan(code); // counts against the (wrong) verified product
    expect(ev, "the scan produced an event").toBeTruthy();
    const originalCountingKey = buildIdempotencyKeyForTest(store.getState().businessId, store.getState().sessionId, ev!.id, "INCREMENT_COUNT");
    const originalSaveKey = buildIdempotencyKeyForTest(store.getState().businessId, store.getState().sessionId, ev!.id, "SAVE_SCAN_EVENT");
    expect(store.getState().pendingSyncQueue.length, "the scan's ops already synced (queue drained)").toBe(0);

    // Freeze sync so markWrong's OWN transfer ops are inspectable before MockDb's synchronous
    // auto-drain consumes them (same technique as correctProductSync.store.test.ts / the F-02 test).
    store.getState().setSimulateSyncFailure(true);

    await store.getState().markWrong(productId, { reason: "test" });

    const q = store.getState().pendingSyncQueue;
    const counts = q.filter((i) => i.operation === "INCREMENT_COUNT");
    // Balanced transfer: at least a zero-out on the old identity AND a re-add on the new one.
    expect(counts.length, "balanced old- and new-identity writes queued").toBeGreaterThanOrEqual(2);
    expect(
      counts.every((i) => i.idempotencyKey !== originalCountingKey),
      "fresh transfer keys - never the original counting key",
    ).toBe(true);
    // A re-pointed SAVE_SCAN_EVENT with a FRESH key must also be queued (the event moved to the safe
    // placeholder) - never the original SAVE_SCAN_EVENT key (that one is still stamped against the wrong
    // product's applied-key marker and would be rejected as idempotency_conflict on replay).
    const savedEvents = q.filter((i) => i.operation === "SAVE_SCAN_EVENT");
    expect(
      savedEvents.some((i) => i.idempotencyKey !== originalSaveKey),
      "a fresh-keyed SAVE_SCAN_EVENT repoint is queued",
    ).toBe(true);

    // Old identity nets to zero (a decrement queued for it); new identity nets positive.
    const oldProductOps = counts.filter((i) => (i.payload as { productId?: string }).productId === productId);
    expect(oldProductOps.some((i) => (i.payload as { quantityDelta?: number }).quantityDelta! < 0), "old identity is zeroed out").toBe(true);

    const unidentified = store.getState().products.find((p) => p.provisional === true && p.primaryBarcode === code)!;
    expect(unidentified, "the transfer provisional exists").toBeDefined();
    const newProductOps = counts.filter((i) => (i.payload as { productId?: string }).productId === unidentified.id);
    expect(newProductOps.length, "the new identity receives counting ops").toBeGreaterThan(0);
    expect(newProductOps.every((i) => (i.payload as { quantityDelta?: number }).quantityDelta! > 0)).toBe(true);

    // Replay from feed events alone reconstructs the corrected identity (North-star #2), matching the
    // live store's own quantity - both halves of the ledger agree.
    const replayed = replayLedgerCounts(store.getState().scanFeed, store.getState().sessionId);
    const liveNewQty = store.getState().finalCounts.find((c) => c.productId === unidentified.id)?.quantity ?? 0;
    expect(replayed.find((c) => c.productId === unidentified.id)?.quantity ?? 0).toBe(liveNewQty);
    expect(replayed.find((c) => c.productId === productId)?.quantity ?? 0).toBe(0);
    expect(store.getState().finalCounts.find((c) => c.productId === productId)).toBeUndefined();
  });
});
