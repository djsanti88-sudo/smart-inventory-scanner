import { describe, it, expect } from "vitest";
import { enrichProductIdentity, canonicalTireDisplayName } from "@/services/catalog/enrichProductIdentity";

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

    // Group B owner mandate (2026-07-21): brand+model+size all confidently parse here, so the app
    // now assembles its OWN canonical display name rather than keeping the raw listing text.
    expect(result.name).toBe("Falken Azenis RT660 P245/40R18 97W XL BSW");
    expect(result.brand).toBe("Falken");
    expect(result.specsShort).toBe("P245/40R18 97W XL BSW");
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
    // Group B owner mandate: specsShort includes the parsed load/speed rating, not just the bare
    // size, whenever loadSpeed was parseable (104V here).
    expect(result.specsShort).toBe("235/55R18 104V");
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
    // Group B owner mandate: category now defaults to "Tire" once brand+model+size confidently
    // parse (this row does), rather than staying permanently blank.
    expect(result.category).toBe("Tire");
  });
});

// ---------------------------------------------------------------------------------------------
// CLASS FIX (2026-08-04, cocacola-bug-report.md): `existingBrandIsFloorGuess` is the shared contract
// every enrichProductIdentity call site now passes so a prefix-floor STATISTICAL brand guess (see
// prefixFloor.ts / prefixFloorEnrich.ts's `brandIsOnlyFloorGuess`) can never permanently outrank a real
// decode/human identity just because it happens to be non-empty. Table-driven across the three shapes
// every real scanStore.ts call site produces (mint-enrich, dedup-reuse, orphan-upgrade all reduce to the
// same enrichProductIdentity contract; only what they compute for existingBrandIsFloorGuess differs).
// ---------------------------------------------------------------------------------------------
describe("enrichProductIdentity - existingBrandIsFloorGuess (class fix, 2026-08-04)", () => {
  it("a floor-guess-only existing brand yields to the payload's own real brand", () => {
    const result = enrichProductIdentity({
      payload: { name: "Michelin X-Ice North 4 225/60R18 104T", brand: "Michelin" },
      existing: { name: "Coca-Cola / product unconfirmed", brand: "Coca-Cola", category: "", specsShort: "", specsFull: "" },
      existingBrandIsFloorGuess: true,
    });
    expect(result.brand).toBe("Michelin");
    // The assembled name must ALSO reflect the corrected brand, not the stale floor guess - name
    // assembly reuses the same resolved `brand`, so the bug corrupted both fields simultaneously.
    expect(result.name).toContain("Michelin");
    expect(result.name).not.toContain("Coca-Cola");
  });

  it("a floor-guess-only existing brand yields to a brand parsed from the payload's name alone (no separate brand field - the original 2026-07-21 incident shape)", () => {
    const result = enrichProductIdentity({
      payload: { name: "Michelin X-Ice North 4 225/60R18 104T" }, // no `brand` key at all
      existing: { name: "Coca-Cola / product unconfirmed", brand: "Coca-Cola", category: "", specsShort: "", specsFull: "" },
      existingBrandIsFloorGuess: true,
    });
    expect(result.brand).toBe("Michelin");
  });

  it("a floor-guess-only existing brand does NOT survive even when the real decode is itself brandless (matches the already-shipped guarded-site behavior)", () => {
    const result = enrichProductIdentity({
      payload: { name: "Entry Level All Season Passenger Tire 205/55R16", brand: "" },
      existing: { name: "United Solutions / product unconfirmed", brand: "United Solutions", category: "", specsShort: "", specsFull: "" },
      existingBrandIsFloorGuess: true,
    });
    expect(result.brand).toBe("");
  });

  it("existingBrandIsFloorGuess defaults to false: a genuine (non-floor) existing brand is unaffected and still wins fill-if-empty", () => {
    const result = enrichProductIdentity({
      payload: { name: "Michelin X-Ice North 4 225/60R18 104T", brand: "Michelin" },
      existing: { name: "Human Custom Name", brand: "HumanBrand", category: "", specsShort: "", specsFull: "" },
    });
    expect(result.brand).toBe("HumanBrand");
  });

  it("existingBrandIsFloorGuess: true has no effect when existing.brand is already empty (nothing to protect against)", () => {
    const result = enrichProductIdentity({
      payload: { name: "Michelin X-Ice North 4 225/60R18 104T", brand: "Michelin" },
      existing: { name: "Unidentified item (barcode 049000026603)", brand: "", category: "", specsShort: "", specsFull: "" },
      existingBrandIsFloorGuess: true,
    });
    expect(result.brand).toBe("Michelin");
  });
});

