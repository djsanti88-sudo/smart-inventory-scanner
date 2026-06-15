import { describe, it, expect } from "vitest";
import { decideDecode, isUsableProductName, cleanProductName } from "@/services/ai/decode";
import { emptyResult } from "@/services/ai/provider";
import type { AiLookupResult, EvidenceResult } from "@/types";

describe("product-name quality gate (junk firewall)", () => {
  it("rejects barcode-website / search / error page titles", () => {
    for (const junk of [
      "UPC Barcode Search — Look up any UPC, EAN, or ISBN",
      "Barcode Lookup",
      "Go-UPC",
      "UPCitemdb",
      "Search results",
      "404 Not Found",
      "Page not found",
      "Look up any UPC, EAN, or ISBN",
    ]) {
      expect(isUsableProductName(junk), junk).toBe(false);
    }
  });

  it("rejects placeholders, blanks, and absurd lengths", () => {
    for (const junk of ["", "   ", "Unknown product (EAN 6977228152610)", "no public match found", "x".repeat(200)]) {
      expect(isUsableProductName(junk), junk).toBe(false);
    }
  });

  it("accepts real product names", () => {
    for (const ok of ["BIC Classic Pocket Lighter", "PHATOIL Lavender Essential Oil 100ml", "Camel Crush Box", "BIC Classic Pocket Lighter (Texas)"]) {
      expect(isUsableProductName(ok), ok).toBe(true);
    }
  });

  it("strips barcode-site title cruft (— UPC/EAN <code> — Go-UPC, | Barcode Lookup)", () => {
    expect(cleanProductName("Exclusive Smokes Bic Lighter Texas — UPC 70330645936 — Go-UPC")).toBe("Exclusive Smokes Bic Lighter Texas");
    expect(cleanProductName("Phatoil Lavender Essential Oil 100ml — EAN 6977228152610 — Go-UPC")).toBe("Phatoil Lavender Essential Oil 100ml");
    expect(cleanProductName("Some Product | Barcode Lookup")).toBe("Some Product");
    // real hyphens and parentheticals are preserved
    expect(cleanProductName("Coca-Cola Classic (12 pack)")).toBe("Coca-Cola Classic (12 pack)");
  });

  it("rejects additional barcode-aggregator and store-nav junk titles", () => {
    for (const junk of [
      "EAN-Search",
      "EANdata",
      "GTIN Lookup",
      "Buy UPC codes",
      "Product Lookup",
      "Add to cart",
      "Your Cart",
      "All Categories",
    ]) {
      expect(isUsableProductName(junk), junk).toBe(false);
    }
  });

  it("strips additional barcode-site suffixes while keeping the product", () => {
    expect(cleanProductName("Acme Widget 3000 — EAN-Search")).toBe("Acme Widget 3000");
    expect(cleanProductName("Acme Widget 3000 | EANdata")).toBe("Acme Widget 3000");
    // real names with hyphens and ampersands survive untouched
    expect(cleanProductName("Multi-Surface Cleaner & Degreaser")).toBe("Multi-Surface Cleaner & Degreaser");
  });

  it("strips AI hedge parentheticals but keeps a real name usable", () => {
    const cleaned = cleanProductName("Wholesale Acrylic Paint Markers Set, 24 Metallic Colors (likely wholesale listing)");
    expect(cleaned).not.toMatch(/likely wholesale listing/i);
    expect(cleaned).toContain("Acrylic Paint Markers");
    expect(isUsableProductName(cleaned)).toBe(true);
    // a non-hedge parenthetical (variant) is preserved
    expect(cleanProductName("BIC Classic Pocket Lighter (Texas)")).toContain("(Texas)");
  });
});

describe("decideDecode applies the quality gate", () => {
  it("routes a website-title 'product' to needs_review (not suggested/verified)", () => {
    const d = decideDecode({
      codeType: "ean_13",
      results: [
        { ...emptyResult(), productName: "UPC Barcode Search — Look up any UPC, EAN, or ISBN", confidence: 0.9 },
      ],
      evidences: [{ verified: true, strength: "snippet", matchedCode: "x", matchedSources: ["s"], reason: "" }],
      confidenceThreshold: 0.8,
    });
    expect(d.status).toBe("needs_review");
  });
});

function result(overrides: Partial<AiLookupResult>): AiLookupResult {
  return { ...emptyResult(), confidence: 0.95, ...overrides };
}
const strong = (): EvidenceResult => ({
  verified: true,
  strength: "snippet",
  matchedCode: "049000028904",
  matchedSources: ["snippet"],
  reason: "exact code in snippet",
});
const weak = (): EvidenceResult => ({
  verified: false,
  strength: "url_only",
  matchedCode: "",
  matchedSources: [],
  reason: "url only",
});
const coke = () => result({ productName: "Coca-Cola Classic", brand: "Coca-Cola", upc: "049000028904" });

