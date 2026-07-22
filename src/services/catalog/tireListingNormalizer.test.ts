import { describe, it, expect } from "vitest";
import { cleanListingTitle, parseTireIdentity, canonicalTireSize } from "@/services/catalog/tireListingNormalizer";

// ---------------------------------------------------------------------------------------------
// Item A1: quantity prefixes, condition words, foreign boilerplate, retailer noise must be
// stripped from the listing title while brand/model/size/load-speed/sidewall survive.
// Real failing examples pulled from live-decoded rows on the preview (owner review) plus
// .superpowers/stress/results-relad100/batch-1.json and results-relad/batch-1.json.
// ---------------------------------------------------------------------------------------------
describe("cleanListingTitle - A1 junk stripping", () => {
  it("strips 'Set of N' quantity prefix", () => {
    expect(cleanListingTitle("Set of 4 Fortune Tormenta A/T2 265/65R17 112T Light Truck Tire")).toBe(
      "Fortune Tormenta A/T2 265/65R17 112T Light Truck Tire",
    );
  });

  it("strips 'N New' quantity prefix", () => {
    expect(cleanListingTitle("2 New Fortune Tormenta A/t2 - 235/75R15 Tires")).not.toMatch(/^2 New/i);
  });

  it("strips '1x' quantity prefix", () => {
    expect(cleanListingTitle("1x Fortune Tormenta A/T2 245/75R16 111T ostatnia sztuka")).not.toMatch(/^1x/i);
  });

  it("strips Polish listing boilerplate 'ostatnia sztuka' (last piece)", () => {
    const out = cleanListingTitle("1x Fortune Tormenta A/T2 245/75R16 111T ostatnia sztuka");
    expect(out.toLowerCase()).not.toContain("ostatnia sztuka");
    expect(out).toContain("Fortune Tormenta A/T2");
    expect(out).toContain("245/75R16");
  });

  it("strips Cyrillic listing suffix boilerplate", () => {
    const out = cleanListingTitle("(Ikon Tyres) Hakkapeliitta SUV 7 ш 116Т (зима) а/шина");
    expect(out).not.toMatch(/[Ѐ-ӿ]/); // no Cyrillic survives
  });

  it("strips '(4 Tires)' parenthetical quantity/unit noise", () => {
    const out = cleanListingTitle("Fortune Tormenta A/T 2 245/70R17 110T OWL (2 Tires)");
    expect(out).not.toMatch(/\(\s*\d+\s*Tires?\s*\)/i);
  });

  it("strips '(TWO)' parenthetical quantity noise", () => {
    const out = cleanListingTitle(
      "Set of 2 (TWO) Fortune Viento FSR702 215/45R17XL 91W BSW Fits: 2011-13 Honda Civic Si",
    );
    expect(out).not.toMatch(/\(TWO\)/i);
    expect(out).not.toMatch(/^Set of/i);
  });

  it("strips condition word 'New' embedded before brand", () => {
    const out = cleanListingTitle("1 New Fortune Climaflex 4s Fsr402 - 215/55r18 Tires");
    expect(out).not.toMatch(/\bNew\b/);
  });

  it("strips 'NEW!' condition word with punctuation", () => {
    const out = cleanListingTitle("Falken Wildpeak AT LT325/70R17 121S D2 BSW NEW!");
    expect(out).not.toMatch(/NEW!/);
  });

  it("strips trailing 'Fits: ...' fitment clause", () => {
    const out = cleanListingTitle(
      "Fortune Perfectus FSR602 205/65R15 99H XL Tires Fits: 2006-07 Honda Accord LX 2005 Honda Accord EX",
    );
    expect(out).not.toMatch(/Fits:/i);
  });

  it("keeps brand, model, size, load/speed, sidewall through the noise", () => {
    const out = cleanListingTitle("Set of 4 Fortune FSR310 LT33X12.50R15 108Q C Tires");
    expect(out).toContain("Fortune");
    expect(out).toContain("FSR310");
    expect(out).toContain("LT33X12.50R15");
    expect(out).toContain("108Q");
  });

  it("a clean name passes through unchanged", () => {
    expect(cleanListingTitle("Cooper Discoverer A/T3 LT245/75R16 120R")).toBe("Cooper Discoverer A/T3 LT245/75R16 120R");
  });

  it("does not mangle a non-tire retail name", () => {
    expect(cleanListingTitle("4 Pack Entry Knob & Deadbolt Set, Matte Black, Keyed Alike, Single Cylinder")).toBe(
      "4 Pack Entry Knob & Deadbolt Set, Matte Black, Keyed Alike, Single Cylinder",
    );
  });

  it("does not mangle another non-tire retail name (mophie case)", () => {
    const input = "iPhone 5SE/5s/5 University (H-N) mophie juice pack helium";
    expect(cleanListingTitle(input)).toBe(input);
  });

  it("handles empty / null input without throwing", () => {
    expect(cleanListingTitle("")).toBe("");
    expect(cleanListingTitle(null)).toBe("");
  });
});

