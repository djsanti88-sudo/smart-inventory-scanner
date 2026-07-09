import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

// Decode ladder Task 9 (store wiring): applying a decode result runs identity-merge first.
//  - auto_link (same canonical GTIN across encodings) attaches the scanned code as a new alias on the
//    EXISTING product and increments it - never a duplicate product row.
//  - suggest_link (fuzzy brand+name / plus-generation) raises a Needs Review "link to existing product?"
//    item with the productId attached, and never auto-counts a merge.

const qtyFor = (store: ReturnType<typeof createTestScanStore>, productId: string) =>
  store.getState().finalCounts.find((c) => c.productId === productId)?.quantity ?? 0;

describe("scanStore identity-merge on decode apply", () => {
  it("second code whose decode carries the SAME GTIN links to the same row (qty 2, 2 aliases, one product)", () => {
    const store = createTestScanStore({ db: new MockDb() });
    const before = store.getState().products.length;

    // Scan a UPC, decode applied -> product created, counted once.
    store.getState().processScan("036000291452");
    const r1 = store.getState().needsReviewQueue.find((r) => r.cleanCode === "036000291452" && r.status === "open")!.id;
    store.getState().resolveUnknown(r1, "create_new", {
      applyToCount: true,
      origin: "ai",
      newProduct: { name: "Duracell AA 4pk", brand: "Duracell", category: "Battery", primaryBarcode: "036000291452", gtin: "036000291452" },
    });
    const p1 = store.getState().products.find((p) => p.brand === "Duracell")!;
    expect(p1, "first decode creates the product").toBeDefined();
    expect(store.getState().products.length).toBe(before + 1);
    expect(qtyFor(store, p1.id)).toBe(1);

    // Scan a DIFFERENT code (e.g. a vendor SKU) whose decode carries the SAME GTIN in a different encoding.
    store.getState().processScan("VENDOR-SKU-77");
    const r2 = store.getState().needsReviewQueue.find((r) => r.cleanCode === "VENDOR-SKU-77" && r.status === "open")!.id;
    store.getState().resolveUnknown(r2, "create_new", {
      applyToCount: true,
      origin: "ai",
      newProduct: { name: "Duracell AA 4-pack", brand: "Duracell", category: "Battery", gtin: "0036000291452" },
    });

    // identity-merge auto_link: SAME row, quantity 2, no duplicate product, both codes aliased to it.
    expect(store.getState().products.length, "no duplicate product minted").toBe(before + 1);
    expect(store.getState().products.filter((p) => p.brand === "Duracell")).toHaveLength(1);
    expect(qtyFor(store, p1.id), "existing row counted again -> quantity 2").toBe(2);
    const aliasesForP1 = store.getState().aliases.filter((a) => a.productId === p1.id && a.approved);
    expect(aliasesForP1.some((a) => a.cleanCode === "036000291452")).toBe(true);
    expect(aliasesForP1.some((a) => a.cleanCode === "VENDOR-SKU-77")).toBe(true);
    expect(aliasesForP1.length, "two aliases point at the one product").toBeGreaterThanOrEqual(2);
  });

  it("a fuzzy brand+name match (no GTIN) raises a suggest-link review, never auto-counts a merge", () => {
    const store = createTestScanStore({ db: new MockDb() });

    store.getState().processScan("111111111116");
    const r1 = store.getState().needsReviewQueue.find((r) => r.cleanCode === "111111111116" && r.status === "open")!.id;
    store.getState().resolveUnknown(r1, "create_new", {
      applyToCount: true,
      origin: "ai",
      newProduct: { name: "Voltrek GX9 265/70R17", brand: "Zephyra", category: "Tire", primaryBarcode: "111111111116" },
    });
    // Grab the product WE created (by its code), not any seed Falken product.
    const p1 = store.getState().products.find((p) => p.primaryBarcode === "111111111116")!;
    expect(p1, "our decoded product exists").toBeDefined();
    const productCount = store.getState().products.length;

    // A DIFFERENT code, decode fuzzily matches the existing product by brand + name (no shared GTIN).
    store.getState().processScan("222222222220");
    const r2 = store.getState().needsReviewQueue.find((r) => r.cleanCode === "222222222220" && r.status === "open")!.id;
    store.getState().resolveUnknown(r2, "create_new", {
      applyToCount: true,
      origin: "ai",
      newProduct: { name: "Voltrek GX9 265/70R17", brand: "Zephyra", category: "Tire" },
    });

    // No auto-merge: the review stays open with the existing product attached as a suggested link, and NO
    // duplicate Falken product was minted for the fuzzy match.
    const r2after = store.getState().needsReviewQueue.find((r) => r.id === r2)!;
    expect(r2after.status, "suggest-link keeps the review open for the human").toBe("open");
    expect(r2after.suggestedLinkProductId, "existing product attached as a link suggestion").toBe(p1.id);
    // The second scan still counted provisionally (scan N = count N) against its own placeholder - that is
    // the ONLY new row (productCount + 1); suggest_link mints NO additional product for the fuzzy match.
    const placeholder = store.getState().products.find((p) => p.provisional && p.primaryBarcode === "222222222220");
    expect(placeholder, "the second scan's provisional placeholder survives").toBeDefined();
    expect(qtyFor(store, placeholder!.id)).toBe(1);
    expect(store.getState().products.length, "only the provisional placeholder, no merged duplicate").toBe(productCount + 1);
    // And no SECOND real (non-provisional) product was minted from the fuzzy decode.
    expect(store.getState().products.filter((p) => p.brand === "Zephyra" && !p.provisional)).toHaveLength(1);
  });
});
