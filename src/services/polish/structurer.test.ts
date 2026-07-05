import { describe, expect, it } from "vitest";
import { structureProduct, tireSizeTag } from "./structurer";

// Owner-locked lexicon for brand-detection tests (Task 1 brief: DI via ctx.knownBrands).
const BRANDS = ["Toyo", "Michelin", "Falken", "Continental", "Pirelli", "Goodyear"];

describe("tireSizeTag - notation table (Global Constraints, verbatim)", () => {
  const cases: Array<[string, string]> = [
    ["LT265/70R17", "2657017"],
    ["265 /70 R17", "2657017"],
    ["265x70R17", "2657017"],
    ["245/35ZR19XL", "2453519"],
    ["295/75R22.5", "29575225"],
    ["37x12.50R20", "37125020"],
    ["33x12.50-15LT", "33125015"],
    ["25x8-12", "25812"],
    ["100/80-17", "1008017"],
    ["120/70ZR17", "1207017"],
  ];

  for (const [input, expected] of cases) {
    it(`"${input}" -> "${expected}"`, () => {
      expect(tireSizeTag(input)).toBe(expected);
    });
  }

  it("finds the size inside a full listing title", () => {
    expect(tireSizeTag("4 New 265/70R17 All Season Tires")).toBe("2657017");
  });

  it("returns empty string when no tire size is present", () => {
    expect(tireSizeTag("Premium Widget Cleaner")).toBe("");
    expect(tireSizeTag("")).toBe("");
  });
});

describe("structureProduct - tire notation table drives sizeTag + sizeTagKind", () => {
  it("glues digits and tags kind 'tire' for a passenger size", () => {
    const r = structureProduct("Michelin Defender T+H 205/55R16", undefined, { knownBrands: BRANDS });
    expect(r.sizeTag).toBe("2055516");
    expect(r.sizeTagKind).toBe("tire");
  });

  it("handles the flotation truck notation end to end", () => {
    const r = structureProduct("Toyo Open Country 37x12.50R20", undefined, { knownBrands: BRANDS });
    expect(r.sizeTag).toBe("37125020");
    expect(r.sizeTagKind).toBe("tire");
  });
});

describe("structureProduct - brand detection order", () => {
  it("uses the explicit brand arg when it is non-junk, even if not in the lexicon", () => {
    const r = structureProduct("Defender T+H 205/55R16", "Michelin", { knownBrands: BRANDS });
    expect(r.brand).toBe("Michelin");
  });

  it("ignores a junk explicit brand arg and falls through to the lexicon", () => {
    const r = structureProduct("Falken Wildpeak AT3W 265/70R17", "My Store", { knownBrands: BRANDS });
    expect(r.brand).toBe("Falken");
  });

  it("finds Falken mid-name via the lexicon (longest match wins)", () => {
    const r = structureProduct("All Season 205/55R16 Falken Tires", undefined, { knownBrands: BRANDS });
    expect(r.brand).toBe("Falken");
  });

  it("finds Michelin mid-name via the lexicon", () => {
    const r = structureProduct("Set of 4 225/45R17 Michelin Premier LTX", undefined, { knownBrands: BRANDS });
    expect(r.brand).toBe("Michelin");
  });

  it("falls back to a leading-token heuristic brand when no lexicon match exists", () => {
    const r = structureProduct("BurstBrand Tire 205/55R16", undefined, { knownBrands: BRANDS });
    expect(r.brand).toBe("BurstBrand");
  });

  it("never treats a generic leading word as a brand", () => {
    const r = structureProduct("Tire Size Chart Guide", undefined, { knownBrands: BRANDS });
    expect(r.brand).toBe("");
  });

  it("never treats an all-caps noise word or 'New'/'Premium' as a leading brand", () => {
    expect(structureProduct("New Winter Tires 205/55R16", undefined, { knownBrands: BRANDS }).brand).toBe("");
    expect(structureProduct("Premium Tire Cleaner Spray", undefined, { knownBrands: BRANDS }).brand).toBe("");
  });

  it("returns empty brand when truly unknown", () => {
    const r = structureProduct("205/55R16 all season radial", undefined, { knownBrands: BRANDS });
    expect(r.brand).toBe("");
  });
});

describe("structureProduct - junk gate returns confidence 0 and empty fields", () => {
  const junkNames = [
    "Home > Tires > 265/70R17",
    "Buy Cheap Tires Online Store",
    "Compare Prices - Tires",
    "amazon.com",
    "0123456789012",
    "",
    "   ",
  ];

  for (const name of junkNames) {
    it(`"${name}" is junk`, () => {
      const r = structureProduct(name, undefined, { knownBrands: BRANDS });
      expect(r.confidence).toBe(0);
      expect(r.brand).toBe("");
      expect(r.model).toBe("");
      expect(r.descriptionText).toBe("");
      expect(r.sizeTag).toBe("");
      expect(r.sizeTagKind).toBe("none");
    });
  }
});

