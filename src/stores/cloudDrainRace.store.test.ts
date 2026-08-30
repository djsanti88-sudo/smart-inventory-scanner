import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import type { SyncTarget } from "@/sync-database/syncTarget";
import type { SyncResult } from "@/sync-database/mock/mockDb";
import type { Alias, InventoryCount, InventorySession, PendingSyncItem, Product } from "@/types";

// Regression (cloud sync): rapid scans enqueue while an async drain is in flight. The drain must NOT
// overwrite the queue with its start-of-pass snapshot (that previously CLOBBERED concurrently-enqueued
// items, silently losing counts even though "pending" reached 0). Every enqueued op must reach the target.

class SlowTarget implements SyncTarget {
  applied: PendingSyncItem[] = [];
  async apply(item: PendingSyncItem): Promise<SyncResult> {
    // A real network round-trip: yields the event loop so more scans can enqueue mid-drain.
    await new Promise((r) => setTimeout(r, 5));
    this.applied.push(item);
    return { ok: true, alreadyApplied: false };
  }
  setFailure() {}
  reset() {}
}

const CODE = "111222333444";
const product = {
  id: "p-race", businessId: "biz-race", name: "Race Widget", brand: "", category: "", specsShort: "", specsFull: "",
  primarySku: "", primaryBarcode: CODE, gtin: "", upc: "", ean: "", vendorCodes: [], aliases: [CODE], imageUrl: "",
  productUrl: "", location: "", notes: "", status: "active", source: "manual", confidence: 1, verified: true,
  createdAt: "t", updatedAt: "t", createdBy: "human", updatedBy: "human",
} as Product;
const alias = {
  id: "a-race", businessId: "biz-race", productId: "p-race", rawCodeExample: CODE, cleanCode: CODE,
  normalizedCode: CODE, aliasType: "barcode", source: "manual", confidence: 1, approved: true, createdAt: "t",
  updatedAt: "t", createdBy: "human", lastSeenAt: "t", syncStatus: "synced", idempotencyKey: "k",
} as Alias;

const loader = async () => ({ products: [product], aliases: [alias], sessions: [] as InventorySession[], counts: [] as InventoryCount[] });

describe("cloud drain race (regression)", () => {
  it("does not lose ops enqueued while an async drain is in flight", async () => {
    const target = new SlowTarget();
    const store = createTestScanStore({ db: target, cloudBackend: true, loadBusinessData: loader });
    store.getState().setBusinessContext("biz-race", "user-race");
    await new Promise((r) => setTimeout(r, 20)); // let context + data load settle

    const N = 6;
    for (let i = 0; i < N; i++) store.getState().processScan(CODE); // rapid known scans (each: SAVE_SCAN_EVENT + INCREMENT)

    // Wait for all chained drains to finish.
    await new Promise((r) => setTimeout(r, 300));

    const increments = target.applied.filter((i) => i.operation === "INCREMENT_COUNT");
    expect(increments).toHaveLength(N); // every increment reached the target - none clobbered
    expect(store.getState().pendingSyncQueue).toHaveLength(0); // queue fully drained
    expect(store.getState().finalCounts.find((c) => c.productId === "p-race")?.quantity).toBe(N);
  });
});
