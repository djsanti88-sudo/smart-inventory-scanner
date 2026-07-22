import { describe, it, expect, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { buildPersistedScanState } from "@/stores/scanPersist";
import { replayLedgerCounts } from "@/services/inventory.replay";
import type { InventoryCount, ScanEvent, UnknownCodeReview } from "@/types";

// Data-loss fix (critical): on a real page REFRESH with the cloud backend, BusinessContextGate
// re-resolves the SAME (businessId, userId) the store already holds and calls setBusinessContext
// again. setBusinessContext must NOT wipe scanFeed/finalCounts/needsReviewQueue/settings/
// firstScanAt/recentLocations when the tenant is unchanged - only an ACTUAL business/user switch
// wipes (isolation law, proven separately by businessSwitchReset.store.test.ts).

function scanEvent(id: string, productId: string, code: string): ScanEvent {
  return {
    id, businessId: "b1", sessionId: "s1", rawCode: code, cleanCode: code, normalizedCandidates: [],
    matchedProductId: productId, matchType: "primary_sku", status: "known", resolverStatus: "resolved",
    codeType: "numeric_sku", reason: "", quantityDelta: 1, quantityAfterScan: 1, createdAt: "t",
    source: "scan", notes: "", syncStatus: "synced", syncError: null, idempotencyKey: `k-${id}`,
  };
}

function count(productId: string, quantity: number, scanEventIds: string[]): InventoryCount {
  return {
    id: `count-${productId}`, businessId: "b1", sessionId: "s1", productId, quantity,
    lastScannedAt: "t", aliasesSeen: [], scanEventIds, createdAt: "t", updatedAt: "t",
    syncStatus: "synced", syncError: null, appliedIdempotencyKeys: [],
  };
}

describe("setBusinessContext refresh must not wipe the current tenant's data", () => {
  it("(a) re-entering the SAME (businessId, userId) preserves scanFeed/finalCounts/needsReviewQueue", async () => {
    const laggingLoader = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ products: [], aliases: [], sessions: [], counts: [] }), 20)),
    );
    const store = createTestScanStore({ cloudBackend: true, loadBusinessData: laggingLoader });

    const ev1 = scanEvent("ev1", "p1", "111");
    const ev2 = scanEvent("ev2", "p2", "222");
    const review: UnknownCodeReview = {
      id: "rev1", businessId: "b1", rawCode: "333", cleanCode: "333", codeType: "unknown",
      status: "open", decodeStatus: "needs_review", reason: "unresolved", suggestedProductName: "",
      createdAt: "t", scanCount: 1, lastScannedAt: "t",
    } as unknown as UnknownCodeReview;

    // First entry (real sign-in): establishes the tenant.
    store.getState().setBusinessContext("b1", "u1");
    // Seed unsynced scan data as if a real session had already happened on this device.
    store.setState({
      scanFeed: [ev1, ev2],
      finalCounts: [count("p1", 1, ["ev1"]), count("p2", 1, ["ev2"])],
      needsReviewQueue: [review],
    });

    // REFRESH simulation: same uid re-resolves to the same business, setBusinessContext runs again
    // (this is exactly what BusinessContextGate does on every page load).
    store.getState().setBusinessContext("b1", "u1");

    expect(store.getState().scanFeed).toEqual([ev1, ev2]);
    expect(store.getState().finalCounts.map((c) => c.productId).sort()).toEqual(["p1", "p2"]);
    expect(store.getState().needsReviewQueue).toEqual([review]);

    // Let the lagging loader resolve too: it must not retroactively wipe anything either.
    await new Promise((r) => setTimeout(r, 30));
    expect(store.getState().scanFeed).toEqual([ev1, ev2]);
    expect(store.getState().finalCounts.map((c) => c.productId).sort()).toEqual(["p1", "p2"]);
    expect(store.getState().needsReviewQueue).toEqual([review]);
  });

  it("(e) TRUE refresh: a persisted blob rehydrated into a FRESH store must still pass the same-tenant guard (userId round-trips)", () => {
    // The in-lifetime test (a) cannot catch a guard keyed on state the persist layer drops: on a real
    // page load the store starts EMPTY and only holds what rehydrate restores. Simulate the full
    // cycle: persist at customer ("business") level exactly like production -> fresh store ->
    // shallow-merge the blob (what zustand persist does) -> gate calls setBusinessContext.
    const mk = () =>
      createTestScanStore({ cloudBackend: true, loadBusinessData: async () => ({ products: [], aliases: [], sessions: [], counts: [] }) });
    const store1 = mk();
    store1.getState().setBusinessContext("b1", "u1");
    store1.setState({
      scanFeed: [scanEvent("ev1", "p1", "111"), scanEvent("ev2", "p2", "222")],
      finalCounts: [count("p1", 1, ["ev1"]), count("p2", 1, ["ev2"])],
    });
    const blob = JSON.parse(JSON.stringify(buildPersistedScanState(store1.getState() as never, "business")));

    const store2 = mk(); // fresh page load: empty store
    store2.setState(blob as never); // zustand persist rehydrate = shallow merge of persisted keys
    store2.getState().setBusinessContext("b1", "u1"); // BusinessContextGate re-resolves the same tenant

    expect(store2.getState().scanFeed.length, "feed survives a true refresh").toBe(2);
    expect(store2.getState().finalCounts.length, "counts survive a true refresh").toBe(2);
  });

  it("(b) an ACTUAL tenant switch still fully wipes (isolation law unchanged)", () => {
    const store = createTestScanStore({ cloudBackend: true, loadBusinessData: async () => ({ products: [], aliases: [], sessions: [], counts: [] }) });
    store.getState().setBusinessContext("b1", "u1");
    store.setState({
      scanFeed: [scanEvent("ev1", "p1", "111")],
      finalCounts: [count("p1", 1, ["ev1"])],
      needsReviewQueue: [{ id: "rev1" } as unknown as UnknownCodeReview],
    });

    store.getState().setBusinessContext("b2", "u2");

    expect(store.getState().scanFeed).toEqual([]);
    expect(store.getState().finalCounts).toEqual([]);
    expect(store.getState().needsReviewQueue).toEqual([]);
    expect(store.getState().businessId).toBe("b2");
    expect(store.getState().userId).toBe("u2");
  });

  it("(b2) a same-business but DIFFERENT user still fully wipes", () => {
    const store = createTestScanStore({ cloudBackend: true, loadBusinessData: async () => ({ products: [], aliases: [], sessions: [], counts: [] }) });
    store.getState().setBusinessContext("b1", "u1");
    store.setState({ scanFeed: [scanEvent("ev1", "p1", "111")], finalCounts: [count("p1", 1, ["ev1"])] });

    store.getState().setBusinessContext("b1", "u2");

    expect(store.getState().scanFeed).toEqual([]);
    expect(store.getState().finalCounts).toEqual([]);
    expect(store.getState().userId).toBe("u2");
  });

  it("(c) ensureProvisionalCount mints a synthetic backing event when the feed row is GONE, keeping books balanced", () => {
    const store = createTestScanStore();
    // Open review exists but its scanFeed row has been trimmed away (simulating a persist-trimmed feed).
    store.setState({
      scanFeed: [],
      needsReviewQueue: [{
        id: "rev1", businessId: "b1", rawCode: "999", cleanCode: "999", codeType: "unknown",
        status: "open", decodeStatus: "needs_review", reason: "unresolved", suggestedProductName: "",
        createdAt: "t", scanCount: 1, lastScannedAt: "t",
        idempotencyKey: "b1:s1:rev1:SAVE_UNKNOWN_SCAN",
      } as unknown as UnknownCodeReview],
    });

    const productId = store.getState().ensureProvisionalCount("999", "Recovered count (scan record was missing)");

    const finalCount = store.getState().finalCounts.find((c) => c.productId === productId);
    expect(finalCount?.quantity).toBe(1);

    // Books balance: sum of this product's feed quantityDeltas equals its finalCounts quantity.
    const feedRowsForProduct = store.getState().scanFeed.filter((e) => e.matchedProductId === productId);
    const sumDeltas = feedRowsForProduct.reduce((acc, e) => acc + e.quantityDelta, 0);
    expect(sumDeltas).toBe(finalCount?.quantity);

    // replayLedgerCounts (the pure ledger-replay ground truth) reproduces the same quantity from the
    // feed events alone - never a naked quantity bump the replay could not derive.
    const replayed = replayLedgerCounts(store.getState().scanFeed, store.getState().sessionId);
    const replayedForProduct = replayed.find((c) => c.productId === productId);
    expect(replayedForProduct?.quantity).toBe(finalCount?.quantity);
  });
});
