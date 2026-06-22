import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

// Repro for the duplicate-product bug: a product is counted, then a persist/session reset drops its
// approved alias AND its `verified` flag (exactly what the customer-safe persist does on reload -
// sanitizeProduct strips primaryBarcode/verified, aliases are not persisted) WHILE its finalCounts row
// survives. A re-scan of the same barcode can no longer match via approved-alias OR verified-identifier,
// so create_new used to mint a SECOND product row for the same identity. The dedup must reuse the still-
// counted product (deterministic exact identifier match), never duplicate.

const qtyFor = (store: ReturnType<typeof createTestScanStore>, productId: string) =>
  store.getState().finalCounts.find((c) => c.productId === productId)?.quantity ?? 0;

function autoAdd(store: ReturnType<typeof createTestScanStore>, code: string, name: string) {
  store.getState().processScan(code);
  const review = store.getState().needsReviewQueue.find((r) => r.cleanCode === code && r.status === "open");
  if (!review) return;
  store.getState().resolveUnknown(review.id, "create_new", {
    applyToCount: true, origin: "ai",
    newProduct: { name, brand: "Cooper", primaryBarcode: code },
  });
}

describe("scanStore - dedup an orphaned counted product (alias + verified dropped by reset)", () => {
  it("re-scan after the reset reuses the still-counted product, never duplicates", () => {
    const store = createTestScanStore({ db: new MockDb() });

    // 1. Auto-add + count the Cooper tire on 029142712886.
    autoAdd(store, "029142712886", "Cooper Discoverer A/T3 Neumatico Radial - E1");
    const p1 = store.getState().products.find((p) => p.brand === "Cooper")!;
    expect(p1, "first auto-add creates the product").toBeDefined();
    expect(qtyFor(store, p1.id)).toBe(1);

    // 2. Simulate the customer-style persist reset: approved alias dropped + `verified` flag lost, but the
    //    finalCounts row survives (the product is still actively counted this session).
    store.setState((s) => ({
      aliases: [],
      products: s.products.map((p) => (p.id === p1.id ? { ...p, verified: false } : p)),
    }));
    expect(store.getState().aliases.length).toBe(0);

    // 3. Re-scan the SAME barcode. The resolver misses (no approved alias, product no longer verified) and
    //    routes to create_new auto-add - the exact path that used to mint a duplicate.
    autoAdd(store, "029142712886", "Cooper Discoverer A/T3 E (10 Ply) BW");

    // ASSERT: still exactly ONE product row for this barcode identity, quantity incremented to 2.
    const rows = store.getState().products.filter((p) => p.primaryBarcode === "029142712886" && p.status !== "archived");
    expect(rows.length, "exactly one product row for the barcode identity").toBe(1);
    expect(qtyFor(store, rows[0].id), "the existing row was counted again -> qty 2").toBe(2);
    // and the freed code is a deterministic approved alias again (re-scan now resolves with no AI)
    expect(store.getState().aliases.some((a) => a.cleanCode === "029142712886" && a.approved)).toBe(true);
  });

  it("does NOT reuse a product whose count was removed (markWrong path stays distinct)", () => {
    const store = createTestScanStore({ db: new MockDb() });
    autoAdd(store, "029142712886", "Cooper Discoverer A/T3");
    const p1 = store.getState().products.find((p) => p.brand === "Cooper")!;
    // Remove the count (as markWrong does) and drop alias + verified: this product is NO LONGER counted.
    store.getState().removeFromCount(p1.id);
    store.setState((s) => ({ aliases: [], products: s.products.map((p) => (p.id === p1.id ? { ...p, verified: false } : p)) }));

    autoAdd(store, "029142712886", "Cooper Discoverer A/T3 E (10 Ply) BW");
    // A new product IS created (the un-counted old row is not silently reused), but still only ONE counted row.
    const counted = store.getState().finalCounts.filter((c) => c.quantity > 0);
    expect(counted.length).toBe(1);
  });
});
