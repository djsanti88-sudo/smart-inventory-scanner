import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";

// Phase 2 proof (store): creating a product from a scan registers an APPROVED alias for EVERY code it
// carries (barcode + part number/SKU + GTIN), so scanning ANY of them resolves to the same product.
// This is the "it doesn't matter which code the technician scans" guarantee.

function reviewIdFor(store: ReturnType<typeof createTestScanStore>, cleanCode: string) {
  const r = store.getState().needsReviewQueue.find((x) => x.cleanCode === cleanCode);
  if (!r) throw new Error(`no review for ${cleanCode}`);
  return r.id;
}

describe("multi-code capture on product creation", () => {
  it("registers approved aliases for barcode, part number, and GTIN; any resolves to the product", () => {
    const store = createTestScanStore(); // mock backend, synchronous

    // 1. Scan an unknown retail barcode -> Needs Review.
    store.getState().processScan("700000000001");
    const reviewId = reviewIdFor(store, "700000000001");

    // 2. Owner creates the product, supplying the part number (with a dash) and a GTIN too.
    store.getState().resolveUnknown(reviewId, "create_new", {
      applyToCount: false,
      origin: "human",
      newProduct: {
        name: "Falken Sincera (test)",
        brand: "Falken",
        category: "Tire",
        primaryBarcode: "700000000001",
        primarySku: "9988-7766", // the manufacturer part number / QR value (unique; not in seed)
        gtin: "700000000092",
      },
    });

    const productId = store.getState().products.find((p) => p.name === "Falken Sincera (test)")?.id;
    expect(productId).toBeTruthy();

    // 3. Approved aliases exist for every code (the scanned barcode + part number + GTIN).
    const codes = store.getState().aliases.filter((a) => a.productId === productId && a.approved).map((a) => a.cleanCode);
    expect(codes).toContain("700000000001");
    expect(codes).toContain("9988-7766");
    expect(codes).toContain("700000000092");

    // 4. Scanning ANY of the codes resolves Known to the SAME product...
    const byBarcode = store.getState().processScan("700000000001");
    const byPartNumber = store.getState().processScan("9988-7766");
    const byGtin = store.getState().processScan("700000000092");
    expect(byBarcode?.resolverStatus).toBe("known");
    expect(byPartNumber?.resolverStatus).toBe("known");
    expect(byGtin?.resolverStatus).toBe("known");
    expect(byBarcode?.matchedProductId).toBe(productId);
    expect(byPartNumber?.matchedProductId).toBe(productId);
    expect(byGtin?.matchedProductId).toBe(productId);

    // 5. ...and the no-dash variant of the part number ALSO resolves (separator-insensitive).
    const byNoDash = store.getState().processScan("99887766");
    expect(byNoDash?.resolverStatus).toBe("known");
    expect(byNoDash?.matchedProductId).toBe(productId);
  });

  it("a code scanned and linked to an EXISTING product makes both codes resolve", () => {
    const store = createTestScanStore();
    // create a product from a barcode (no part number yet)
    store.getState().processScan("700000000002");
    store.getState().resolveUnknown(reviewIdFor(store, "700000000002"), "create_new", {
      applyToCount: false,
      origin: "human",
      newProduct: { name: "Tire Needs Part Number", primaryBarcode: "700000000002" },
    });
    const productId = store.getState().products.find((p) => p.name === "Tire Needs Part Number")?.id;

    // later, the part-number QR is scanned (unknown) and LINKED to that product
    store.getState().processScan("5544-3322");
    store.getState().resolveUnknown(reviewIdFor(store, "5544-3322"), "link_existing", {
      applyToCount: false,
      origin: "human",
      productId,
    });

    expect(store.getState().processScan("700000000002")?.matchedProductId).toBe(productId);
    expect(store.getState().processScan("5544-3322")?.matchedProductId).toBe(productId);
    expect(store.getState().processScan("55443322")?.matchedProductId).toBe(productId); // no-dash variant
  });
});