describe("decideDecode - the gate that produces a Verified AI Decode", () => {
  it("VERIFIED only with provider agreement AND strong app-verified evidence on a public barcode", () => {
    const d = decideDecode({
      codeType: "upc_a",
      results: [coke(), coke()],
      evidences: [strong(), strong()],
      confidenceThreshold: 0.8,
    });
    expect(d.status).toBe("verified");
    expect(d.exactCodeEvidenceVerifiedByApp).toBe(true);
  });

  it("agreement WITHOUT strong evidence stays Suggested/Needs Review (never Verified)", () => {
    const d = decideDecode({
      codeType: "upc_a",
      results: [coke(), coke()],
      evidences: [weak(), weak()],
      confidenceThreshold: 0.8,
    });
    expect(d.status).not.toBe("verified");
    expect(d.exactCodeEvidenceVerifiedByApp).toBe(false);
  });

  it("provider disagreement is a Conflict", () => {
    const a = result({ productName: "Creamer", brand: "Laird" });
    const b = result({ productName: "Receptacle", brand: "Leviton" });
    const d = decideDecode({ codeType: "upc_a", results: [a, b], evidences: [strong(), strong()], confidenceThreshold: 0.8 });
    expect(d.status).toBe("conflict");
  });

  it("NEVER verifies a vendor label (X00/FNSKU), even with agreement and strong evidence", () => {
    const a = result({ productName: "Amazon FBA Label", brand: "Amazon" });
    const b = result({ productName: "Amazon FBA Label", brand: "Amazon" });
    const d = decideDecode({
      codeType: "vendor_label",
      results: [a, b],
      evidences: [strong(), strong()],
      confidenceThreshold: 0.8,
    });
    expect(d.status).not.toBe("verified");
  });

  it("single provider can verify only with strong evidence + thresholds on a public barcode", () => {
    const ok = decideDecode({ codeType: "upc_a", results: [coke()], evidences: [strong()], confidenceThreshold: 0.8 });
    expect(ok.status).toBe("verified");
    const weakOne = decideDecode({ codeType: "upc_a", results: [coke()], evidences: [weak()], confidenceThreshold: 0.8 });
    expect(weakOne.status).not.toBe("verified");
  });

  it("does not verify when below the confidence threshold", () => {
    const d = decideDecode({
      codeType: "upc_a",
      results: [result({ ...coke(), confidence: 0.5 })],
      evidences: [strong()],
      confidenceThreshold: 0.8,
    });
    expect(d.status).not.toBe("verified");
  });

  it("does not verify when product identity is empty", () => {
    const d = decideDecode({
      codeType: "upc_a",
      results: [result({ productName: "", brand: "", confidence: 0.95 })],
      evidences: [strong()],
      confidenceThreshold: 0.8,
    });
    expect(d.status).not.toBe("verified");
  });

  it("a single provider with a product + sources but weak evidence is SUGGESTED, never blank", () => {
    const d = decideDecode({
      codeType: "upc_a",
      results: [result({ productName: "BIC Classic Pocket Lighter", brand: "BIC", sourceUrls: ["https://x"] })],
      evidences: [weak()],
      confidenceThreshold: 0.8,
    });
    expect(d.status).toBe("suggested"); // show the sourced product, do NOT bury it in Needs Review
  });

  it("treats a placeholder name (Unknown product / no match) as NO product -> needs_review", () => {
    for (const name of ["Unknown product (EAN 6977228152610)", "UNKNOWN - no public match found", "Not found", "unidentified item"]) {
      const d = decideDecode({
        codeType: "ean_13",
        results: [result({ productName: name, brand: "" })],
        evidences: [weak()],
        confidenceThreshold: 0.8,
      });
      expect(d.status, name).toBe("needs_review");
    }
  });

  it("only returns needs_review when NO provider produced a usable product", () => {
    const d = decideDecode({
      codeType: "upc_a",
      results: [result({ productName: "", brand: "" })],
      evidences: [weak()],
      confidenceThreshold: 0.8,
    });
    expect(d.status).toBe("needs_review");
  });

  it("a vendor label with a product result is Suggested (still needs human approval, but not blank)", () => {
    const d = decideDecode({
      codeType: "vendor_label",
      results: [result({ productName: "Amazon FBA Label", brand: "Amazon" })],
      evidences: [strong()],
      confidenceThreshold: 0.8,
    });
    expect(d.status).toBe("suggested");
  });
});