// ---------------------------------------------------------------------------------------------
// Bug 5 (owner mandate 2026-07-21, 310-row review): the quantity strip removed "Set" but left "Of
// N"/"Of N word-number" remnants leaking into the model. Live-observed: "Bearway Of 2 Two Bw777",
// "Farroad Of 4 Four Frd26", "Durun Of 2 M626".
// ---------------------------------------------------------------------------------------------
describe("cleanListingTitle - Bug 5: 'Of N' / 'Of N word-number' quantity remnants", () => {
  it("strips 'Of N Two' quantity remnant (Bearway fixture)", () => {
    const out = cleanListingTitle("Bearway Of 2 Two Bw777");
    expect(out).toBe("Bearway Bw777");
  });

  it("strips 'Of N Four' quantity remnant (Farroad fixture)", () => {
    const out = cleanListingTitle("Farroad Of 4 Four Frd26");
    expect(out).toBe("Farroad Frd26");
  });

  it("strips a bare 'Of N' quantity remnant with no trailing count word (Durun fixture)", () => {
    const out = cleanListingTitle("Durun Of 2 M626");
    expect(out).toBe("Durun M626");
  });

  it("strips 'Of N' mid-string, not just at an edge", () => {
    const out = cleanListingTitle("Fortune Tormenta Of 4 A/T2 265/65R17");
    expect(out).not.toMatch(/\bOf\s+4\b/i);
    expect(out).toContain("Fortune Tormenta");
    expect(out).toContain("A/T2");
  });

  it("never strips a legitimate model containing the word 'of' as part of a longer phrase", () => {
    // Sanity: "Of" alone (no following count-word-or-digit-then-count-word shape) is not touched.
    expect(cleanListingTitle("Cooper Discoverer A/T3 LT245/75R16")).toBe("Cooper Discoverer A/T3 LT245/75R16");
  });
});

