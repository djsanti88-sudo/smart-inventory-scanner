import { describe, it, expect } from "vitest";
import { classifyProductDomain, detectScanContextConflict, detectIdentityContextConflict } from "@/services/ai/scanContextFirewall";
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

  it("brand contradiction vs an unambiguous learned prefix -> brand_prefix_conflict (any context)", () => {
    const result = r({ productName: "Some Snack", brand: "Manstel" });
    const hints = [{ prefix: "0745125", brand: "fortune" }];
    expect(detectScanContextConflict({ scanContext: "any", code: "745125495781", codeType: "upc_a", result, brandPrefixHints: hints })).toBe("brand_prefix_conflict");
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
