import { describe, it, expect } from "vitest";
import { classifyProductDomain, detectScanContextConflict } from "@/services/ai/scanContextFirewall";
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
