import { describe, it, expect } from "vitest";
import { createTestScanStore, transferOrphanCount } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";
import type { InventoryCount } from "@/types";

// TOP-LEVEL LAW (owner, 2026-07-15, re-affirmed 2026-07-22): scan N = count N. Deleting a product
// must never make scanned quantity vanish from the session totals - the physical items are still on
// the shelf; only the identity was wrong/junk. Root-caused 2026-07-22: deleteProductsInternal dropped
// the finalCounts rows outright (feed 124 / counts 122 class). The fix transfers the deleted
// product's count rows onto a minted "Unidentified item" provisional, exactly like markWrong.

function addCountedProduct(store: ReturnType<typeof createTestScanStore>, code: string, name: string) {
  store.getState().processScan(code);
  const reviewId = store.getState().needsReviewQueue.at(-1)!.id;
  store.getState().resolveUnknown(reviewId, "create_new", {
    applyToCount: true, origin: "ai",
    newProduct: { name, primaryBarcode: code },
  });
  return store.getState().products.find((p) => p.name === name)!;
}
const totalUnits = (store: ReturnType<typeof createTestScanStore>) =>
  store.getState().finalCounts.reduce((sum, c) => sum + c.quantity, 0);

describe("scanStore - deleteProduct preserves total counted quantity (law: scan N = count N)", () => {
  it("deleting a counted product transfers its quantity to an Unidentified provisional, never loses it", () => {
    const store = createTestScanStore({ db: new MockDb() });
    const p = addCountedProduct(store, "888888888881", "Junk Auto-Add");
    store.getState().processScan("888888888881"); // second unit -> qty 2
    expect(totalUnits(store)).toBe(2);
    const feedLenBefore = store.getState().scanFeed.length;

    store.getState().deleteProduct(p.id);

    // The deleted product's own rows are gone...
    expect(store.getState().finalCounts.some((c) => c.productId === p.id)).toBe(false);
    // ...but the TOTAL never drops: the quantity moved onto an unidentified provisional.
    expect(totalUnits(store)).toBe(2);
    const prov = store.getState().products.find(
      (x) => x.provisional === true && x.status !== "archived" && x.primaryBarcode === "888888888881",
    );
    expect(prov).toBeDefined();
    expect(store.getState().finalCounts.find((c) => c.productId === prov!.id)?.quantity).toBe(2);
    // Feed rows survive and point at the provisional (history kept, identity reopened).
    expect(store.getState().scanFeed.length).toBe(feedLenBefore);
    expect(
      store.getState().scanFeed.filter((e) => e.cleanCode === "888888888881").every((e) => e.matchedProductId === prov!.id),
    ).toBe(true);
  });

  it("undo restores the original product's count and removes the minted provisional - total stays invariant throughout", () => {
    const store = createTestScanStore({ db: new MockDb() });
    const p = addCountedProduct(store, "888888888881", "Junk Auto-Add");
    store.getState().processScan("888888888881");
    store.getState().deleteProduct(p.id);
    expect(totalUnits(store)).toBe(2);

    expect(store.getState().undoDeleteProduct()).toBe(true);

    expect(store.getState().finalCounts.find((c) => c.productId === p.id)?.quantity).toBe(2);
    expect(totalUnits(store)).toBe(2); // never 4 (double count) and never 0 (loss)
    // The minted provisional carries no count anymore and is gone (or archived) - no clutter row.
    const leftoverProv = store.getState().products.find(
      (x) => x.provisional === true && x.status === "active" && x.primaryBarcode === "888888888881" && x.id !== p.id,
    );
    expect(leftoverProv).toBeUndefined();
  });

  it("scan the provisional AFTER delete, then undo: new scan's count survives on the provisional, transferred qty returns to the original, total exact", () => {
    const store = createTestScanStore({ db: new MockDb() });
    const p = addCountedProduct(store, "888888888881", "Junk Auto-Add");
    store.getState().processScan("888888888881"); // qty 2
    store.getState().deleteProduct(p.id);
    const prov = store.getState().products.find(
      (x) => x.provisional === true && x.status !== "archived" && x.primaryBarcode === "888888888881",
    )!;
    store.getState().processScan("888888888881"); // NEW physical unit lands on the provisional -> 3
    expect(totalUnits(store)).toBe(3);

    expect(store.getState().undoDeleteProduct()).toBe(true);

    // Transferred 2 back on the original; the genuinely new post-delete scan stays on the provisional.
    expect(store.getState().finalCounts.find((c) => c.productId === p.id)?.quantity).toBe(2);
    expect(store.getState().finalCounts.find((c) => c.productId === prov.id)?.quantity).toBe(1);
    expect(store.getState().products.some((x) => x.id === prov.id && x.status === "active")).toBe(true); // still counted -> kept
    expect(totalUnits(store)).toBe(3);
  });

  it("SYNCS the delete-transfer to the backend: old count row zeroed, provisional row counted, product archived (reviewed defect 2026-07-22: unsynced repoint let refreshFromCloud double the quantity)", () => {
    const db = new MockDb();
    const store = createTestScanStore({ db });
    const p = addCountedProduct(store, "888888888881", "Junk Auto-Add");
    store.getState().processScan("888888888881"); // qty 2
    const sessionId = store.getState().sessionId;
    expect(db.getServerCount(sessionId, p.id)?.quantity).toBe(2); // backend saw the counts

    store.getState().deleteProduct(p.id);

    const prov = store.getState().products.find(
      (x) => x.provisional === true && x.status !== "archived" && x.primaryBarcode === "888888888881",
    )!;
    // The backend row keyed to the deleted product is zeroed, the provisional carries the 2 units,
    // and the product itself is archived server-side - so a later refreshFromCloud can never
    // resurrect the deleted product's quantity alongside the repointed provisional row.
    expect(db.getServerCount(sessionId, p.id)?.quantity).toBe(0);
    expect(db.getServerCount(sessionId, prov.id)?.quantity).toBe(2);
    expect(db.snapshot().products[p.id]?.status).toBe("archived");
    expect(db.snapshot().products[prov.id]).toBeDefined();
  });

  it("SYNCS the undo: backend restores the product active, moves the quantity back off the provisional (reviewed defect 2026-07-22: local-only undo was re-reverted + doubled by the next refreshFromCloud)", () => {
    const db = new MockDb();
    const store = createTestScanStore({ db });
    const p = addCountedProduct(store, "888888888881", "Junk Auto-Add");
    store.getState().processScan("888888888881"); // qty 2
    const sessionId = store.getState().sessionId;
    store.getState().deleteProduct(p.id);
    const prov = store.getState().products.find(
      (x) => x.provisional === true && x.status !== "archived" && x.primaryBarcode === "888888888881",
    )!;
    expect(db.getServerCount(sessionId, prov.id)?.quantity).toBe(2); // delete ops drained

    expect(store.getState().undoDeleteProduct()).toBe(true);

    // Backend mirrors the undo exactly: product active again with its 2 units back, the minted
    // provisional zeroed and archived - so a later refreshFromCloud can neither re-delete the
    // undone product nor re-add the transferred quantity alongside the restored row (2 -> 4 class).
    expect(db.snapshot().products[p.id]?.status).toBe("active");
    expect(db.getServerCount(sessionId, p.id)?.quantity).toBe(2);
    expect(db.getServerCount(sessionId, prov.id)?.quantity).toBe(0);
    expect(db.snapshot().products[prov.id]?.status).toBe("archived");
  });

  it("SYNCS the undo after a post-delete scan: server splits residual exactly - original back to 2, provisional keeps the 1 new unit and stays active", () => {
    const db = new MockDb();
    const store = createTestScanStore({ db });
    const p = addCountedProduct(store, "888888888881", "Junk Auto-Add");
    store.getState().processScan("888888888881"); // qty 2
    const sessionId = store.getState().sessionId;
    store.getState().deleteProduct(p.id);
    const prov = store.getState().products.find(
      (x) => x.provisional === true && x.status !== "archived" && x.primaryBarcode === "888888888881",
    )!;
    store.getState().processScan("888888888881"); // NEW physical unit lands on the provisional
    expect(db.getServerCount(sessionId, prov.id)?.quantity).toBe(3);

    expect(store.getState().undoDeleteProduct()).toBe(true);

    // Only the transferred 2 move back; the genuinely new unit stays on the provisional server-side too.
    expect(db.getServerCount(sessionId, p.id)?.quantity).toBe(2);
    expect(db.getServerCount(sessionId, prov.id)?.quantity).toBe(1);
    expect(db.snapshot().products[prov.id]?.status).toBe("active"); // still counted -> kept remotely
  });

  it("a deleted product with ZERO counted quantity mints nothing (no ghost provisionals)", () => {
    const store = createTestScanStore({ db: new MockDb() });
    const p = addCountedProduct(store, "777777777775", "Zero Qty");
    // Remove its count first via the store's own session-only remove (intended count reducer).
    store.getState().removeFromCount(p.id);
    expect(totalUnits(store)).toBe(0);
    const productsBefore = store.getState().products.length;

    store.getState().deleteProduct(p.id);

    expect(store.getState().products.length).toBe(productsBefore); // archived in place, nothing minted
    expect(totalUnits(store)).toBe(0);
  });
});

