import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import type { SyncTarget } from "@/services/db/syncTarget";
import type { SyncResult } from "@/services/mockDb";
import type { PendingSyncItem, Product, Alias } from "@/types";

// Loop 2 proof (store logic, no emulator needed): with the Firebase (cloud) backend, sync uses the ASYNC
// drain and REQUIRES a real business context. Without businessId+userId it PAUSES with a visible error
// and writes nothing; setBusinessContext() then drains the queue. The real Firestore writes/idempotency
// are proven separately by firebaseSyncTarget.rules.test.ts (emulator).

class FakeAsyncTarget implements SyncTarget {
  applied: PendingSyncItem[] = [];
  async apply(item: PendingSyncItem): Promise<SyncResult> {
    await Promise.resolve();
    this.applied.push(item);
    return { ok: true, alreadyApplied: false };
  }
  setFailure() {}
  reset() {}
}

const flush = async () => {
  // let the async drain microtasks settle
  await new Promise((r) => setTimeout(r, 0));
};

describe("scanStore Firebase backend wiring (Loop 2)", () => {
  it("cloud backend starts WITHOUT business context ready", () => {
    const store = createTestScanStore({ db: new FakeAsyncTarget(), cloudBackend: true });
    expect(store.getState().businessContextReady).toBe(false);
    expect(store.getState().userId).toBeNull();
  });

  it("pauses sync with a visible error and writes NOTHING when no business context", async () => {
    const target = new FakeAsyncTarget();
    const store = createTestScanStore({ db: target, cloudBackend: true });
    store.getState().processScan("999999999999"); // unknown -> enqueues a sync item
    await flush();
    expect(target.applied).toHaveLength(0); // no fake/default-business writes
    expect(store.getState().lastSyncError).toMatch(/business/i);
    expect(store.getState().pendingSyncQueue.length).toBeGreaterThan(0);
  });

  it("setBusinessContext drops pre-context (foreign-tenant) queue items instead of draining them (contract updated 2026-07-22)", async () => {
    // The original Loop-2 contract drained pre-context items after context arrived. Against the REAL
    // backend that writes another tenant's businessId into the new tenant's path - Firestore rules
    // deny it forever and the item clogs "Waiting to save" permanently (proven by the emulator e2e).
    // The tenant switch wipes that pre-context local state anyway (isolation law), and legacy data
    // continuity is the adopt-flow's job, so the switch now discards foreign-tenant queue items.
    const target = new FakeAsyncTarget();
    const store = createTestScanStore({ db: target, cloudBackend: true });
    store.getState().processScan("999999999999");
    await flush();
    expect(target.applied).toHaveLength(0);

    store.getState().setBusinessContext("biz-real", "user-real");
    await flush();
    expect(store.getState().businessContextReady).toBe(true);
    expect(store.getState().userId).toBe("user-real");
    expect(store.getState().businessId).toBe("biz-real");
    expect(target.applied).toHaveLength(0); // foreign-tenant items are never written to the new tenant
    expect(store.getState().lastSyncError).toBeNull();
    expect(store.getState().pendingSyncQueue).toHaveLength(0); // dropped, not stuck
  });

  it("setBusinessContext loads the business's products/aliases so a scan resolves the approved alias", async () => {
    const CODE = "012345678905";
    const product = {
      id: "p-loaded", businessId: "biz-real", name: "Loaded Widget", brand: "", category: "", specsShort: "", specsFull: "",
      primarySku: "", primaryBarcode: CODE, gtin: "", upc: CODE, ean: "", vendorCodes: [], aliases: [CODE], imageUrl: "",
      productUrl: "", location: "", notes: "", status: "active", source: "human_review", confidence: 1, verified: true,
      createdAt: "t", updatedAt: "t", createdBy: "human", updatedBy: "human",
    } as Product;
    const alias = {
      id: "a-loaded", businessId: "biz-real", productId: "p-loaded", rawCodeExample: CODE, cleanCode: CODE,
      normalizedCode: CODE, aliasType: "upc", source: "human_review", confidence: 1, approved: true, createdAt: "t",
      updatedAt: "t", createdBy: "human", lastSeenAt: "t", syncStatus: "synced", idempotencyKey: "k",
    } as Alias;

    const store = createTestScanStore({
      db: new FakeAsyncTarget(),
      cloudBackend: true,
      loadBusinessData: async () => ({ products: [product], aliases: [alias], sessions: [], counts: [] }),
    });
    store.getState().setBusinessContext("biz-real", "user-real");
    await flush();
    expect(store.getState().products.some((p) => p.id === "p-loaded")).toBe(true);

    const ev = store.getState().processScan(CODE);
    expect(ev?.resolverStatus).toBe("known"); // resolved from the loaded approved alias
    expect(ev?.matchedProductId).toBe("p-loaded");
  });

  it("the mock/local path is unchanged: synchronous drain, no business context required", () => {
    const store = createTestScanStore(); // default mock, cloudBackend false
    expect(store.getState().businessContextReady).toBe(true);
    store.getState().processScan("999999999999");
    // mock path drains synchronously within processScan -> queue already empty, no await needed
    expect(store.getState().pendingSyncQueue).toHaveLength(0);
  });
});
