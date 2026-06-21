import { describe, it, expect } from "vitest";
import { isTireContext, hasRequiredTireSpecs, hasTireSize } from "@/services/ai/tireSpecs";
import type { AiLookupResult } from "@/types";

const r = (over: Partial<AiLookupResult>): AiLookupResult => ({
  productName: "", brand: "", category: "", specsShort: "", specsFull: "", primarySku: "", primaryBarcode: "",
  gtin: "", upc: "", ean: "", aliases: [], imageUrl: "", productUrl: "", sourceUrls: [], confidence: 0,
  verifiedFacts: [], guesses: [], needsHumanReview: false, ...over,
});

describe("tireSpecs (Phase 7)", () => {
  it("detects tire context by keyword, size pattern, or known brand", () => {
    expect(isTireContext(r({ category: "Tires" }))).toBe(true);
    expect(isTireContext(r({ productName: "Falken Wildpeak AT" }))).toBe(true); // known tire brand, no 'tire' word
    expect(isTireContext(r({ specsShort: "275/55R20 111T" }))).toBe(true); // size present
    expect(isTireContext(r({ productName: "Coca-Cola Classic", brand: "Coca-Cola" }))).toBe(false);
  });

  it("requires size + load index + speed rating for consumer/LT tires", () => {
    expect(hasRequiredTireSpecs(r({ productName: "Falken Wildpeak AT" }))).toBe(false); // no size
    expect(hasRequiredTireSpecs(r({ specsShort: "275/55R20" }))).toBe(false); // size but no load/speed
    expect(hasRequiredTireSpecs(r({ productName: "Falken Wildpeak A/T 275/55R20 111T" }))).toBe(true);
    expect(hasRequiredTireSpecs(r({ specsShort: "275/55R20 111 T" }))).toBe(true);
    expect(hasRequiredTireSpecs(r({ specsShort: "LT265/70R17 121S" }))).toBe(true);
  });

  it("accepts a commercial/flotation size on its own", () => {
    expect(hasTireSize(r({ specsShort: "11R22.5" }))).toBe(true);
    expect(hasRequiredTireSpecs(r({ productName: "Commercial drive 11R22.5" }))).toBe(true);
  });
});