describe("structureProduct - weight / count / volume tags", () => {
  it("9.25 oz -> weight tag", () => {
    const r = structureProduct("Premium Dog Treats 9.25 oz", undefined, {});
    expect(r.sizeTag).toBe("9.25oz");
    expect(r.sizeTagKind).toBe("weight");
  });

  it("30 ct -> count tag", () => {
    const r = structureProduct("Vitamin Gummies 30 ct", undefined, {});
    expect(r.sizeTag).toBe("30ct");
    expect(r.sizeTagKind).toBe("count");
  });

  it("1.5L -> volume tag", () => {
    const r = structureProduct("Spring Water 1.5L", undefined, {});
    expect(r.sizeTag).toBe("1.5l");
    expect(r.sizeTagKind).toBe("volume");
  });

  it("500 ml -> volume tag", () => {
    const r = structureProduct("Hand Sanitizer 500 ml", undefined, {});
    expect(r.sizeTag).toBe("500ml");
    expect(r.sizeTagKind).toBe("volume");
  });

  it("2 pack -> count tag", () => {
    const r = structureProduct("Widget Snack (2 Pack)", undefined, {});
    expect(r.sizeTag).toBe("2pk");
    expect(r.sizeTagKind).toBe("count");
  });

  it("returns sizeTagKind 'none' and empty sizeTag when nothing matches", () => {
    const r = structureProduct("Plain Widget Cleaner", undefined, {});
    expect(r.sizeTag).toBe("");
    expect(r.sizeTagKind).toBe("none");
  });
});

describe("structureProduct - model extraction", () => {
  it("strips quantity prefix, brand, size, load index, and trailing 'Tires' noise", () => {
    const r = structureProduct("2 X TOYO Extensa HP II 275/35r20 102w Tires", undefined, { knownBrands: BRANDS });
    expect(r.brand).toBe("Toyo");
    expect(r.model).toBe("Extensa HP II");
    expect(r.sizeTag).toBe("2753520");
  });

  it("strips a leading '4 New' quantity prefix", () => {
    const r = structureProduct("4 New 265/70R17 Falken Wildpeak AT3W Tires", undefined, { knownBrands: BRANDS });
    expect(r.brand).toBe("Falken");
    expect(r.model).toBe("Wildpeak AT3W");
  });

  it("strips a trailing '| eBay'-style marketplace tail", () => {
    const r = structureProduct("Michelin Defender T+H 205/55R16 | eBay", undefined, { knownBrands: BRANDS });
    expect(r.brand).toBe("Michelin");
    expect(r.model).toBe("Defender T+H");
  });

  it("strips a parenthetical '(2 Pack)' quantity tail", () => {
    const r = structureProduct("Widget Snack Bar (2 Pack)", undefined, {});
    expect(r.model).toBe("Widget Snack Bar");
    expect(r.sizeTag).toBe("2pk");
  });
});