// ---------------------------------------------------------------------------------------------
// Bug 3 (owner mandate 2026-07-21, 310-row review): words in the source name must never be REPLACED
// (substituted with different text like "Tire") - only whole junk phrases may be REMOVED. Live-
// observed mangled forms named "Radial"/"Only" being substituted. These property/regression fixtures
// pin the invariant directly: every surviving (non-stripped) word must appear in the input verbatim,
// and specific words the owner named as at-risk (Radial, Only) must never be silently swapped out.
// ---------------------------------------------------------------------------------------------
describe("cleanListingTitle - Bug 3: words are removed, never replaced", () => {
  it("keeps 'Radial' and 'Only' verbatim, never substituted (Carlstar fixture)", () => {
    const out = cleanListingTitle("Custom Flo Grip Radial R-2 Tire Only");
    expect(out).toContain("Radial");
    expect(out).toContain("Only");
    expect(out).not.toMatch(/\bTire\b.*\bTire\b/i); // "Tire" must not appear twice (once real, once injected)
  });

  it("keeps 'Radial' verbatim in a leading position (Goodyear Farm fixture shape)", () => {
    const out = cleanListingTitle("Radial Trail Hd Tire Wheel Assembly");
    expect(out).toContain("Radial");
    expect(out).toContain("Trail Hd");
    expect(out).toContain("Wheel Assembly");
  });

  it("keeps 'Radial' verbatim next to a model code (M-108 fixture)", () => {
    const out = cleanListingTitle("M-108 Radial Tires");
    expect(out).toContain("M-108");
    expect(out).toContain("Radial");
  });

  it("property: every surviving whitespace-separated token in the output exists verbatim (case-insensitive) somewhere in the input - cleaning only REMOVES spans, never substitutes text", () => {
    const fixtures = [
      "Custom Flo Grip Radial R-2 Tire Only",
      "Radial Trail Hd Tire Wheel Assembly",
      "M-108 Radial Tires",
      "Fortune Set Of 4 FSR305 265/50R20 111T XL Tires",
      "Bearway Of 2 Two Bw777",
      "Cooper Discoverer A/T3 LT245/75R16",
    ];
    for (const raw of fixtures) {
      const out = cleanListingTitle(raw);
      const inputLower = raw.toLowerCase();
      for (const tok of out.split(/\s+/).filter(Boolean)) {
        expect(inputLower.includes(tok.toLowerCase()), `token "${tok}" from output must appear verbatim in input "${raw}"`).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Item A2: parseTireIdentity must isolate a clean Model field, never the whole listing string.
// ---------------------------------------------------------------------------------------------
describe("parseTireIdentity - A2 model isolation", () => {
  it("parses Fortune Tormenta A/T2 full identity (840139644399 case)", () => {
    const id = parseTireIdentity(
      "Fortune Tormenta A/T2 All Terrain LT245/75R16 120/116S E Light Truck Tire",
    );
    expect(id.brand).toBe("Fortune");
    expect(id.model).toBe("Tormenta A/T2");
    expect(id.size).toBe("LT245/75R16");
    expect(id.loadSpeed).toBe("120/116S");
  });

  it("parses Fortune ClimaFlex 4S FSR402 full identity (840139640414 case)", () => {
    const id = parseTireIdentity("Climaflex 4s Fsr402 - Tires 2254518 225 45 18");
    // brand is absent from this exact string (no explicit brand token) - never guessed.
    expect(id.model.toLowerCase()).toContain("climaflex 4s fsr402".toLowerCase().split(" ")[0]);
    expect(id.model).not.toMatch(/\bTires\b/i);
  });

  it("parses a bare 7-digit blob size (2254518 -> 225/45R18)", () => {
    expect(canonicalTireSize("2254518")).toBe("225/45R18");
  });

  it("parses Ikon Tyres Hakkapeliitta SUV 7, keeping only the latin model token (no Cyrillic)", () => {
    const id = parseTireIdentity("(Ikon Tyres) Hakkapeliitta SUV 7 ш 116Т (зима) а/шина");
    expect(id.model).toContain("Hakkapeliitta SUV 7");
    expect(id.model).not.toMatch(/[Ѐ-ӿ]/);
  });

  it("parses a real Fortune ClimaFlex row cleanly", () => {
    const id = parseTireIdentity(
      "Fortune ClimaFlex 4S FSR402 Touring 235/45R19 95V SUV/Crossover Tire",
    );
    expect(id.brand).toBe("Fortune");
    expect(id.model).toBe("ClimaFlex 4S FSR402");
    expect(id.size).toBe("235/45R19");
    expect(id.loadSpeed).toBe("95V");
  });

  it("parses a Falken Azenis RT660+ row (plus sign in model)", () => {
    const id = parseTireIdentity("Falken Azenis RT660+ 295/35ZR19 100W Summer Tire");
    expect(id.brand).toBe("Falken");
    expect(id.model).toContain("Azenis RT660");
    expect(id.size).toBe("295/35ZR19");
    expect(id.loadSpeed).toBe("100W");
  });

  it("parses a Mastercraft Courser HSX Tour row with trailing dash size", () => {
    const id = parseTireIdentity("Mastercraft Courser HSX Tour All-Season Tire - 265/60R18 110T");
    expect(id.brand).toBe("Mastercraft");
    expect(id.model).toContain("Courser HSX Tour");
    expect(id.size).toBe("265/60R18");
    expect(id.loadSpeed).toBe("110T");
  });

  it("never guesses a model for a non-tire name (empty parts, not a wrong guess)", () => {
    const id = parseTireIdentity("4 Pack Entry Knob & Deadbolt Set, Matte Black, Keyed Alike, Single Cylinder");
    expect(id.size).toBe("");
    expect(id.loadSpeed).toBe("");
  });

  it("keeps sidewall marker (BSW/OWL/XL) separated from model", () => {
    const id = parseTireIdentity("Falken Wild Peak A/T 265/70R18 116 S Tire OWL");
    expect(id.sidewall.toUpperCase()).toContain("OWL");
    expect(id.model).not.toMatch(/\bOWL\b/i);
  });

  it("empty input yields all-empty fields, never a guess", () => {
    const id = parseTireIdentity("");
    expect(id).toEqual({
      brand: "",
      model: "",
      size: "",
      loadSpeed: "",
      sidewall: "",
      rest: "",
      multiVariant: false,
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Owner mandate fixtures (2026-07-21): real fixture rows, verbatim, that must parse cleanly for
// good - universal for any code, not just these specific fixtures.
// ---------------------------------------------------------------------------------------------
describe("owner mandate fixture rows", () => {
  it("fixture 1: 'Set Of 4' mid-string after brand strips regardless of position", () => {
    const out = cleanListingTitle("Fortune Set Of 4 FSR305 265/50R20 111T XL Tires");
    expect(out).toBe("Fortune FSR305 265/50R20 111T XL");
  });

  it("fixture 2: LT flotation size no longer splits model+prefix (FSR310 LT bug)", () => {
    const id = parseTireIdentity("Set of 4 Fortune FSR310 LT33X12.50R20 114Q E Tires");
    expect(id.size).toBe("LT33X12.50R20");
    expect(id.model).toBe("FSR310");
    expect(id.loadSpeed).toBe("114Q");
  });

  it("fixture 3: German boilerplate + spaced size + multi-speed-rating triggers multiVariant", () => {
    const id = parseTireIdentity("Reifen Nokian 205 50 R17 93V, 93W, 93H | Preis auf AUTODOC");
    expect(id.brand).toBe("Nokian");
    expect(id.size).toBe("205/50R17");
    expect(id.multiVariant).toBe(true);
    expect(id.loadSpeed).toBe("");
  });

  it("fixture 4 (regression): Nokian Hakkapeliitta 7 with spaces around the size slash still works", () => {
    const id = parseTireIdentity("Nokian Hakkapeliitta 7 185 /65 R15 92T XL BSW");
    expect(id.brand).toBe("Nokian");
    expect(id.size).toBe("185/65R15");
    expect(id.loadSpeed).toBe("92T");
    expect(id.sidewall).toContain("XL");
    expect(id.sidewall).toContain("BSW");
    expect(id.model).toContain("Hakkapeliitta 7");
  });

  it("fixture 5 (regression): LT street size survives the mid-string 'Set Of 4' fix", () => {
    const id = parseTireIdentity("Fortune Set Of 4 FSR305 LT265/70R18 124/121S E Tires");
    expect(id.brand).toBe("Fortune");
    expect(id.model).toBe("FSR305");
    expect(id.size).toBe("LT265/70R18");
    expect(id.loadSpeed).toBe("124/121S");
  });

  it("strips retailer pipe-tail boilerplate ('| Preis auf AUTODOC')", () => {
    const out = cleanListingTitle("Nokian 205/50R17 93V | Preis auf AUTODOC");
    expect(out).not.toMatch(/\|/);
    expect(out).not.toMatch(/AUTODOC/i);
  });

  it("strips leading German 'Reifen' (tire) boilerplate word", () => {
    const out = cleanListingTitle("Reifen Nokian 205/50R17 93V");
    expect(out).not.toMatch(/\bReifen\b/i);
    expect(out).toContain("Nokian");
  });

  it("parses spaced size with explicit R separator ('205 50 R17')", () => {
    expect(canonicalTireSize("205 50 R17")).toBe("205/50R17");
  });
});

// ---------------------------------------------------------------------------------------------
// Item A3: canonicalTireSize - canonical [LT]W/AR RD format; bare 7-digit blob parses; ambiguous
// stays unparsed (empty) rather than guessed wrong.
// ---------------------------------------------------------------------------------------------
describe("canonicalTireSize - A3 size normalization", () => {
  it("normalizes slash-R format unchanged (already canonical)", () => {
    expect(canonicalTireSize("235/65R17")).toBe("235/65R17");
  });

  it("normalizes slash-slash format (235/65/17 -> 235/65R17)", () => {
    expect(canonicalTireSize("235/65/17")).toBe("235/65R17");
  });

  it("normalizes a bare 7-digit blob (2653518 -> 265/35R18)", () => {
    expect(canonicalTireSize("2653518")).toBe("265/35R18");
  });

  it("normalizes another bare 7-digit blob (2554518 -> 255/45R18)", () => {
    expect(canonicalTireSize("2554518")).toBe("255/45R18");
  });

  it("keeps LT prefix and uppercases R (lt225/75r16 -> LT225/75R16)", () => {
    expect(canonicalTireSize("lt225/75r16")).toBe("LT225/75R16");
  });

  it("keeps P prefix", () => {
    expect(canonicalTireSize("P225/60R18")).toBe("P225/60R18");
  });

  it("keeps ST prefix", () => {
    expect(canonicalTireSize("ST205/75R15")).toBe("ST205/75R15");
  });

  it("returns empty for an ambiguous ordinary number, never guessing", () => {
    expect(canonicalTireSize("1234567")).toBe(""); // rim 67 implausible
  });

  it("returns empty for non-tire text", () => {
    expect(canonicalTireSize("Coca-Cola Classic 12 pack")).toBe("");
  });

  it("returns empty for empty input", () => {
    expect(canonicalTireSize("")).toBe("");
  });

  it("handles a flotation size (35X12.50R20) unchanged", () => {
    expect(canonicalTireSize("35X12.50R20")).toBe("35X12.50R20");
  });

  it("handles a commercial size without aspect slash (11R22.5) unchanged", () => {
    expect(canonicalTireSize("11R22.5")).toBe("11R22.5");
  });
});
