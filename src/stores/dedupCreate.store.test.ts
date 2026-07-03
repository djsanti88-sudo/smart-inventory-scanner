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

    // FIX 1 (owner rule "scan N = count N"): the conflict RETAINS the scan's own provisional placeholder
    // (minted + counted by processScan) instead of deleting it, so products.length is before + 1. The real
    // dedup invariant still holds: NO duplicate "Ambiguous" product is minted for the ambiguous identity.
    expect(store.getState().products.length, "only the scan's own retained placeholder, no duplicate minted").toBe(before + 1);
    expect(store.getState().products.some((p) => p.name === "Ambiguous"), "no product minted on ambiguous identity").toBe(false);
    const placeholder = store.getState().products.find((p) => p.provisional && p.primaryBarcode === "333333333334");
    expect(placeholder, "the scan's provisional placeholder survives the conflict").toBeDefined();
    expect(qtyFor(store, placeholder!.id), "the already-taken count is preserved (not dropped)").toBe(1);
    const review = store.getState().needsReviewQueue.find((x) => x.id === r)!;
    expect(review.status, "stays in Needs Review for a human to pick").toBe("open");
    const conflicts = store.getState().lastAliasConflicts ?? [];
    expect(conflicts.length, "both candidate products surfaced as a conflict").toBeGreaterThan(1);
  });

  it("FIX 1: a conflict PRESERVES the scanned count (scan 3 = count 3); link_existing transfers the full 3", () => {
    const store = createTestScanStore({ db: new MockDb() });
    const bizId = store.getState().businessId;
    // Two distinct verified owners of DIFFERENT identifiers (the plausible legacy-data multi-owner case).
    store.setState((s) => ({
      products: [
        ...s.products,
        verifiedProduct(bizId, { id: "prod-A", name: "Alpha", upc: "111111111116" }),
        verifiedProduct(bizId, { id: "prod-B", name: "Beta", primaryBarcode: "222222222220" }),
      ],
    }));
    const before = store.getState().products.length;

    // Scan a FRESH unknown code 3 times -> its provisional placeholder count = 3 (scan N = count N).
    store.getState().processScan("333333333334");
    store.getState().processScan("333333333334");
    store.getState().processScan("333333333334");
    const placeholder = store.getState().products.find((p) => p.provisional && p.primaryBarcode === "333333333334")!;
    expect(placeholder, "provisional placeholder minted for the scanned code").toBeDefined();
    expect(qtyFor(store, placeholder.id), "3 physical scans counted").toBe(3);
    expect(store.getState().products.length).toBe(before + 1);

    // A create_new auto-add proposes an identity that matches BOTH pre-existing owners -> multi-owner conflict.
    const r = store.getState().needsReviewQueue.find((x) => x.cleanCode === "333333333334" && x.status === "open")!.id;
    store.getState().resolveUnknown(r, "create_new", {
      applyToCount: true, origin: "ai",
      newProduct: { name: "Ambiguous", upc: "111111111116", primaryBarcode: "222222222220" },
    });

    // The 3 counts are NOT lost: the placeholder + its count survive, review stays open.
    const stillThere = store.getState().products.find((p) => p.id === placeholder.id);
    expect(stillThere, "placeholder retained through the conflict").toBeDefined();
    expect(qtyFor(store, placeholder.id), "all 3 counts preserved (never silently dropped)").toBe(3);
    expect(store.getState().needsReviewQueue.find((x) => x.id === r)!.status).toBe("open");

    // Human resolves the conflict by linking to prod-A: the FULL retained 3 transfer onto prod-A.
    store.getState().resolveUnknown(r, "link_existing", { productId: "prod-A", applyToCount: true });
    expect(qtyFor(store, "prod-A"), "full 3 transferred to the linked product").toBe(3);
    expect(store.getState().products.some((p) => p.id === placeholder.id), "placeholder merged away, no duplicate row").toBe(false);
    expect(store.getState().products.filter((p) => p.provisional && p.primaryBarcode === "333333333334"), "no leftover duplicate placeholder").toHaveLength(0);
  });
});
