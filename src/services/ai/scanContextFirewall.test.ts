import { describe, it, expect } from "vitest";
import { classifyProductDomain, detectScanContextConflict, detectIdentityContextConflict, detectBrandPrefixAdvisory } from "@/services/ai/scanContextFirewall";
import type { AiLookupResult } from "@/types";

const r = (over: Partial<AiLookupResult>): AiLookupResult => ({
  productName: "", brand: "", category: "", specsShort: "", specsFull: "", primarySku: "", primaryBarcode: "",
  gtin: "", upc: "", ean: "", aliases: [], imageUrl: "", productUrl: "", sourceUrls: [], confidence: 0,
  verifiedFacts: [], guesses: [], needsHumanReview: false, ...over,
});

describe("classifyProductDomain", () => {
  it("classifies tire / non_tire / unknown", () => {
    expect(classifyProductDomain(r({ productName: "Falken Wildpeak A/T 275/55R20 111T" }))).toBe("tire");
    expect(classifyProductDomain(r({ productName: "Manstel 200 Pcs Aluminum Core Blind Rivet Screw Kit" }))).toBe("non_tire");
    expect(classifyProductDomain(r({ productName: "Generic Thing" }))).toBe("unknown");
  });
});

describe("detectScanContextConflict (Phase 8 firewall)", () => {
  it("745125495781 rivet kit in TIRE context -> category_context_conflict", () => {
    const result = r({ productName: "Manstel 200 Pcs Aluminum Core Blind Rivet Semi-Round Head Screw Kit M3.2X11mm" });
    expect(detectScanContextConflict({ scanContext: "tire", code: "745125495781", codeType: "upc_a", result, brandPrefixHints: [] })).toBe("category_context_conflict");
  });

  it("a valid tire with specs in tire context -> no conflict", () => {
    const result = r({ productName: "Fortune Tormenta A/T 275/55R20 117T", brand: "Fortune", specsShort: "275/55R20 117T" });
    expect(detectScanContextConflict({ scanContext: "tire", code: "745125495781", codeType: "upc_a", result, brandPrefixHints: [] })).toBeNull();
  });

  it("PLAN C: brand contradiction vs an unambiguous learned prefix is ADVISORY now - no longer a blocking conflict", () => {
    // Reconciled (Plan C Task 2): the brand-prefix arm is demoted. A brand mismatch vs a learned prefix used
    // to return "brand_prefix_conflict" (a block). GS1 prefixes are many-to-one, so it must not block by
    // itself; it is surfaced via detectBrandPrefixAdvisory() as a soft, non-blocking flag instead.
    const result = r({ productName: "Some Snack", brand: "Manstel" });
    const hints = [{ prefix: "0745125", brand: "fortune" }];
    expect(detectScanContextConflict({ scanContext: "any", code: "745125495781", codeType: "upc_a", result, brandPrefixHints: hints })).toBeNull();
    expect(detectBrandPrefixAdvisory({ code: "745125495781", codeType: "upc_a", result, brandPrefixHints: hints })).toBe(true);
  });

  it("no learned prefix + ambiguous product -> no false conflict", () => {
    const result = r({ productName: "Generic Thing", brand: "Whatever" });
    expect(detectScanContextConflict({ scanContext: "any", code: "745125495781", codeType: "upc_a", result, brandPrefixHints: [] })).toBeNull();
  });

  it("non-tire product in ANY (non-tire) context -> no category conflict", () => {
    const result = r({ productName: "Manstel Rivet Kit" });
    expect(detectScanContextConflict({ scanContext: "any", code: "745125495781", codeType: "upc_a", result, brandPrefixHints: [] })).toBeNull();
  });
});

describe("detectIdentityContextConflict (Phase 8C side-door firewall)", () => {
  it("a non-tire product matched deterministically in TIRE context -> category_context_conflict", () => {
    // Product.name (not productName) is the stored-product field; the helper must map it.
    const product = { name: "Manstel 200 Pcs Aluminum Core Blind Rivet Semi-Round Head Screw Kit M3.2X11mm" };
    expect(detectIdentityContextConflict("tire", product)).toBe("category_context_conflict");
  });

  it("also accepts the AI-style productName field", () => {
    expect(detectIdentityContextConflict("tire", { productName: "Aluminum Rivet Screw Kit" })).toBe("category_context_conflict");
  });

  it("a real tire product in tire context -> no conflict", () => {
    const product = { name: "Fortune Tormenta A/T 275/55R20 117T", brand: "Fortune", category: "Tires" };
    expect(detectIdentityContextConflict("tire", product)).toBeNull();
  });

  it("non-tire product in ANY context -> no conflict (firewall is opt-in to tire)", () => {
    expect(detectIdentityContextConflict("any", { name: "Manstel Rivet Kit" })).toBeNull();
  });

  it("ambiguous / unknown product in tire context -> no false conflict (prefer unknown over wrong block)", () => {
    expect(detectIdentityContextConflict("tire", { name: "Generic Thing" })).toBeNull();
  });

  it("null / undefined identity -> null", () => {
    expect(detectIdentityContextConflict("tire", null)).toBeNull();
    expect(detectIdentityContextConflict("tire", undefined)).toBeNull();
  });
});

describe("brand-FAMILY suppression via the tire prefix hint table (Phase 11)", () => {
  // 086699 family (Michelin / BFGoodrich / Uniroyal...). candidateCompanyPrefix for the UPC is "0086699".
  const michelinPrefix = [{ prefix: "0086699", brand: "michelin" }];

  it("a corporate sibling on a shared prefix is NOT a brand conflict (no false-conflict)", () => {
    const result = r({ productName: "BFGoodrich All-Terrain T/A KO2 275/55R20 115T", brand: "BFGoodrich", specsShort: "275/55R20 115T" });
    expect(
      detectScanContextConflict({ scanContext: "any", code: "086699220585", codeType: "upc_a", result, brandPrefixHints: michelinPrefix }),
    ).toBeNull(); // suppressed: siblings, and a hint never marks anything verified - only allows/blocks
  });

  it("PLAN C: a brand OUTSIDE the family is an ADVISORY mismatch now, not a blocking conflict", () => {
    // Reconciled (Plan C Task 2): out-of-family brand vs a learned prefix used to block; it is now advisory
    // (detectScanContextConflict returns null) and surfaced via detectBrandPrefixAdvisory().
    const result = r({ productName: "Bridgestone Dueler H/T", brand: "Bridgestone" });
    expect(
      detectScanContextConflict({ scanContext: "any", code: "086699220585", codeType: "upc_a", result, brandPrefixHints: michelinPrefix }),
    ).toBeNull();
    expect(
      detectBrandPrefixAdvisory({ code: "086699220585", codeType: "upc_a", result, brandPrefixHints: michelinPrefix }),
    ).toBe(true);
  });

  it("the family table never weakens the category firewall (poisoned non-tire in tire context still blocks)", () => {
    const result = r({ productName: "Manstel 200 Pcs Aluminum Rivet Screw Kit", brand: "Manstel" });
    expect(
      detectScanContextConflict({ scanContext: "tire", code: "086699220585", codeType: "upc_a", result, brandPrefixHints: [] }),
    ).toBe("category_context_conflict");
  });
});