// ---------------------------------------------------------------------------------------------
// Group B (owner mandate 2026-07-21): every tire row must present ONE canonical format the app
// assembles itself, never raw junky listing text once a confident parse exists.
// ---------------------------------------------------------------------------------------------
describe("canonicalTireDisplayName", () => {
  it("assembles brand + model + size + loadSpeed + sidewall, single-space-joined", () => {
    expect(
      canonicalTireDisplayName({ brand: "Fortune", model: "FSR305", size: "265/50R20", loadSpeed: "111T", sidewall: "XL" }),
    ).toBe("Fortune FSR305 265/50R20 111T XL");
  });

  it("omits a missing sidewall", () => {
    expect(
      canonicalTireDisplayName({ brand: "Fortune", model: "FSR305", size: "265/50R20", loadSpeed: "111T", sidewall: "" }),
    ).toBe("Fortune FSR305 265/50R20 111T");
  });

  it("omits a missing loadSpeed and sidewall", () => {
    expect(
      canonicalTireDisplayName({ brand: "Fortune", model: "FSR305", size: "265/50R20", loadSpeed: "", sidewall: "" }),
    ).toBe("Fortune FSR305 265/50R20");
  });

  it("omits a missing model", () => {
    expect(
      canonicalTireDisplayName({ brand: "Fortune", model: "", size: "265/50R20", loadSpeed: "111T", sidewall: "" }),
    ).toBe("Fortune 265/50R20 111T");
  });

  // Bug 4 (CRITICAL mechanism, owner mandate 2026-07-21, 310-row review): canonical assembly must
  // never prepend the brand again when the model text already begins with it (case-insensitive) -
  // live-observed "Greenball Greenball Greenball Tow-Master", "Goodyear Farm Made By Titan Farm Made
  // By Titan" (each enrichment pass added another copy). Also must collapse an existing consecutive
  // duplicate token run already baked into the model text.
  it("does NOT prepend the brand again when the model already starts with it", () => {
    expect(
      canonicalTireDisplayName({ brand: "Greenball", model: "Greenball Tow-Master", size: "", loadSpeed: "", sidewall: "" }),
    ).toBe("Greenball Tow-Master");
  });

  it("does NOT prepend the brand again case-insensitively", () => {
    expect(
      canonicalTireDisplayName({ brand: "Goodyear", model: "goodyear Farm Made By Titan", size: "", loadSpeed: "", sidewall: "" }),
    ).toBe("Goodyear Farm Made By Titan");
  });

  it("collapses an existing consecutive duplicate brand-token run already baked into the model", () => {
    expect(
      canonicalTireDisplayName({ brand: "Greenball", model: "Greenball Greenball Greenball Tow-Master", size: "", loadSpeed: "", sidewall: "" }),
    ).toBe("Greenball Tow-Master");
  });

  it("is idempotent: assembling twice from its own output never adds another brand copy", () => {
    const once = canonicalTireDisplayName({ brand: "Fortune", model: "FSR305", size: "265/50R20", loadSpeed: "111T", sidewall: "XL" });
    // Re-run treating the previous output's remainder (after the brand) as "model" - the real
    // enrich(enrich(row)) shape: a second pass parses brand back out of the assembled name.
    const modelFromOnce = once.replace(new RegExp(`^Fortune\\s+`), "").replace(/\s*265\/50R20.*$/, "");
    const twice = canonicalTireDisplayName({ brand: "Fortune", model: modelFromOnce, size: "265/50R20", loadSpeed: "111T", sidewall: "XL" });
    expect(twice).toBe(once);
  });
});

