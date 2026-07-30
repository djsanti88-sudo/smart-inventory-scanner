import { describe, it, expect } from "vitest";
import {
  isTireContext,
  hasRequiredTireSpecs,
  hasTireSize,
  hasCountableTireIdentity,
  inferTireBrandFromName,
} from "@/services/ai/tireSpecs";
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

  it("counts the exact trusted Fortune flotation identity with a two-decimal width", () => {
    const identity = r({
      productName: "Fortune Tormenta M/T FSR310 33X12.50R20",
      brand: "Fortune",
      category: "Tire",
      specsShort: "33X12.50R20",
      primaryBarcode: "840139632594",
      upc: "840139632594",
    });

    expect(hasTireSize(identity)).toBe(true);
    expect(hasRequiredTireSpecs(identity)).toBe(true);
    expect(hasCountableTireIdentity(identity)).toBe(true);
  });

  it("accepts bounded two-decimal X and prefixed slash flotation sizes", () => {
    expect(hasTireSize(r({ productName: "Cooper Discoverer 35X12.50R20" }))).toBe(true);
    expect(hasTireSize(r({ productName: "Cooper Discoverer LT37/12.50R22" }))).toBe(true);
  });

  it("accepts only bounded directly-prefixed X flotation sizes", () => {
    for (const size of [
      "LT33X12.50R15",
      "LT31X10.50R15",
      "LT33X12.50R18",
      "LT37X13.50R20",
      "LT33X12.50R17",
      "LT38X13.50R24",
      "P35X12.50R20",
      "ST31X10.50R15",
    ]) {
      const identity = r({ productName: `Trusted Tire Model ${size}` });
      expect(hasTireSize(identity), size).toBe(true);
      expect(hasRequiredTireSpecs(identity), size).toBe(true);
      expect(hasCountableTireIdentity(identity), size).toBe(true);
    }

    for (const unsafe of [
      "Trusted Tire Model LT 33X12.50R15",
      "Trusted Tire Model ALT33X12.50R15",
      "Trusted Tire Model LT21X12.50R15",
      "Trusted Tire Model LT45X12.50R15",
      "Trusted Tire Model LT33X3.50R15",
      "Trusted Tire Model LT33X19.50R15",
      "Trusted Tire Model LT33X12.50R07",
      "Trusted Tire Model LT33X12.50R31",
      "Trusted Tire Model LT33X12.50R15ABC",
      "Trusted Tire Model LT33X12.50R15/99",
      "Storage bin LT33 X 12.50 X 15",
    ]) {
      expect(hasTireSize(r({ productName: unsafe, category: "Hardware" })), unsafe).toBe(false);
    }
  });

  it("rejects embedded and dimension-like flotation lookalikes", () => {
    expect(hasTireSize(r({ productName: "Widget A33X12.50R20" }))).toBe(false);
    expect(hasTireSize(r({ productName: "Widget 33X12.50R20ABC" }))).toBe(false);
    expect(hasTireSize(r({ productName: "Storage bin 33 X 12.50 X 20", category: "Hardware" }))).toBe(false);
    expect(isTireContext(r({ productName: "Storage bin 33 X 12.50 X 20", category: "Hardware" }))).toBe(false);
  });
});

