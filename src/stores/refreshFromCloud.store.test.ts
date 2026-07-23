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

  it("NEVER clobbers a product this device still has a PENDING SAVE_PRODUCT edit for (Task 1 refresh-race guard)", async () => {
    const remoteProduct = product("p-edited", "Stale Remote Name"); // server has not seen the local edit yet
    const loadBusinessData = vi.fn().mockResolvedValue({
      products: [remoteProduct],
      aliases: [],
      sessions: [],
      counts: [],
    });
    const store = createTestScanStore({ cloudBackend: true, loadBusinessData });
    store.setState({
      businessContextReady: true,
      businessDataLoaded: true,
      businessId: "biz1",
      userId: "u1",
      sessionId: "s1",
      // This device has a locally corrected name for the SAME product, still unsynced.
      products: [product("p-edited", "Locally Corrected Name")],
      pendingSyncQueue: [
        {
          id: "pend-prod", businessId: "biz1", sessionId: "s1", entityType: "Product", entityId: "p-edited",
          operation: "SAVE_PRODUCT", payload: product("p-edited", "Locally Corrected Name"), status: "pending",
          retryCount: 0, lastError: null, createdAt: "t", updatedAt: "t", idempotencyKey: "k-prod-edit", scanEventId: null,
        },
      ],
    });
    await store.getState().refreshFromCloud();
    // The local, not-yet-synced edit MUST survive - refreshing must never regress it to the stale remote name.
    expect(store.getState().products.find((p) => p.id === "p-edited")?.name).toBe("Locally Corrected Name");
  });

  it("NEVER double-counts a DELETED product: the backend's stale count row is not re-added alongside the repointed provisional (reviewed defect 2026-07-22)", async () => {
    // The backend still holds the pre-delete snapshot: the product active, its count row at qty 2.
    const remoteProduct = { ...product("p-del", "Junk Widget"), primaryBarcode: "888888888881" };
    const loadBusinessData = vi.fn().mockResolvedValue({
      products: [remoteProduct],
      aliases: [],
      sessions: [],
      counts: [count("s1", "p-del", 2)],
    });
    const store = createTestScanStore({ cloudBackend: true, loadBusinessData });
    store.setState({
      businessContextReady: true, businessDataLoaded: true, businessId: "biz1", userId: "u1", sessionId: "s1",
      products: [{ ...remoteProduct }],
      finalCounts: [count("s1", "p-del", 2)],
    });
    const total = () => store.getState().finalCounts.reduce((sum, c) => sum + c.quantity, 0);

    // Delete repoints the 2 units onto a minted "Unidentified item" provisional (quantity invariant).
    store.getState().deleteProduct("p-del");
    expect(total()).toBe(2);

    await store.getState().refreshFromCloud();

    // The remote row keyed (s1, p-del) must NOT come back next to the repointed provisional row
    // (2 must never become 4), and the archived product must stay archived, not resurrect as active.
    expect(total()).toBe(2);
    expect(store.getState().finalCounts.some((c) => c.productId === "p-del")).toBe(false);
    expect(store.getState().products.find((p) => p.id === "p-del")?.status).toBe("archived");
  });

  it("takes the remote ZEROED row when the delete happened on ANOTHER device: the stale local row must not survive next to the remote provisional (cross-device inflation, reviewed defect 2026-07-22)", async () => {
    // Devices A and B share the business. Both held (s1, p-del) qty 2, fully synced. Device B then
    // deleted p-del: the backend now says p-del archived, its count row zeroed, and the 2 units
    // repointed onto a minted provisional p-prov. Device A (this store) still holds the pre-delete
    // local state with NOTHING pending - the remote is the post-transfer truth and must win.
    const archivedRemote = { ...product("p-del", "Junk Widget"), status: "archived" as const };
    const remoteProvisional = { ...product("p-prov", "Unidentified item"), verified: false, provisional: true };
    const loadBusinessData = vi.fn().mockResolvedValue({
      products: [archivedRemote, remoteProvisional],
      aliases: [],
      sessions: [],
      counts: [count("s1", "p-del", 0), count("s1", "p-prov", 2)],
    });
    const store = createTestScanStore({ cloudBackend: true, loadBusinessData });
    store.setState({
      businessContextReady: true, businessDataLoaded: true, businessId: "biz1", userId: "u1", sessionId: "s1",
      products: [product("p-del", "Junk Widget")], // still active locally - A has not seen the delete yet
      finalCounts: [count("s1", "p-del", 2)], // synced pre-delete row, no pending queue items
    });

    await store.getState().refreshFromCloud();

    // 2 physical items must total 2, never 4: the stale local (s1, p-del)=2 row is replaced by the
    // remote zeroed row, and only the remote provisional carries the quantity.
    const total = store.getState().finalCounts.reduce((sum, c) => sum + c.quantity, 0);
    expect(total).toBe(2);
    expect(store.getState().finalCounts.find((c) => c.productId === "p-del")?.quantity ?? 0).toBe(0);
    expect(store.getState().finalCounts.find((c) => c.productId === "p-prov")?.quantity).toBe(2);
    expect(store.getState().products.find((p) => p.id === "p-del")?.status).toBe("archived");
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