describe("enrichProductIdentity - Group B canonical name assembly + specsShort + category default + multiVariant", () => {
  it("replaces name with the canonical display form when brand+model+size all confidently parse (fixture 1)", () => {
    const result = enrichProductIdentity({
      payload: { name: "Fortune Set Of 4 FSR305 265/50R20 111T XL Tires" },
      existing: { name: "", brand: "", category: "", specsShort: "", specsFull: "" },
    });
    expect(result.name).toBe("Fortune FSR305 265/50R20 111T XL");
  });

  it("keeps cleanListingTitle output as name when the parse is not confident (missing brand)", () => {
    const junkName = "4 Pack Entry Knob & Deadbolt Set, Matte Black, Keyed Alike, Single Cylinder";
    const result = enrichProductIdentity({
      payload: { name: junkName },
      existing: { name: "", brand: "", category: "", specsShort: "", specsFull: "" },
    });
    expect(result.name).toBe(junkName);
  });

  it("keeps cleanListingTitle output as name when multiVariant is true (fixture 3)", () => {
    const result = enrichProductIdentity({
      payload: { name: "Reifen Nokian 205 50 R17 93V, 93W, 93H | Preis auf AUTODOC" },
      existing: { name: "", brand: "", category: "", specsShort: "", specsFull: "" },
    });
    expect(result.name).not.toContain("AUTODOC");
    expect(result.multiVariant).toBe(true);
  });

  it("specsShort includes the load/speed rating token, not just the bare size, when loadSpeed parsed", () => {
    const result = enrichProductIdentity({
      payload: { name: "Fortune Set Of 4 FSR305 265/50R20 111T XL Tires" },
      existing: { name: "", brand: "", category: "", specsShort: "", specsFull: "" },
    });
    expect(result.specsShort).toBe("265/50R20 111T XL");
  });

  it("specsShort falls back to bare size when loadSpeed is not parseable", () => {
    const result = enrichProductIdentity({
      payload: { name: "Cooper Discoverer A/T3 LT245/75R16" },
      existing: { name: "", brand: "", category: "", specsShort: "", specsFull: "" },
    });
    expect(result.specsShort).toBe("LT245/75R16");
  });

  it("category defaults to Tire when brand+model+size confidently parsed and no existing/payload category", () => {
    const result = enrichProductIdentity({
      payload: { name: "Fortune Set Of 4 FSR305 265/50R20 111T XL Tires" },
      existing: { name: "", brand: "", category: "", specsShort: "", specsFull: "" },
    });
    expect(result.category).toBe("Tire");
  });

  it("never overwrites an existing non-empty category even when the tire parse is confident", () => {
    const result = enrichProductIdentity({
      payload: { name: "Fortune Set Of 4 FSR305 265/50R20 111T XL Tires" },
      existing: { name: "", brand: "", category: "Something Else", specsShort: "", specsFull: "" },
    });
    expect(result.category).toBe("Something Else");
  });

  it("surfaces multiVariant true for a listing with multiple speed-rating variants (fixture 3)", () => {
    const result = enrichProductIdentity({
      payload: { name: "Reifen Nokian 205 50 R17 93V, 93W, 93H | Preis auf AUTODOC" },
      existing: { name: "", brand: "", category: "", specsShort: "", specsFull: "" },
    });
    expect(result.multiVariant).toBe(true);
  });

  it("multiVariant does not block the Tire category default (brand+model+size can still hold)", () => {
    const result = enrichProductIdentity({
      // Same size/brand shape as fixture 3, but forcing brand+size to hold true while multiVariant fires.
      payload: { name: "Reifen Nokian 205 50 R17 93V, 93W, 93H | Preis auf AUTODOC" },
      existing: { name: "", brand: "", category: "", specsShort: "", specsFull: "" },
    });
    // Nokian has no separately-parsed "model" token in this fixture, so category only requires
    // (brand && size) here - both hold, multiVariant must not suppress the Tire default.
    expect(result.category).toBe("Tire");
  });

  it("surfaces multiVariant false for a normal confidently-parsed single-variant tire row", () => {
    const result = enrichProductIdentity({
      payload: { name: "Fortune Set Of 4 FSR305 265/50R20 111T XL Tires" },
      existing: { name: "", brand: "", category: "", specsShort: "", specsFull: "" },
    });
    expect(result.multiVariant).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Bug 2c (owner mandate 2026-07-21, 310-row review): tire enrichment must never fire for a non-tire
// product whose text happens to contain a coincidentally range-plausible size but no known tire
// brand and no tire-specific corroboration (load/speed rating, sidewall marker). Live-observed: a
// rivet kit and an essential-oil bottle both got category "Tire".
// ---------------------------------------------------------------------------------------------
describe("enrichProductIdentity - tire-ification requires a known brand or real tire corroboration", () => {
  it("does NOT tire-ify a rivet kit whose part-count text coincidentally parses a plausible size", () => {
    const result = enrichProductIdentity({
      payload: { name: "Rivet Kit 195 65 15 Pieces" },
      existing: { name: "", brand: "", category: "", specsShort: "", specsFull: "" },
    });
    expect(result.category).not.toBe("Tire");
  });

  it("does NOT tire-ify a non-tire product with no known brand and no size at all", () => {
    const result = enrichProductIdentity({
      payload: { name: "Manstel 200 Pcs Aluminum Rivet Screw Kit" },
      existing: { name: "", brand: "", category: "", specsShort: "", specsFull: "" },
    });
    expect(result.category).not.toBe("Tire");
    expect(result.brand).toBe("");
  });

  it("STILL tire-ifies a known-brand tire even without a load/speed rating or sidewall marker", () => {
    const result = enrichProductIdentity({
      payload: { name: "Cooper Discoverer A/T3 LT245/75R16" },
      existing: { name: "", brand: "", category: "", specsShort: "", specsFull: "" },
    });
    expect(result.category).toBe("Tire");
  });

  it("STILL tire-ifies a brandless listing when the size carries a load/speed rating (tire-specific corroboration)", () => {
    const result = enrichProductIdentity({
      payload: { name: "Some Unbranded Model 265/70R17 115T" },
      existing: { name: "", brand: "", category: "", specsShort: "", specsFull: "" },
    });
    expect(result.category).toBe("Tire");
  });
});

// ---------------------------------------------------------------------------------------------
// Bug 4 (CRITICAL mechanism, owner mandate 2026-07-21): enrichment must be idempotent end to end -
// enrich(enrich(row)) === enrich(row), byte-identical - so repeated apply-site/backfill passes never
// duplicate the brand. Live-observed rows: "Greenball Greenball Greenball Tow-Master", "Grand Spirit
// x4", "Custom 428 x3", "Goodyear Farm Made By Titan Made By Titan".
// ---------------------------------------------------------------------------------------------
describe("enrichProductIdentity - idempotency (Bug 4)", () => {
  function enrichTwice(name: string, brand?: string) {
    const once = enrichProductIdentity({ payload: { name, brand } });
    const twice = enrichProductIdentity({
      payload: { name: once.name, brand: once.brand },
      existing: { name: once.name, brand: once.brand, category: once.category, specsShort: once.specsShort, specsFull: once.specsFull },
    });
    return { once, twice };
  }

  it("re-enriching a Greenball row does not duplicate the brand further", () => {
    const { once, twice } = enrichTwice("Greenball Greenball Greenball Tow-Master", "Greenball");
    expect(twice.name).toBe(once.name);
    expect((once.name.match(/Greenball/gi) ?? []).length).toBeLessThanOrEqual(1);
  });

  it("re-enriching a Goodyear Farm-Made-By-Titan row does not duplicate the brand further", () => {
    const { once, twice } = enrichTwice("Goodyear Farm Made By Titan Farm Made By Titan", "Goodyear");
    expect(twice.name).toBe(once.name);
    expect((once.name.match(/Goodyear/gi) ?? []).length).toBeLessThanOrEqual(1);
  });

  it("property: enrich(enrich(row)) === enrich(row) for every fixture row", () => {
    const fixtures: Array<[string, string?]> = [
      ["Fortune Set Of 4 FSR305 265/50R20 111T XL Tires", undefined],
      ["Greenball Greenball Greenball Tow-Master", "Greenball"],
      ["Goodyear Farm Made By Titan Farm Made By Titan", "Goodyear"],
      ["Cooper Discoverer A/T3 LT245/75R16", undefined],
      ["Reifen Nokian 205 50 R17 93V, 93W, 93H | Preis auf AUTODOC", undefined],
    ];
    for (const [name, brand] of fixtures) {
      const { once, twice } = enrichTwice(name, brand);
      expect(twice).toEqual(once);
    }
  });
});
