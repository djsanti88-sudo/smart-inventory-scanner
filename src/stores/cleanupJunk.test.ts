import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/sync-database/mock/mockDb";
import type { Alias, InventoryCount, Product } from "@/types";

function product(id: string, name: string): Product {
  return {
    id, businessId: "b", name, brand: "", category: "", specsShort: "", specsFull: "",
    primarySku: "", primaryBarcode: "", gtin: "", upc: "", ean: "", vendorCodes: [], aliases: [],
    imageUrl: "", productUrl: "", location: "", notes: "", status: "active", source: "human_review",
    confidence: 1, verified: true, createdAt: "t", updatedAt: "t", createdBy: "x", updatedBy: "x",
  };
}
function count(id: string, productId: string, quantity = 1): InventoryCount {
  return {
    id, businessId: "b", sessionId: "s", productId, quantity, lastScannedAt: "t", aliasesSeen: [],
    scanEventIds: [], createdAt: "t", updatedAt: "t", syncStatus: "synced", syncError: null,
    appliedIdempotencyKeys: [],
  };
}
function alias(id: string, productId: string): Alias {
  return {
    id, businessId: "b", productId, rawCodeExample: id, cleanCode: id, normalizedCode: id,
    aliasType: "barcode", source: "human_review", confidence: 1, approved: true, createdAt: "t",
    updatedAt: "t", createdBy: "x", lastSeenAt: "t", syncStatus: "synced", idempotencyKey: id,
  };
}

function seeded() {
  const store = createTestScanStore({ db: new MockDb() });
  store.setState({
    products: [
      product("p-good", "BIC Classic Pocket Lighter"),
      product("p-junk", "UPC Barcode Search — Look up any UPC, EAN, or ISBN"),
      product("p-junk2", "EANdata"),
    ],
    aliases: [alias("a-good", "p-good"), alias("a-junk", "p-junk"), alias("a-junk2", "p-junk2")],
    finalCounts: [count("c-good", "p-good", 3), count("c-junk", "p-junk", 1), count("c-junk2", "p-junk2", 2)],
  });
  return store;
}

describe("cleanupJunkCounts + undoCleanup (reversible, no data loss)", () => {
  it("removes only junk counts/products/aliases and keeps the good row", () => {
    const store = seeded();
    const res = store.getState().cleanupJunkCounts();

    expect(res.removed).toBe(2);
    const s = store.getState();
    expect(s.finalCounts.map((c) => c.id)).toEqual(["c-good"]);
    expect(s.products.map((p) => p.id)).toEqual(["p-good"]);
    expect(s.aliases.map((a) => a.id)).toEqual(["a-good"]);
    expect(s.lastCleanupBackup?.removedCounts).toHaveLength(2);
  });

  it("undo restores the removed rows exactly and clears the backup", () => {
    const store = seeded();
    store.getState().cleanupJunkCounts();
    const ok = store.getState().undoCleanup();

    expect(ok).toBe(true);
    const s = store.getState();
    expect(s.finalCounts.map((c) => c.id).sort()).toEqual(["c-good", "c-junk", "c-junk2"]);
    expect(s.products.map((p) => p.id).sort()).toEqual(["p-good", "p-junk", "p-junk2"]);
    expect(s.aliases.map((a) => a.id).sort()).toEqual(["a-good", "a-junk", "a-junk2"]);
    expect(s.lastCleanupBackup).toBeNull();
  });

  it("undo preserves scans made AFTER the cleanup (additive restore)", () => {
    const store = seeded();
    store.getState().cleanupJunkCounts();
    // simulate post-cleanup work: a new good count appears
    store.setState({ finalCounts: [...store.getState().finalCounts, count("c-new", "p-good", 1)] });
    store.getState().undoCleanup();
    const ids = store.getState().finalCounts.map((c) => c.id).sort();
    expect(ids).toEqual(["c-good", "c-junk", "c-junk2", "c-new"]);
  });

  it("is a no-op on an all-good inventory (no backup, nothing removed)", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.setState({
      products: [product("p1", "Coca-Cola Classic")],
      finalCounts: [count("c1", "p1", 4)],
      aliases: [],
    });
    const res = store.getState().cleanupJunkCounts();
    expect(res.removed).toBe(0);
    expect(res.backup).toBeNull();
    expect(store.getState().finalCounts).toHaveLength(1);
    expect(store.getState().lastCleanupBackup).toBeNull();
  });

  it("is idempotent: a second cleanup finds nothing left", () => {
    const store = seeded();
    expect(store.getState().cleanupJunkCounts().removed).toBe(2);
    expect(store.getState().cleanupJunkCounts().removed).toBe(0);
  });

  it("undo returns false when there is nothing to undo", () => {
    const store = createTestScanStore({ db: new MockDb() });
    expect(store.getState().undoCleanup()).toBe(false);
  });

  it("applyCleanupSelections removes ONLY the selected count rows", () => {
    const store = seeded();
    const res = store.getState().applyCleanupSelections(["c-junk"]);
    expect(res.removed).toBe(1);
    const s = store.getState();
    expect(s.finalCounts.map((c) => c.id).sort()).toEqual(["c-good", "c-junk2"]); // c-junk2 NOT removed
    expect(s.products.map((p) => p.id).sort()).toEqual(["p-good", "p-junk2"]);
    expect(s.aliases.map((a) => a.id).sort()).toEqual(["a-good", "a-junk2"]);
  });

  it("applyCleanupSelections([]) is a no-op and records nothing", () => {
    const store = seeded();
    const res = store.getState().applyCleanupSelections([]);
    expect(res.removed).toBe(0);
    expect(res.backup).toBeNull();
    expect(store.getState().finalCounts).toHaveLength(3);
  });
});
