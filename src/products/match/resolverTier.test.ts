import { describe, it, expect } from "vitest";
import { resolveScanToProductTiered, resolveScanToProduct } from "./aliasMatcher";
import { cleanScanCode } from "@/services/scanCleaner";
import type { Product, Alias } from "@/types";

const BID = "b1";
const products: Product[] = [];
const aliases: Alias[] = [];

function makeProduct(overrides: Partial<Product>): Product {
  return {
    id: "p",
    businessId: BID,
    name: "",
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
    createdAt: "",
    updatedAt: "",
    createdBy: "",
    updatedBy: "",
    ...overrides,
  };
}

function makeAlias(overrides: Partial<Alias>): Alias {
  return {
    id: "a",
    businessId: BID,
    productId: "p",
    rawCodeExample: "",
    cleanCode: "",
    normalizedCode: "",
    aliasType: "barcode",
    source: "manual",
    confidence: 1,
    approved: true,
    createdAt: "",
    updatedAt: "",
    createdBy: "",
    lastSeenAt: "",
    syncStatus: "synced",
    idempotencyKey: "",
    ...overrides,
  };
}

describe("resolveScanToProductTiered", () => {
  it("matches today's resolveScanToProduct output when no master candidates are supplied", () => {
    const cleaned = cleanScanCode("0123456789012");
    const tiered = resolveScanToProductTiered(cleaned, { products, aliases }, BID);
    const legacy = resolveScanToProduct(cleaned, products, aliases, BID);
    expect(tiered).toEqual(legacy);
  });

  it("accepts master candidates without changing the outcome when no tenant/master match exists", () => {
    const cleaned = cleanScanCode("0123456789012");
    const tiered = resolveScanToProductTiered(
      cleaned,
      { products, aliases, masterCandidates: [] },
      BID,
    );
    expect(tiered.matchType).toBe("unknown");
  });

  describe("cross-tier conflict matrix (D5)", () => {
    it("(a) alias-vs-barcode: an approved alias for A and a verified primaryBarcode for B -> conflict", () => {
      const code = "CROSSTIER001";
      const a = makeProduct({ id: "prod-a", primaryBarcode: "" });
      const b = makeProduct({ id: "prod-b", primaryBarcode: code });
      const alias = makeAlias({ productId: "prod-a", cleanCode: code, rawCodeExample: code });
      const cleaned = cleanScanCode(code);
      const res = resolveScanToProductTiered(cleaned, { products: [a, b], aliases: [alias] }, BID);
      expect(res.matchType).toBe("conflict");
      expect(res.productId).toBeNull();
      expect(res.conflictProductIds?.slice().sort()).toEqual(["prod-a", "prod-b"]);
    });

    it("(b) UPC-vs-SKU: code hits primary_sku of A and upc of B (different products) -> conflict", () => {
      const code = "CROSSTIER002";
      const a = makeProduct({ id: "prod-a", primarySku: code });
      const b = makeProduct({ id: "prod-b", upc: code });
      const cleaned = cleanScanCode(code);
      const res = resolveScanToProductTiered(cleaned, { products: [a, b], aliases: [] }, BID);
      expect(res.matchType).toBe("conflict");
      expect(res.productId).toBeNull();
      expect(res.conflictProductIds?.slice().sort()).toEqual(["prod-a", "prod-b"]);
    });

    it("(c) all-agree: an approved alias for A AND a verified identifier for the SAME A -> known -> A (no false conflict)", () => {
      const code = "CROSSTIER003";
      const a = makeProduct({ id: "prod-a", primaryBarcode: code });
      const alias = makeAlias({ productId: "prod-a", cleanCode: code, rawCodeExample: code });
      const cleaned = cleanScanCode(code);
      const res = resolveScanToProductTiered(cleaned, { products: [a], aliases: [alias] }, BID);
      expect(res.matchType).not.toBe("conflict");
      expect(res.productId).toBe("prod-a");
    });

    it("(d) tenant-vs-master (synthetic): masterCandidates disagrees with tenant resolution -> conflict", () => {
      const code = "CROSSTIER004";
      const a = makeProduct({ id: "prod-a", primaryBarcode: code });
      const cleaned = cleanScanCode(code);
      const res = resolveScanToProductTiered(
        cleaned,
        {
          products: [a],
          aliases: [],
          masterCandidates: [{ productId: "prod-master-b", matchedOn: code, provenanceTier: "corpus_verified" }],
        },
        BID,
      );
      expect(res.matchType).toBe("conflict");
      expect(res.productId).toBeNull();
      expect(res.conflictProductIds?.slice().sort()).toEqual(["prod-a", "prod-master-b"]);
    });

    it("(d2) tenant-vs-master agreeing on the SAME productId -> known, no false conflict", () => {
      const code = "CROSSTIER005";
      const a = makeProduct({ id: "prod-a", primaryBarcode: code });
      const cleaned = cleanScanCode(code);
      const res = resolveScanToProductTiered(
        cleaned,
        {
          products: [a],
          aliases: [],
          masterCandidates: [{ productId: "prod-a", matchedOn: code, provenanceTier: "corpus_verified" }],
        },
        BID,
      );
      expect(res.matchType).not.toBe("conflict");
      expect(res.productId).toBe("prod-a");
    });

    it("(e) padded-GTIN equivalence: alias stored zero-padded, scan unpadded -> matches the SAME product", () => {
      // 036000291452 (12-digit UPC-A) and its zero-padded 0036000291452 (13-digit EAN-13) are the
      // SAME GTIN identity - only leading-zero padding differs.
      const padded = "0036000291452";
      const unpadded = "036000291452";
      const a = makeProduct({ id: "prod-a" });
      const alias = makeAlias({ productId: "prod-a", cleanCode: padded, rawCodeExample: padded });
      const cleaned = cleanScanCode(unpadded);
      const res = resolveScanToProductTiered(cleaned, { products: [a], aliases: [alias] }, BID);
      expect(res.matchType).not.toBe("conflict");
      expect(res.productId).toBe("prod-a");
    });

    it("(e2) padded-GTIN equivalence across DIFFERENT products -> conflict, never a silent pick", () => {
      const padded = "0100000000007";
      const unpadded = "100000000007";
      const a = makeProduct({ id: "prod-a" });
      const b = makeProduct({ id: "prod-b", primaryBarcode: unpadded });
      const alias = makeAlias({ productId: "prod-a", cleanCode: padded, rawCodeExample: padded });
      const cleaned = cleanScanCode(unpadded);
      const res = resolveScanToProductTiered(cleaned, { products: [a, b], aliases: [alias] }, BID);
      expect(res.matchType).toBe("conflict");
      expect(res.productId).toBeNull();
      expect(res.conflictProductIds?.slice().sort()).toEqual(["prod-a", "prod-b"]);
    });
  });
});
