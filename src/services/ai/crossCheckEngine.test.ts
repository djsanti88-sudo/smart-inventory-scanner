import { describe, it, expect } from "vitest";
import { crossCheck } from "@/services/ai/crossCheckEngine";
import { emptyResult } from "@/services/ai/provider";
import type { AiLookupResult } from "@/types";

function result(overrides: Partial<AiLookupResult>): AiLookupResult {
  return { ...emptyResult(), ...overrides };
}

describe("CrossCheckEngine - structural comparison, not string equality", () => {
  it("agrees when brand, name tokens, and barcode line up (even with different phrasing)", () => {
    const a = result({ productName: "Coca-Cola Classic Soda 12 oz", brand: "Coca-Cola", upc: "049000028904" });
    const b = result({ productName: "Coca Cola Classic 12oz Can", brand: "coca cola", upc: "049000028904" });
    const r = crossCheck(a, b);
    expect(r.decision).toBe("agree");
    expect(r.brandSimilarity).toBeGreaterThan(0.7);
    expect(r.contradictions).toHaveLength(0);
  });

  it("flags a CONFLICT when brands disagree", () => {
    const a = result({ productName: "Creamer", brand: "Laird Superfood" });
    const b = result({ productName: "Receptacle", brand: "Leviton" });
    const r = crossCheck(a, b);
    expect(r.decision).toBe("conflict");
    expect(r.contradictions.join(" ")).toMatch(/brand/i);
  });

  it("flags a CONFLICT when barcodes disagree", () => {
    const a = result({ productName: "Item", brand: "BrandX", upc: "049000028904" });
    const b = result({ productName: "Item", brand: "BrandX", upc: "111111111111" });
    const r = crossCheck(a, b);
    expect(r.decision).toBe("conflict");
    expect(r.contradictions.join(" ")).toMatch(/barcode|upc|gtin|ean/i);
  });

  it("returns single_provider when only one provider responded", () => {
    const a = result({ productName: "Coca-Cola Classic", brand: "Coca-Cola" });
    expect(crossCheck(a, null).decision).toBe("single_provider");
    expect(crossCheck(null, a).decision).toBe("single_provider");
  });

  it("returns weak when providers share a brand but products look unrelated", () => {
    const a = result({ productName: "Whey Protein Vanilla", brand: "Generic" });
    const b = result({ productName: "Garden Hose 50ft", brand: "Generic" });
    const r = crossCheck(a, b);
    expect(r.decision).toBe("weak");
  });

  it("returns weak when both providers are empty", () => {
    expect(crossCheck(null, null).decision).toBe("weak");
  });
});
