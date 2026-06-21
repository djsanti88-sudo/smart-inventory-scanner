import { describe, it, expect } from "vitest";
import { decodeBarcodeStructure, deriveBrandPrefixHints } from "@/services/ai/barcodeAnatomy";
import type { Alias, Product } from "@/types";

const BASE_PRODUCT: Product = {
  id: "p", businessId: "b", name: "X", brand: "", category: "", specsShort: "", specsFull: "", primarySku: "",
  primaryBarcode: "", gtin: "", upc: "", ean: "", vendorCodes: [], aliases: [], imageUrl: "", productUrl: "",
  location: "", notes: "", status: "active", source: "human_review", confidence: 1, verified: true,
  createdAt: "", updatedAt: "", createdBy: "human", updatedBy: "human",
};
const BASE_ALIAS: Alias = {
  id: "a", businessId: "b", productId: "p", rawCodeExample: "", cleanCode: "", normalizedCode: "",
  aliasType: "upc", source: "human_review", confidence: 1, approved: true, createdAt: "", updatedAt: "",
  createdBy: "human", lastSeenAt: "", syncStatus: "pending", idempotencyKey: "k",
};
const prod = (over: Partial<Product>): Product => ({ ...BASE_PRODUCT, ...over });
const alias = (over: Partial<Alias>): Alias => ({ ...BASE_ALIAS, ...over });

describe("decodeBarcodeStructure (Phase 8)", () => {
  it("decomposes a UPC-A into region + candidate prefix + item reference + check-digit status", () => {
    const s = decodeBarcodeStructure("745125495781", "upc_a");
    expect(s.normalizedCode).toBe("745125495781");
    expect(s.gs1RegionHint).toMatch(/United States and Canada/);
    expect(s.candidateCompanyPrefix).toBe("0745125"); // CANDIDATE only (variable-length in reality)
    expect(s.itemReference).toBe("49578");
    expect(typeof s.checkDigitValid).toBe("boolean");
    expect(s.disclaimer).toContain("GS1 numbering authority region only");
  });

  it("validates the mod-10 check digit", () => {
    expect(decodeBarcodeStructure("049000028904", "upc_a").checkDigitValid).toBe(true); // real Coke UPC
    expect(decodeBarcodeStructure("049000028905", "upc_a").checkDigitValid).toBe(false);
  });

  it("returns safe nulls for non-public codes (vendor label / SKU)", () => {
    const v = decodeBarcodeStructure("X004DY7YUT", "vendor_label");
    expect(v.gs1RegionHint).toBeNull();
    expect(v.candidateCompanyPrefix).toBeNull();
    expect(v.checkDigitValid).toBeNull();
  });
});

describe("deriveBrandPrefixHints (approved business catalog only)", () => {
  it("learns brand from an approved alias + branded product", () => {
    const hints = deriveBrandPrefixHints([prod({ id: "p1", brand: "Falken" })], [alias({ productId: "p1", cleanCode: "877184001785", approved: true })]);
    expect(hints).toContainEqual({ prefix: "0877184", brand: "falken" });
  });

  it("does NOT learn from an unapproved alias", () => {
    const hints = deriveBrandPrefixHints([prod({ id: "p1", brand: "Falken" })], [alias({ productId: "p1", cleanCode: "877184001785", approved: false })]);
    expect(hints).toHaveLength(0);
  });

  it("marks a prefix ambiguous (skips) when two brands share it", () => {
    const products = [prod({ id: "p1", brand: "Falken" }), prod({ id: "p2", brand: "Fortune" })];
    const aliases = [
      alias({ id: "a1", productId: "p1", cleanCode: "877184001785", approved: true }),
      alias({ id: "a2", productId: "p2", cleanCode: "877184999990", approved: true }),
    ];
    expect(deriveBrandPrefixHints(products, aliases).find((h) => h.prefix === "0877184")).toBeUndefined();
  });
});
