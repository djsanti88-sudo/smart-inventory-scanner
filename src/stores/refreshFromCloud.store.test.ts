import { describe, it, expect, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import type { Product, InventoryCount, InventorySession } from "@/types";

function product(id: string, name: string): Product {
  return {
    id, businessId: "biz1", name, brand: "", category: "", specsShort: "", specsFull: "",
    primarySku: "", primaryBarcode: "", gtin: "", upc: "", ean: "", vendorCodes: [], aliases: [],
    imageUrl: "", productUrl: "", location: "", notes: "", status: "active", source: "manual",
    confidence: 1, verified: true, createdAt: "t", updatedAt: "t", createdBy: "u", updatedBy: "u",
  };
}

function count(sessionId: string, productId: string, quantity: number): InventoryCount {
  return {
    id: `count-${sessionId}-${productId}`, businessId: "biz1", sessionId, productId, quantity,
    lastScannedAt: "t", aliasesSeen: [], scanEventIds: [], createdAt: "t", updatedAt: "t",
    syncStatus: "synced", syncError: null, appliedIdempotencyKeys: [],
  };
}

describe("refreshFromCloud", () => {
  it("is a no-op on the mock/local backend (no loadBusinessData dependency)", async () => {
    const store = createTestScanStore({});
    await store.getState().refreshFromCloud();
    // No throw, no change - the mock path IS the source of truth already.
    expect(store.getState().lastSyncError).toBeNull();
  });

  it("merges remote products/counts ADDITIVELY - a row this device does NOT have locally is added", async () => {
    const remoteProduct = product("p-remote", "Remote Widget");
    const remoteCount = count("s1", "p-remote", 5);
    const remoteSession = {
      id: "s1", businessId: "biz1", name: "Remote Session", location: "Bay A", status: "active",
      startedAt: "t", completedAt: null, createdBy: "u1", notes: "", syncStatus: "synced",
      locked: false, lockedAt: null,
    } as InventorySession;
    const loadBusinessData = vi.fn().mockResolvedValue({
      products: [remoteProduct],
      aliases: [],
      sessions: [remoteSession],
      counts: [remoteCount],
    });
    const store = createTestScanStore({ cloudBackend: true, loadBusinessData });
    store.setState({ businessContextReady: true, businessDataLoaded: true, businessId: "biz1", userId: "u1", sessionId: "s1" });
    await store.getState().refreshFromCloud();
    expect(store.getState().products.find((p) => p.id === "p-remote")).toBeDefined();
    expect(store.getState().finalCounts.find((c) => c.productId === "p-remote")?.quantity).toBe(5);
    expect(store.getState().sessions.find((s) => s.id === "s1")).toEqual(remoteSession);
  });

  it("NEVER overwrites a count row this device still has PENDING in its sync queue (TOP-LEVEL LAW guard)", async () => {
    const remoteCount = count("s1", "p-local", 1); // remote only knows about qty 1 so far
    const loadBusinessData = vi.fn().mockResolvedValue({
      products: [product("p-local", "Local Widget")],
      aliases: [],
      sessions: [],
      counts: [remoteCount],
    });
    const store = createTestScanStore({ cloudBackend: true, loadBusinessData });
    store.setState({
      businessContextReady: true,
      businessDataLoaded: true,
      businessId: "biz1",
      userId: "u1",
      sessionId: "s1",
      // Simulate: this device has ALREADY locally counted this product to 3, with an unsynced item
      // still pending drain (a slow/offline network - the exact scenario Trap C warns about).
      finalCounts: [count("s1", "p-local", 3)],
      pendingSyncQueue: [
        {
          id: "pend1", businessId: "biz1", sessionId: "s1", entityType: "InventoryCount", entityId: "s1_p-local",
          operation: "INCREMENT_COUNT", payload: {}, status: "pending", retryCount: 0, lastError: null,
          createdAt: "t", updatedAt: "t", idempotencyKey: "k1", scanEventId: "ev-local",
        },
      ],
    });
    await store.getState().refreshFromCloud();
    // The local, not-yet-synced count of 3 MUST survive - refreshing must never regress it to the
    // stale remote value of 1.
    expect(store.getState().finalCounts.find((c) => c.productId === "p-local")?.quantity).toBe(3);
  });

  it("does NOT touch scanFeed (scan events are read via getScanEventsBySession, not this action)", async () => {
    const loadBusinessData = vi.fn().mockResolvedValue({ products: [], aliases: [], sessions: [], counts: [] });
    const store = createTestScanStore({ cloudBackend: true, loadBusinessData });
    store.setState({ businessContextReady: true, businessDataLoaded: true, businessId: "biz1", userId: "u1" });
    const before = store.getState().scanFeed;
    await store.getState().refreshFromCloud();
    expect(store.getState().scanFeed).toBe(before); // reference-unchanged: never reassigned
  });
});