describe("structureProduct - confidence scoring", () => {
  it("0.9+ when brand AND sizeTag are found", () => {
    const r = structureProduct("Michelin Defender T+H 205/55R16", undefined, { knownBrands: BRANDS });
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("0.7 when only brand is found", () => {
    const r = structureProduct("Michelin Premier LTX all season radial", undefined, { knownBrands: BRANDS });
    expect(r.confidence).toBe(0.7);
  });

  it("0.7 when only sizeTag is found", () => {
    const r = structureProduct("205/55R16 all season radial", undefined, { knownBrands: BRANDS });
    expect(r.confidence).toBe(0.7);
  });

  it("0.4 name-only passthrough when neither brand nor size is found", () => {
    const r = structureProduct("all season radial performance", undefined, { knownBrands: BRANDS });
    expect(r.confidence).toBe(0.4);
  });

  it("0 for junk", () => {
    const r = structureProduct("Buy Cheap Tires Online Store", undefined, { knownBrands: BRANDS });
    expect(r.confidence).toBe(0);
  });
});

describe("structureProduct - descriptionText", () => {
  it("is cleaned and noise-stripped but keeps brand/model/size", () => {
    const r = structureProduct("2 X TOYO Extensa HP II 275/35r20 102w Tires", undefined, { knownBrands: BRANDS });
    expect(r.descriptionText).toBe("TOYO Extensa HP II 275/35r20 102w Tires");
  });

  it("is empty for junk names", () => {
    const r = structureProduct("amazon.com", undefined, { knownBrands: BRANDS });
    expect(r.descriptionText).toBe("");
  });
});

// -------------------------------------------------------------------------------------------
// Revision-gate locking tests (Build 2 / structurer review): E1, E2, E3 (eval failure classes)
// + R1-R5 (adversarial code review findings). Each test locks one concrete example from the
// eval failures file / review findings so the underlying regex/lexicon/noise-list fix cannot
// silently regress.
// -------------------------------------------------------------------------------------------
describe("E1 - tire service-prefix (ST/LT/P) must not absorb trailing letters of the model word", () => {
  it('"Courser Quest 195/65R15" keeps the full word "Quest" (the "st" is not a service prefix)', () => {
    const r = structureProduct("Mastercraft Courser Quest 195/65R15 91H", undefined, {
      knownBrands: [...BRANDS, "Mastercraft"],
    });
    expect(r.sizeTag).toBe("1956515");
    expect(r.model).toBe("Courser Quest");
  });

  it('"...HP 225/40R18" keeps the trailing "P" of "HP" (not absorbed as a P-service prefix)', () => {
    const r = structureProduct("Dunlop Signature Hp 235/45R17", undefined, { knownBrands: [...BRANDS, "Dunlop"] });
    expect(r.sizeTag).toBe("2354517");
    expect(r.model).toBe("Signature Hp");
  });
});

describe("E2 - brand lexicon: earliest match position wins, longest is only a tie-break", () => {
  it('"Nokian Nordman 5" picks "Nokian" (earliest), not the longer sub-brand "Nordman"', () => {
    const r = structureProduct("Nokian Nordman 5 205/55R16", undefined, { knownBrands: [...BRANDS, "Nokian", "Nordman"] });
    expect(r.brand).toBe("Nokian");
  });

  it('"Ohtsu By Falken" picks "Ohtsu" (earliest), not the longer known brand "Falken"', () => {
    const r = structureProduct("Ohtsu By Falken Fp8000 225/40R18", undefined, { knownBrands: [...BRANDS, "Ohtsu"] });
    expect(r.brand).toBe("Ohtsu");
  });
});

describe("E3 - MODEL_EDGE_NOISE / LOAD_INDEX_RE must not strip legitimate model tokens", () => {
  it('BFGoodrich "Radial T A" keeps the full model (radial is not stripped when other tokens remain)', () => {
    const r = structureProduct("Bfgoodrich Radial T A P225/70R14 98S", undefined, { knownBrands: [...BRANDS, "Bfgoodrich"] });
    expect(r.sizeTag).toBe("2257014");
    expect(r.model).toBe("Radial T A");
  });

  it('"Altimax 365AW" keeps "365AW" (load-index stripping only applies immediately after the size)', () => {
    const r = structureProduct("General Altimax 365aw 215/45R17 87V", undefined, { knownBrands: [...BRANDS, "General"] });
    expect(r.sizeTag).toBe("2154517");
    expect(r.model).toBe("Altimax 365aw");
  });
});

describe("R1 - tire-plausibility bounds reject non-tire slash/dash numerics", () => {
  it('"16/9-32 inch Monitor Stand" is not tagged as a tire size', () => {
    const r = structureProduct("Acme 16/9-32 inch Monitor Stand", undefined, { knownBrands: BRANDS });
    expect(r.sizeTagKind).not.toBe("tire");
  });

  it('"12/5-14 Batch Code" is not tagged as a tire size', () => {
    const r = structureProduct("Recipe Card 12/5-14 Batch Code", undefined, { knownBrands: BRANDS });
    expect(r.sizeTagKind).not.toBe("tire");
  });

  it("still recognizes every Global Constraints notation example (no plausibility regression)", () => {
    const cases: Array<[string, string]> = [
      ["LT265/70R17", "2657017"],
      ["265 /70 R17", "2657017"],
      ["265x70R17", "2657017"],
      ["245/35ZR19XL", "2453519"],
      ["295/75R22.5", "29575225"],
      ["37x12.50R20", "37125020"],
      ["33x12.50-15LT", "33125015"],
      ["25x8-12", "25812"],
      ["100/80-17", "1008017"],
      ["120/70ZR17", "1207017"],
    ];
    for (const [input, expected] of cases) {
      expect(tireSizeTag(input)).toBe(expected);
    }
  });
});

describe("R2 - a second tire-size mention (multi-size listing) must not leak into the model", () => {
  it('"...205/55R16 and 225/45R17 Tires" keeps sizeTag = first size only, model drops both', () => {
    const r = structureProduct("Michelin Defender 205/55R16 and 225/45R17 Tires", undefined, { knownBrands: BRANDS });
    expect(r.sizeTag).toBe("2055516");
    expect(r.model).toBe("Defender");
    expect(r.model).not.toMatch(/225|45|17/);
  });
});

describe("R3 - an explicit junk brand arg is never trusted, even shaped like a real word", () => {
  it('"amazon.com" as the explicit brand arg is treated as absent, falls through to the lexicon', () => {
    const r = structureProduct("Falken Wildpeak AT3W 265/70R17", "amazon.com", { knownBrands: BRANDS });
    expect(r.brand).toBe("Falken");
  });

  it('a pure code echo brand arg ("0123456789012") is treated as absent', () => {
    const r = structureProduct("Falken Wildpeak AT3W 265/70R17", "0123456789012", { knownBrands: BRANDS });
    expect(r.brand).toBe("Falken");
  });
});
