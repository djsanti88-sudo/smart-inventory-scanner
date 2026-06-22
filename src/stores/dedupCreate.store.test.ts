import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";
import type { Product } from "@/types";

// Phase 1 data-correctness: resolveUnknown(create_new) must NOT mint a fresh product when the scanned
// identity already belongs to one. Every auto-add path funnels through create_new, so without dedup one
// barcode became dozens of rows (the 235x "Manstel rivet kit" bug). Reuse exactly one match; route >1 to
// review.

const qtyFor = (store: ReturnType<typeof createTestScanStore>, productId: string) =>
  store.getState().finalCounts.find((c) => c.productId === productId)?.quantity ?? 0;

function verifiedProduct(businessId: string, over: Partial<Product> & { id: string }): Product {
  return {
    businessId, name: "X", brand: "", category: "", specsShort: "", specsFull: "",
    primarySku: "", primaryBarcode: "", gtin: "", upc: "", ean: "", vendorCodes: [], aliases: [], imageUrl: "",
    productUrl: "", location: "", notes: "", status: "active", source: "manual", confidence: 1, verified: true,
    createdAt: "t", updatedAt: "t", createdBy: "seed", updatedBy: "seed", ...over,
  };
}

describe("scanStore - dedup on create_new (one product per identity)", () => {
  it("two create_new auto-adds of the SAME barcode identity => ONE product, quantity 2 (not two rows)", () => {
    const store = createTestScanStore({ db: new MockDb() });
    const before = store.getState().products.length;

    // First auto-add: a brand-new barcode -> new product P1, counted once.
    store.getState().processScan("888888888881");
    const r1 = store.getState().needsReviewQueue.at(-1)!.id;
    store.getState().resolveUnknown(r1, "create_new", {
      applyToCount: true, origin: "ai",
      newProduct: { name: "Cooper Discoverer A/T3", brand: "Cooper", category: "Tire", primaryBarcode: "888888888881" },
    });
    const p1 = store.getState().products.find((p) => p.brand === "Cooper")!;
    expect(p1, "first auto-add creates the product").toBeDefined();
    expect(store.getState().products.length).toBe(before + 1);
    expect(qtyFor(store, p1.id)).toBe(1);

    // Second auto-add reaches create_new again via a DIFFERENT scanned code but carrying the SAME barcode
    // identity (alias-miss cascade). The dedup guard must reuse P1, not mint a duplicate.
    store.getState().processScan("RAW-PACKING-SLIP-REF");
    const r2 = store.getState().needsReviewQueue.at(-1)!.id;
    store.getState().resolveUnknown(r2, "create_new", {
      applyToCount: true, origin: "ai",
      newProduct: { name: "Cooper Discoverer A/T3", brand: "Cooper", category: "Tire", primaryBarcode: "888888888881" },
    });

    expect(store.getState().products.length, "no duplicate product minted").toBe(before + 1);
    expect(store.getState().products.filter((p) => p.brand === "Cooper")).toHaveLength(1);
    expect(qtyFor(store, p1.id), "existing row counted again -> quantity 2").toBe(2);
    // The second scanned code is now an approved alias pointing at the same product.
    expect(store.getState().aliases.some((a) => a.cleanCode === "RAW-PACKING-SLIP-REF" && a.productId === p1.id && a.approved)).toBe(true);
  });

  it("a re-scan of the same barcode counts the existing product (alias path), never a second row", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().processScan("888888888881");
    const r1 = store.getState().needsReviewQueue.at(-1)!.id;
    store.getState().resolveUnknown(r1, "create_new", {
      applyToCount: true, origin: "ai",
      newProduct: { name: "Widget", brand: "Acme", primaryBarcode: "888888888881" },
    });
    const p1 = store.getState().products.find((p) => p.brand === "Acme")!;
    const productCount = store.getState().products.length;

    store.getState().processScan("888888888881"); // deterministic alias hit
    expect(store.getState().products.length).toBe(productCount);
    expect(qtyFor(store, p1.id)).toBe(2);
  });

  it("when the identity matches MORE THAN ONE existing product => Needs Review (never guess, no new row)", () => {
    const store = createTestScanStore({ db: new MockDb() });
    // Two distinct verified products, each owning a different identifier (scoped to the store's business).
    const bizId = store.getState().businessId;
    store.setState((s) => ({
      products: [
        ...s.products,
        verifiedProduct(bizId, { id: "prod-A", name: "Alpha", upc: "111111111116" }),
        verifiedProduct(bizId, { id: "prod-B", name: "Beta", primaryBarcode: "222222222220" }),
      ],
    }));
    const before = store.getState().products.length;

    store.getState().processScan("333333333334"); // a fresh unknown -> review
    const r = store.getState().needsReviewQueue.at(-1)!.id;
    // The proposed new product carries identifiers that match BOTH prod-A (upc) and prod-B (primaryBarcode).
    store.getState().resolveUnknown(r, "create_new", {
      applyToCount: true, origin: "ai",
      newProduct: { name: "Ambiguous", upc: "111111111116", primaryBarcode: "222222222220" },
    });

    expect(store.getState().products.length, "no product minted on ambiguous identity").toBe(before);
    const review = store.getState().needsReviewQueue.find((x) => x.id === r)!;
    expect(review.status, "stays in Needs Review for a human to pick").toBe("open");
    const conflicts = store.getState().lastAliasConflicts ?? [];
    expect(conflicts.length, "both candidate products surfaced as a conflict").toBeGreaterThan(1);
  });
});
