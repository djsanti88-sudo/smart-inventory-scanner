import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import type { SyncTarget } from "@/sync-database/syncTarget";
import type { SyncResult } from "@/sync-database/mock/mockDb";
import type { Alias, InventoryCount, InventorySession, PendingSyncItem, Product } from "@/types";

// Regression (cloud sync): a terminal failure (e.g. Firestore permission-denied) quarantines a
// pendingSyncQueue item. Automatic drains correctly skip quarantined items forever (no infinite
// auto-retry of a terminal failure). But if the underlying cause is fixed server-side (e.g. a rules
// bug gets patched), the item must still be reachable via the user-facing Retry action - otherwise
// it is stranded in the local queue forever, which is data-loss-shaped for a synced-count product.

class ToggleableTarget implements SyncTarget {
  applied: PendingSyncItem[] = [];
  shouldDeny = true;
  async apply(item: PendingSyncItem): Promise<SyncResult> {
    if (this.shouldDeny) {
      return {
        ok: false,
        alreadyApplied: false,
        errorCode: "permission_denied",
        error: "PERMISSION_DENIED: Missing or insufficient permissions.",
        retryable: false,
      };
    }
    this.applied.push(item);
    return { ok: true, alreadyApplied: false };
  }
  setFailure() {}
  reset() {}
}

const CODE = "555666777888";
const product = {
  id: "p-quar", businessId: "biz-quar", name: "Quarantine Widget", brand: "", category: "", specsShort: "",
  specsFull: "", primarySku: "", primaryBarcode: CODE, gtin: "", upc: "", ean: "", vendorCodes: [],
  aliases: [CODE], imageUrl: "", productUrl: "", location: "", notes: "", status: "active", source: "manual",
  confidence: 1, verified: true, createdAt: "t", updatedAt: "t", createdBy: "human", updatedBy: "human",
} as Product;
const alias = {
  id: "a-quar", businessId: "biz-quar", productId: "p-quar", rawCodeExample: CODE, cleanCode: CODE,
  normalizedCode: CODE, aliasType: "barcode", source: "manual", confidence: 1, approved: true, createdAt: "t",
  updatedAt: "t", createdBy: "human", lastSeenAt: "t", syncStatus: "synced", idempotencyKey: "k",
} as Alias;

const loader = async () => ({ products: [product], aliases: [alias], sessions: [] as InventorySession[], counts: [] as InventoryCount[] });

describe("quarantined item explicit retry (regression)", () => {
  it("stays quarantined forever through automatic drains, but an explicit retrySync re-arms it once the cause is fixed", async () => {
    const target = new ToggleableTarget();
    const store = createTestScanStore({ db: target, cloudBackend: true, loadBusinessData: loader });
    store.getState().setBusinessContext("biz-quar", "user-quar");
    await new Promise((r) => setTimeout(r, 20));

    store.getState().processScan(CODE);
    await new Promise((r) => setTimeout(r, 50));

    // The permission-denied apply quarantined every enqueued item (SAVE_SCAN_EVENT + INCREMENT); they
    // must still be visible/counted locally (TOP-LEVEL LAW), just not yet synced.
    let queued = store.getState().pendingSyncQueue;
    const initialCount = queued.length;
    expect(initialCount).toBeGreaterThan(0);
    expect(queued.every((it) => it.status === "quarantined")).toBe(true);
    expect(store.getState().finalCounts.find((c) => c.productId === "p-quar")?.quantity).toBe(1);

    // Automatic drains (online reconnect / new scan enqueue) must NOT auto-retry a quarantined item.
    store.getState().setOnline(false);
    store.getState().setOnline(true);
    await new Promise((r) => setTimeout(r, 50));
    queued = store.getState().pendingSyncQueue;
    expect(queued).toHaveLength(initialCount);
    expect(queued.every((it) => it.status === "quarantined")).toBe(true);
    expect(target.applied).toHaveLength(0);

    // Now the underlying cause is fixed (e.g. the rules bug is patched).
    target.shouldDeny = false;

    // An automatic drain STILL must not touch it (only explicit retry may re-attempt a terminal failure).
    store.getState().setOnline(false);
    store.getState().setOnline(true);
    await new Promise((r) => setTimeout(r, 50));
    queued = store.getState().pendingSyncQueue;
    expect(queued).toHaveLength(initialCount);
    expect(queued.every((it) => it.status === "quarantined")).toBe(true);
    expect(target.applied).toHaveLength(0);

    // The user-facing explicit Retry action DOES re-attempt quarantined items.
    store.getState().retrySync();
    await new Promise((r) => setTimeout(r, 50));

    expect(target.applied).toHaveLength(initialCount);
    expect(store.getState().pendingSyncQueue).toHaveLength(0);
    expect(store.getState().finalCounts.find((c) => c.productId === "p-quar")?.quantity).toBe(1);
  });
});
