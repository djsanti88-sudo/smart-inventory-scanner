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
    expect(id).toEqual({ brand: "", model: "", size: "", loadSpeed: "", sidewall: "", rest: "" });
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
