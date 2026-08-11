import { describe, expect, it } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import type { Alias, InventoryCount, InventorySession, Product } from "@/types";

type LoadedData = {
  products: Product[];
  aliases: Alias[];
  sessions: InventorySession[];
  counts: InventoryCount[];
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function product(id: string, businessId: string): Product {
  return {
    id,
    businessId,
    name: id,
    brand: "",
    category: "",
    specsShort: "",
    specsFull: "",
    primarySku: "",
    primaryBarcode: "",
    gtin: "",
    upc: "",
    ean: "",
    vendorCodes: [],
    aliases: [],
    imageUrl: "",
    productUrl: "",
    location: "",
    notes: "",
    status: "active",
    source: "manual",
    confidence: 1,
    verified: true,
    createdAt: "t",
    updatedAt: "t",
    createdBy: "human",
    updatedBy: "human",
  };
}

const dataFor = (entry: Product): LoadedData => ({
  products: [entry],
  aliases: [],
  sessions: [],
  counts: [],
});

describe("business loader context generation", () => {
  it("publishes the complete cloud session list during first-context hydration", async () => {
    const load = deferred<LoadedData>();
    const store = createTestScanStore({
      cloudBackend: true,
      loadBusinessData: () => load.promise,
    });
    const restored = {
      id: "session-cloud",
      businessId: "business-a",
      name: "Cloud session",
      location: "Main",
      status: "active",
      startedAt: "2026-08-10T12:00:00.000Z",
      completedAt: null,
      createdBy: "user-1",
      notes: "",
      syncStatus: "synced",
      deviceId: "device-a",
    } satisfies InventorySession;

    store.getState().setBusinessContext("business-a", "user-1");
    load.resolve({ ...dataFor(product("product-a", "business-a")), sessions: [restored] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.getState().currentSession?.id).toBe(restored.id);
    expect(store.getState().sessions).toEqual([restored]);
  });

  it("ignores tenant A when its loader resolves after tenant B", async () => {
    const a = deferred<LoadedData>();
    const b = deferred<LoadedData>();
    const store = createTestScanStore({
      cloudBackend: true,
      loadBusinessData: (businessId) => (businessId === "business-a" ? a.promise : b.promise),
    });

    store.getState().setBusinessContext("business-a", "user-1");
    store.getState().setBusinessContext("business-b", "user-1");

    b.resolve(dataFor(product("product-b", "business-b")));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getState().businessId).toBe("business-b");
    expect(store.getState().products.map((entry) => entry.id)).toEqual(["product-b"]);

    a.resolve(dataFor(product("product-a", "business-a")));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.getState().businessId).toBe("business-b");
    expect(store.getState().products.map((entry) => entry.id)).toEqual(["product-b"]);
    expect(store.getState().businessDataLoaded).toBe(true);
  });

  it("clears tenant A catalog and session state immediately while tenant B loads", () => {
    const b = deferred<LoadedData>();
    const store = createTestScanStore({
      cloudBackend: true,
      loadBusinessData: () => b.promise,
    });
    store.setState({
      businessId: "business-a",
      userId: "user-1",
      products: [product("product-a", "business-a")],
      aliases: [{ id: "alias-a", businessId: "business-a", productId: "product-a" } as Alias],
      sessions: [{ id: "session-a", businessId: "business-a", status: "active" } as InventorySession],
      currentSession: { id: "session-a", businessId: "business-a", status: "active" } as InventorySession,
      sessionId: "session-a",
      finalCounts: [{ id: "count-a", businessId: "business-a", sessionId: "session-a" } as InventoryCount],
      countSnapshots: [{ id: "snapshot-a" } as never],
    });

    store.getState().setBusinessContext("business-b", "user-1");

    expect(store.getState()).toMatchObject({
      businessId: "business-b",
      products: [],
      aliases: [],
      sessions: [],
      currentSession: null,
      sessionId: "",
      finalCounts: [],
      countSnapshots: [],
      businessDataLoaded: false,
    });
  });

  it("keeps tenant B empty when its load fails and ignores a later tenant A resolution", async () => {
    const a = deferred<LoadedData>();
    const b = deferred<LoadedData>();
    const store = createTestScanStore({
      cloudBackend: true,
      loadBusinessData: (businessId) => (businessId === "business-a" ? a.promise : b.promise),
    });

    store.setState({
      businessId: "seed",
      userId: "user-1",
      products: [product("seed-product", "seed")],
    });
    store.getState().setBusinessContext("business-a", "user-1");
    store.getState().setBusinessContext("business-b", "user-1");

    b.reject(new Error("business B unavailable"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.getState()).toMatchObject({
      businessId: "business-b",
      products: [],
      aliases: [],
      sessions: [],
      currentSession: null,
      sessionId: "",
      finalCounts: [],
      // A failed hard tenant load stays fail-closed so the gate cannot render persisted cache.
      businessDataLoaded: false,
      lastSyncError: "business B unavailable",
    });

    a.resolve(dataFor(product("late-product-a", "business-a")));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getState().businessId).toBe("business-b");
    expect(store.getState().products).toEqual([]);
  });
});
