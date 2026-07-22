import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

// Phase 1 (+ 2026-07-22 delete-transfer): deleting a saved product archives it + un-verifies it +
// deactivates ALL its aliases + TRANSFERS its counted quantity onto an Unidentified provisional
// (TOP-LEVEL LAW: scanned quantity never vanishes) + repoints its feed rows, so the code never
// re-matches the deleted product. Reversible via undoDeleteProduct. Deleting one duplicate must not
// touch the others. Transfer specifics: deleteCountTransfer.store.test.ts.

function addProduct(store: ReturnType<typeof createTestScanStore>, code: string, over: { name: string; brand?: string }) {
  store.getState().processScan(code);
  const reviewId = store.getState().needsReviewQueue.at(-1)!.id;
  store.getState().resolveUnknown(reviewId, "create_new", {
    applyToCount: true, origin: "ai",
    newProduct: { name: over.name, brand: over.brand ?? "", primaryBarcode: code },
  });
  return store.getState().products.find((p) => p.name === over.name)!;
}
const qty = (store: ReturnType<typeof createTestScanStore>, productId: string) =>
  store.getState().finalCounts.find((c) => c.productId === productId)?.quantity ?? 0;

describe("scanStore - deleteProduct (reversible, frees the code)", () => {
  it("archives the product, deactivates its aliases, and removes its count", () => {
    const store = createTestScanStore({ db: new MockDb() });
    const p = addProduct(store, "888888888881", { name: "Widget", brand: "Acme" });
    expect(qty(store, p.id)).toBe(1);
    expect(store.getState().aliases.some((a) => a.productId === p.id && a.approved)).toBe(true);

    const backup = store.getState().deleteProduct(p.id);
    expect(backup).not.toBeNull();
    const after = store.getState().products.find((x) => x.id === p.id)!;
    expect(after.status).toBe("archived");
    expect(after.verified).toBe(false);
    expect(store.getState().aliases.filter((a) => a.productId === p.id).every((a) => !a.approved)).toBe(true);
    expect(qty(store, p.id)).toBe(0);
    expect(store.getState().finalCounts.some((c) => c.productId === p.id)).toBe(false);
  });

  it("the freed code re-scans against the Unidentified provisional carrying the transferred count, NOT the deleted product", () => {
    const store = createTestScanStore({ db: new MockDb() });
    const p = addProduct(store, "888888888881", { name: "Widget", brand: "Acme" });
    store.getState().deleteProduct(p.id);

    // 2026-07-22 (delete-transfer): the deleted product's count moved onto a counted, UNVERIFIED
    // "Unidentified item" provisional. The Phase-2 re-scan dedup bridge therefore counts a re-scan
    // deterministically against that provisional (identity still unconfirmed) instead of opening a
    // duplicate review - same as scanning any unknown code twice.
    const ev = store.getState().processScan("888888888881");
    expect(ev?.matchedProductId).not.toBe(p.id); // never re-matches the deleted product
    const matched = store.getState().products.find((x) => x.id === ev?.matchedProductId);
    expect(matched?.provisional).toBe(true);
    expect(matched?.verified).toBe(false);
    expect(qty(store, p.id)).toBe(0);
    expect(qty(store, matched!.id)).toBe(2); // transferred 1 + re-scan 1: nothing lost, nothing duplicated
  });

  it("Undo restores the product, its aliases, and its count exactly", () => {
    const store = createTestScanStore({ db: new MockDb() });
    const p = addProduct(store, "888888888881", { name: "Widget", brand: "Acme" });
    store.getState().deleteProduct(p.id);
    expect(store.getState().undoDeleteProduct()).toBe(true);

    const restored = store.getState().products.find((x) => x.id === p.id)!;
    expect(restored.status).toBe("active");
    expect(restored.verified).toBe(true);
    expect(store.getState().aliases.some((a) => a.productId === p.id && a.approved)).toBe(true);
    expect(qty(store, p.id)).toBe(1);
    // and the code resolves deterministically again
    const ev = store.getState().processScan("888888888881");
    expect(ev?.matchedProductId).toBe(p.id);
  });

  it("deleting one duplicate leaves the others untouched", () => {
    const store = createTestScanStore({ db: new MockDb() });
    const p1 = addProduct(store, "111111111116", { name: "Dup A", brand: "Acme" });
    const p2 = addProduct(store, "222222222220", { name: "Dup B", brand: "Acme" });

    store.getState().deleteProduct(p1.id);
    const after2 = store.getState().products.find((x) => x.id === p2.id)!;
    expect(after2.status).toBe("active");
    expect(after2.verified).toBe(true);
    expect(store.getState().aliases.some((a) => a.productId === p2.id && a.approved)).toBe(true);
    expect(qty(store, p2.id)).toBe(1);
  });

  it("is idempotent and a no-op for an unknown id", () => {
    const store = createTestScanStore({ db: new MockDb() });
    expect(store.getState().deleteProduct("nope")).toBeNull();
  });
});

describe("scanStore - purgePoisonedProducts", () => {
  it("removes non-protected products on the poison code 745125495781 and leaves seed/manual products", () => {
    const store = createTestScanStore({ db: new MockDb() });
    const seedCount = store.getState().products.length;
    const poison = addProduct(store, "745125495781", { name: "Manstel 200 Pcs Aluminum Rivet Screw Kit", brand: "Manstel" });

    const { removed } = store.getState().purgePoisonedProducts();
    expect(removed).toBeGreaterThan(0);
    expect(store.getState().products.find((x) => x.id === poison.id)!.status).toBe("archived");
    expect(qty(store, poison.id)).toBe(0);
    // seed products are untouched
    expect(store.getState().products.filter((p) => p.source === "seed").length).toBe(
      store.getState().products.slice(0, seedCount).filter((p) => p.source === "seed").length,
    );
    // undo restores the purge too
    expect(store.getState().undoDeleteProduct()).toBe(true);
    expect(store.getState().products.find((x) => x.id === poison.id)!.status).toBe("active");
  });
});