// B7 (2026-07-15): a 15-name battery over REALISTIC product name / specs strings pulled from real
// brands + model lines in the corpus (benchmarks/golden/phase1-corpus-golden.json brands: goodyear,
// michelin, cooper; src/server/tire-knowledge/tireKnowledge.generated.json model names for those
// brands: wrangler_duratrac, cross_climate_plus, discoverer_a_t3). No commercial-size row exists in
// the current corpus (0 of 78202 rows) so the commercial example size (11R22.5) is constructed per the
// plan's "realistic size tokens" allowance - it is a standard, real-world commercial tire size, just
// not one the harvester has ingested yet. Covers: metric, LT-metric, commercial, and 3 non-tire
// negatives (the poison class - must never be mistaken for tire context or tire specs).
describe("B7 tire-specs battery - 15 real-world name/specs strings", () => {
  const cases: Array<[string, Partial<AiLookupResult>, { context: boolean; requiredSpecs: boolean }]> = [
    // --- metric passenger/P-metric (real brand + real model line from the corpus) ---
    ["Goodyear Wrangler DuraTrac 275/60R20 115T", { productName: "Goodyear Wrangler DuraTrac 275/60R20 115T" }, { context: true, requiredSpecs: true }],
    ["Michelin CrossClimate2 235/65R17 104V", { productName: "Michelin CrossClimate2 235/65R17 104V" }, { context: true, requiredSpecs: true }],
    ["Cooper Discoverer A/T3 245/75R16 120R", { productName: "Cooper Discoverer A/T3 245/75R16 120R" }, { context: true, requiredSpecs: true }],
    ["Goodyear Fortitude HT specsShort only, size+load/speed", { specsShort: "235/65R17 104T" }, { context: true, requiredSpecs: true }],
    ["Michelin Primacy A/S 225/65R17 102H (specsFull)", { specsFull: "Michelin Primacy A/S 225/65R17 102H" }, { context: true, requiredSpecs: true }],
    // --- metric with a size but missing load/speed (context yes, full specs no) ---
    ["Goodyear Wrangler Territory RT 235/65R17 (no load/speed)", { productName: "Goodyear Wrangler Territory RT 235/65R17" }, { context: true, requiredSpecs: false }],
    // --- LT-metric (real brand + real LT model line: Cooper Discoverer STT Pro / AT3, LT265/70R17) ---
    ["Cooper Discoverer STT Pro LT265/70R17 121/118S", { productName: "Cooper Discoverer STT Pro LT265/70R17 121/118S" }, { context: true, requiredSpecs: true }],
    ["Goodyear Wrangler DuraTrac LT225/65R17 121R (specsShort)", { specsShort: "LT225/65R17 121R" }, { context: true, requiredSpecs: true }],
    ["Michelin LTX A/T2 LT285/70R17 121S", { productName: "Michelin LTX A/T2 LT285/70R17 121S" }, { context: true, requiredSpecs: true }],
    // --- commercial/flotation (constructed - real size class, corpus has zero rows of this type) ---
    ["Goodyear commercial drive tire 11R22.5 (commercial, size alone is sufficient)", { productName: "Goodyear G622 RSD 11R22.5" }, { context: true, requiredSpecs: true }],
    ["Cooper flotation size 35X12.5R20 (commercial notation)", { productName: "Cooper Discoverer STT Pro 35X12.5R20 121Q" }, { context: true, requiredSpecs: true }],
    // --- brand/keyword context without a parsable size (context true via brand/keyword, specs false) ---
    ["Falken Wildpeak AT (brand only, no size)", { productName: "Falken Wildpeak AT" }, { context: true, requiredSpecs: false }],
    // --- non-tire negatives (the poison class) ---
    ["Coca-Cola Classic 12-pack (non-tire, brand+category)", { productName: "Coca-Cola Classic 12-pack", brand: "Coca-Cola", category: "Beverages" }, { context: false, requiredSpecs: false }],
    ["Dorman 03413 Exhaust Manifold Hardware Kit (non-tire auto part)", { productName: "Dorman 03413 Exhaust Manifold Hardware Kit" }, { context: false, requiredSpecs: false }],
    ["Manstel 200 Pcs Aluminum Core Blind Rivet Screw Kit (non-tire hardware)", { productName: "Manstel 200 Pcs Aluminum Core Blind Rivet Screw Kit" }, { context: false, requiredSpecs: false }],
  ];

  for (const [label, over, expected] of cases) {
    it(`${label}`, () => {
      const identity = r(over);
      expect(isTireContext(identity), `isTireContext mismatch for: ${label}`).toBe(expected.context);
      expect(hasRequiredTireSpecs(identity), `hasRequiredTireSpecs mismatch for: ${label}`).toBe(expected.requiredSpecs);
    });
  }
});

describe("inferTireBrandFromName (fill empty brand from a barcode-DB title)", () => {
  it("infers a known tire brand that appears in the name", () => {
    expect(inferTireBrandFromName("Cooper Discoverer A/T3 245/75R16 120R")).toBe("Cooper");
    expect(inferTireBrandFromName("Michelin Defender LTX M/S 275/55R20 113T")).toBe("Michelin");
  });
  it("prefers the longest match (general tire over a short accidental substring)", () => {
    expect(inferTireBrandFromName("General Tire Grabber HTS60 265/70R17").toLowerCase()).toBe("general tire");
  });
  it("returns empty for a non-tire product (the poison) so it can never satisfy the family check", () => {
    expect(inferTireBrandFromName("Manstel 200 Pcs Aluminum Core Blind Rivet Screw Kit")).toBe("");
    expect(inferTireBrandFromName("Dorman 03413 Exhaust Manifold Hardware Kit")).toBe("");
  });
});
