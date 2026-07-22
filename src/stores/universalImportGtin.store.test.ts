import { describe, expect, it } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import type { ImportPreviewRow } from "@/services/importSchema";

// DEFECT 1 (padded-GTIN equivalence law, shipped P5): applyUniversalImport aggregates/keys imported
// rows on the RAW barcode string. Importing the same tire once as a 12-digit UPC and once as its
// zero-padded 13-digit EAN must collapse to ONE product carrying the summed quantity - not two.
// canonicalGtin() already exists (src/services/upc/gtin.ts) for exactly this equivalence.

// A GTIN-shaped barcode row. Two padded encodings of the same GTIN must resolve to one product, so
// they must share the same resolved identity signature (candidate.uid) - keying them on the raw
// string is the bug under test.
function gtinRow(status: "exact" | "fuzzy", barcode: string, uid: string, quantity: number): ImportPreviewRow {
  return {
    line: 2,
    status,
    reason: status === "exact" ? "Barcode hit for exact candidate." : "Character-level fuzzy candidate.",
    confidence: status === "exact" ? 1 : 0.8,
    candidate: { uid, brand: "Michelin", name: "Defender", barcode },
    source: {
      line: 2,
      partNumber: "",
      barcode,
      name: "",
      brand: "Michelin",
      model: "Defender",
      size: "225/45R18",
      category: "Tires",
      quantity,
      uom: "each",
      expected: {
        externalId: barcode,
        partNumbers: [],
        brand: "Michelin",
        model: "Defender",
        sizeText: "225/45R18",
        qty: quantity,
        raw: {},
      },
    },
  };
}

// A non-GTIN part-number row. It must NEVER be canonicalized (leading zeros carry meaning in a part
// number) and must never merge with a numeric barcode row just because both start with digits.
function partNumberRow(partNumber: string, quantity: number): ImportPreviewRow {
  return {
    line: 3,
    status: "exact",
    reason: "Part number hit for exact candidate.",
    confidence: 1,
    candidate: { uid: `uid-${partNumber}`, brand: "Acme", name: "Widget", partNumber },
    source: {
      line: 3,
      partNumber,
      barcode: "",
      name: "",
      brand: "Acme",
      model: "Widget",
      size: "",
      category: "Parts",
      quantity,
      uom: "each",
      expected: {
        externalId: partNumber,
        partNumbers: [partNumber],
        brand: "Acme",
        model: "Widget",
        sizeText: "",
        qty: quantity,
        raw: {},
      },
    },
  };
}

describe("applyUniversalImport padded-GTIN equivalence (DEFECT 1)", () => {
  it("merges a 12-digit UPC and its zero-padded 13-digit EAN into ONE product with the summed quantity", () => {
    const store = createTestScanStore();
    // 086699866707 (UPC-A) and 0086699866707 (zero-padded EAN-13) are the SAME product.
    const uid = "uid-michelin-defender";
    const rowUpc = gtinRow("exact", "086699866707", uid, 2);
    const rowEan = gtinRow("exact", "0086699866707", uid, 3);
    const summary = store.getState().applyUniversalImport([rowUpc, rowEan]);

    // Exactly ONE product, applied once, carrying the summed 5 units - not two products.
    expect(summary).toEqual({ applied: 1, queuedForReview: 0, rejected: 0 });
    const after = store.getState();
    const countedProducts = after.finalCounts.map((c) => c.productId);
    expect(new Set(countedProducts).size).toBe(1);
    expect(after.finalCounts.reduce((sum, c) => sum + c.quantity, 0)).toBe(5);
    // Raw preservation (project law): the original scanned barcode string is kept on the product.
    const product = after.products.find((p) => after.finalCounts.some((c) => c.productId === p.id));
    expect(product?.primaryBarcode).toBe("086699866707");
  });

  it("does NOT merge a non-GTIN part number with a numeric barcode (leading zeros preserved)", () => {
    const store = createTestScanStore();
    // "0086699" is a part number, not a GTIN shape - it must stay its own identity.
    const rowPart = partNumberRow("0086699", 4);
    const rowGtin = gtinRow("exact", "086699866707", "uid-michelin-defender", 1);
    const summary = store.getState().applyUniversalImport([rowPart, rowGtin]);

    expect(summary.applied).toBe(2);
    const after = store.getState();
    expect(new Set(after.finalCounts.map((c) => c.productId)).size).toBe(2);
    expect(after.finalCounts.reduce((sum, c) => sum + c.quantity, 0)).toBe(5);
  });
});
