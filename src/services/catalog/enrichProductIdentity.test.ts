import { describe, it, expect } from "vitest";
import { enrichProductIdentity } from "@/services/catalog/enrichProductIdentity";

// Owner-reported live bug (2026-07-20, deployed preview): a counted row showed name
// "Falken Azenis RT660 P 245 /40 R18 97W XL BSW (suggested)" for barcode 848983017918, but
// Brand/Model/Category/Specs/Size table columns were all "-" even though the size (245/40R18),
// load/speed (97W), and sidewall (BSW) are all cleanly parseable from the name itself. Root cause:
// every identity-apply site in scanStore.ts wrote a decode/suggestion payload's OWN structured
// fields verbatim (category/specsShort/etc) with no fallback to parse them from the name when the
// payload carried none - so a name-only decode result left every structured column permanently blank.
//
// This shared helper is the SINGLE place that fixes it: given a decode/suggestion payload (name +
// optionally brand/category/specsShort/specsFull) and the existing row's current values (for
// fill-if-empty), it returns the normalized fields every apply site should write - preferring the
// payload's own structured fields first, and falling back to a deterministic parse of the
// (cleaned) name via parseTireIdentity/canonicalTireSize only when the payload field is empty AND
// the existing row's field is empty. Never overwrites a value the existing row already carries.
describe("enrichProductIdentity - shared identity-apply enrichment", () => {
  it("reproduces the owner's exact bug row: name-only payload gets structured fields parsed from the name", () => {
    const result = enrichProductIdentity({
      payload: { name: "Falken Azenis RT660 P 245 /40 R18 97W XL BSW" },
      existing: { name: "", brand: "", category: "", specsShort: "", specsFull: "" },
    });

    expect(result.name).toBe("Falken Azenis RT660 P 245 /40 R18 97W XL BSW");
    expect(result.brand).toBe("Falken");
    expect(result.specsShort).toBe("P245/40R18");
    expect(result.specsFull).toContain("P245/40R18");
    expect(result.specsFull).toContain("97W");
    expect(result.specsFull).toContain("BSW");
    expect(result.structuredModel).toBe("Azenis RT660");
  });

  it("prefers the payload's OWN structured fields over a name-parse when both are present", () => {
    const result = enrichProductIdentity({
      payload: {
        name: "Falken Azenis RT660 245/40R18",
        brand: "Falken",
        category: "Passenger Tire",
        specsShort: "PAYLOAD-SIZE",
        specsFull: "PAYLOAD-FULL-SPECS",
      },
      existing: { name: "", brand: "", category: "", specsShort: "", specsFull: "" },
    });

    expect(result.category).toBe("Passenger Tire");
    expect(result.specsShort).toBe("PAYLOAD-SIZE");
    expect(result.specsFull).toBe("PAYLOAD-FULL-SPECS");
  });

  it("cleans a junky marketplace-scraped listing title (quantity prefix, condition word, Fits clause)", () => {
    const junkName = "Set of 4 NEW Fortune ClimaFlex 4S FSR402 235/55R18 104V Tires Fits: 2019 Toyota Camry";
    const result = enrichProductIdentity({
      payload: { name: junkName },
      existing: { name: "", brand: "", category: "", specsShort: "", specsFull: "" },
    });

    expect(result.name).not.toMatch(/set of 4/i);
    expect(result.name).not.toMatch(/\bnew\b/i);
    expect(result.name).not.toMatch(/fits:/i);
    expect(result.specsShort).toBe("235/55R18");
  });

  it("fill-if-empty: never overwrites an existing non-empty (human-entered) field", () => {
    const result = enrichProductIdentity({
      payload: { name: "Falken Azenis RT660 245/40R18", brand: "Falken", specsShort: "AI-DECODED-SIZE" },
      existing: { name: "Human Custom Name", brand: "HumanBrand", category: "HumanCategory", specsShort: "HUMAN-SIZE", specsFull: "HUMAN-FULL" },
    });

    // Existing non-empty values survive untouched.
    expect(result.brand).toBe("HumanBrand");
    expect(result.category).toBe("HumanCategory");
    expect(result.specsShort).toBe("HUMAN-SIZE");
    expect(result.specsFull).toBe("HUMAN-FULL");
  });

  it("never guesses: an unparseable name with no structured payload fields yields empty brand/specs, not fabricated values", () => {
    const result = enrichProductIdentity({
      payload: { name: "Unidentified item 0123456789" },
      existing: { name: "", brand: "", category: "", specsShort: "", specsFull: "" },
    });

    // No known brand and no parseable size in this name - brand/specsShort/specsFull stay empty
    // rather than a wrong guess (Resolver Trust Rule: prefer blank over wrong).
    expect(result.brand).toBe("");
    expect(result.specsShort).toBe("");
    expect(result.specsFull).toBe("");
  });

  it("only computes changed keys relative to existing (fill-if-empty semantics are visible in the returned patch)", () => {
    const result = enrichProductIdentity({
      payload: { name: "Falken Azenis RT660 P 245 /40 R18 97W XL BSW" },
      existing: { name: "", brand: "", category: "", specsShort: "", specsFull: "" },
    });
    // category was not parseable/available from either payload or name -> stays empty (no fabrication).
    expect(result.category).toBe("");
  });
});
