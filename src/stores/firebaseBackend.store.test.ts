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

  it("setBusinessContext preserves foreign-tenant (pre-context) queue items and never writes them into the new tenant", async () => {
    // Certified tenant-queue model (fix/release-stabilization + tenantQueueIsolation.store.test.ts):
    // a pre-context scan enqueues under the pre-context "demo-business" tenant. Establishing a
    // DIFFERENT tenant ("biz-real") must NOT write those foreign items into biz-real (isolation), but
    // it must also NOT drop them - the sync drain is tenant-aware, so they are preserved and drain
    // only when their own tenant is active again. Nothing clogs under the wrong tenant.
    const target = new FakeAsyncTarget();
    const store = createTestScanStore({ db: target, cloudBackend: true });

    // A pre-context scan enqueues under the pre-context ("demo-business") businessId.
    store.getState().processScan("999999999999");
    await flush();
    expect(target.applied).toHaveLength(0); // paused: no context yet
    const queuedBefore = store.getState().pendingSyncQueue.length;
    expect(queuedBefore).toBeGreaterThan(0);

    store.getState().setBusinessContext("biz-real", "user-real");
    await flush();
    expect(store.getState().businessContextReady).toBe(true);
    expect(store.getState().userId).toBe("user-real");
    expect(store.getState().businessId).toBe("biz-real");
    // Foreign-tenant items are never written to the new tenant, but they are preserved (not dropped).
    expect(target.applied).toHaveLength(0);
    expect(store.getState().pendingSyncQueue.length).toBe(queuedBefore);
    expect(store.getState().pendingSyncQueue.every((q) => q.businessId === "demo-business")).toBe(true);
  });

  it("scans made AFTER setBusinessContext drain to the cloud target", async () => {
    const target = new FakeAsyncTarget();
    const store = createTestScanStore({ db: target, cloudBackend: true });

    store.getState().setBusinessContext("biz-real", "user-real");
    await flush();
    expect(store.getState().businessContextReady).toBe(true);
    expect(store.getState().businessId).toBe("biz-real");

    store.getState().processScan("999999999999"); // enqueues under the active "biz-real" tenant
    await flush();
    expect(target.applied.length).toBeGreaterThan(0); // same-tenant items drain
    expect(store.getState().lastSyncError).toBeNull();
    expect(store.getState().pendingSyncQueue).toHaveLength(0);
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