describe("transferOrphanCount - session-scoped (never merges across sessions)", () => {
  const row = (over: Partial<InventoryCount>): InventoryCount => ({
    id: "c1", businessId: "b", sessionId: "s1", productId: "p1", quantity: 1, lastScannedAt: "",
    aliasesSeen: [], scanEventIds: [], createdAt: "", updatedAt: "", syncStatus: "synced",
    syncError: null, appliedIdempotencyKeys: [], ...over,
  });

  it("transfers the orphan onto the SAME-session target row, not a foreign session's row", () => {
    const counts = [
      row({ id: "target-other", productId: "target", sessionId: "OTHER", quantity: 5 }),
      row({ id: "orphan-a", productId: "orphan", sessionId: "s1", quantity: 2, scanEventIds: ["e1", "e2"] }),
    ];
    const next = transferOrphanCount(counts, "orphan", "target", "2026-07-22T00:00:00Z");
    // Foreign-session row untouched.
    expect(next.find((c) => c.id === "target-other")?.quantity).toBe(5);
    // Orphan's quantity lands on a target row IN ITS OWN session.
    const sameSession = next.find((c) => c.productId === "target" && c.sessionId === "s1");
    expect(sameSession?.quantity).toBe(2);
    expect(sameSession?.scanEventIds).toEqual(["e1", "e2"]);
    // Total is invariant.
    expect(next.reduce((s, c) => s + c.quantity, 0)).toBe(7);
  });

  it("merges into an existing same-session target row and stays idempotent on ledger fields", () => {
    const counts = [
      row({ id: "target-same", productId: "target", sessionId: "s1", quantity: 3, scanEventIds: ["t1"] }),
      row({ id: "orphan-a", productId: "orphan", sessionId: "s1", quantity: 2, scanEventIds: ["e1", "t1"] }),
    ];
    const next = transferOrphanCount(counts, "orphan", "target", "2026-07-22T00:00:00Z");
    const merged = next.find((c) => c.productId === "target" && c.sessionId === "s1");
    expect(merged?.quantity).toBe(5);
    expect(merged?.scanEventIds?.sort()).toEqual(["e1", "t1"]); // unioned, deduped
    expect(next.reduce((s, c) => s + c.quantity, 0)).toBe(5);
  });
});
