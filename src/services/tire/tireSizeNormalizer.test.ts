import { describe, it, expect } from "vitest";
import { normalizeTireSize, normalizeTrustedCorpusTireSize, matchTireSize, plainTireSizeDigits } from "@/services/tire/tireSizeNormalizer";
import { parseTireIdentity } from "@/services/catalog/tireListingNormalizer";

// TEST-FIRST table: every common tire-size shape -> ONE canonical string. Unknown -> null (never guess).
const CASES: Array<[string, string | null]> = [
  // --- core metric / P-metric / LT, with and without load+speed ---
  ["P225/65ZR18", "P225/65ZR18"],
  ["225/60R18", "225/60R18"],
  ["225/60ZR18", "225/60ZR18"],
  ["LT285/55R20", "LT285/55R20"],
  ["P225/60R18 103H", "P225/60R18 103H"],
  ["ST205/75R15", "ST205/75R15"],
  // --- separator-free / space-separated shorthand ---
  ["225 60 18", "225/60R18"],
  ["2256018", "225/60R18"],
  ["2856020", "285/60R20"],
  ["2356017", "235/60R17"],
  // --- flotation / commercial ---
  ["35X12.50R20", "35X12.50R20"],
  // Boss exact-corpus titles sometimes split the decimal flotation width with a space.
  // The explicit X + R construction and plausibility bounds make this unambiguous.
  ["31x10 50r15lt", "31X10.50R15"],
  ["30x9 50r15lt", "30X9.50R15"],
  ["37x13 50r22lt", "37X13.50R22"],
  ["33x12 5r22lt", "33X12.5R22"],
  ["11R22.5", "11R22.5"],
  ["295/75R22.5", "295/75R22.5"],
  // --- dual load index ---
  ["LT265/70R17 121/118S", "LT265/70R17 121/118S"],
  // --- flotation with a construction-letter prefix directly attached (Group A item 4) ---
  ["LT33X12.50R20", "LT33X12.50R20"],
  ["LT33X12.50R20 114Q", "LT33X12.50R20 114Q"],
  // --- flotation with no prefix must still work unchanged ---
  ["33X12.50R20", "33X12.50R20"],
  ["35X12.50R17", "35X12.50R17"],
  // --- directly attached construction-prefix slash flotation ---
  ["LT37/12.50R22", "LT37X12.50R22"],
  ["LT35/12.50R17", "LT35X12.50R17"],
  ["LT35/11.50R20", "LT35X11.50R20"],
  // --- spaced shorthand WITH an R separator (Group A item 3): "205 50 R17" ---
  ["205 50 R17", "205/50R17"],
  // --- case / whitespace tolerance ---
  ["p225/60r18", "P225/60R18"],
  ["  225/60R18  ", "225/60R18"],
  // --- embedded in a messy product description ---
  ["Michelin Defender LTX M/S 235/65R18 104H BSW", "235/65R18 104H"],
  ["Falken Wildpeak A/T 275/55R20 111T", "275/55R20 111T"],
  ["Goodyear 35X12.50R20 Wrangler", "35X12.50R20"],
  // --- must NOT guess ---
  ["", null],
  ["no size in here", null],
  ["Coca-Cola Classic 12 pack", null],
  ["ABC123", null],
  ["12345", null],
  ["1234567", null], // 7 digits but 123/45/67 -> rim 67 out of range -> not a size
  ["9999999", null], // width 999 out of range
  ["3095015", null], // compact 30x9.50R15 flotation, not a 309 mm metric width
  ["3512520", null], // compact 35x12.50R20 flotation, not a 351 mm metric width
  ["3312522", null], // compact 33x12.50R22 flotation, not a 331 mm metric width
  ["10/75R15.3", null], // agricultural size must not be truncated to 75R15.3
  ["12/80R15.3", null], // agricultural size must not be truncated to 80R15.3
  ["1050/50R32", null], // a metric match must not start inside a longer numeric token
  ["SKU225/60R18", null], // a metric match must not start inside an alphanumeric identifier
  ["12/11R22.5", null], // a commercial match must not start after a slash

  // --- Bug 2 (owner mandate 2026-07-21, 310-row review): a bicycle "NN X N.NNN" dimension is NOT a
  // tire flotation size and must never be fabricated into one. Live-observed: Kenda bike tire
  // "K50 16 X 2.125" was fabricated into "16X2.1R25" - the FLOTATION regex had no plausibility guard
  // at all (unlike every other shorthand pattern), so the decimal "2.125" got split mid-digit into a
  // fake "2.1" width + "25" rim. A real flotation size (e.g. "35X12.50R20") has a genuine explicit
  // ZR/R/- separator before a real 2-digit rim; a bare "16 X 2.125" with nothing after it is not one.
  ["16 X 2.125", null],
  ["K50 16 X 2.125", null],
  ["700 X 23C", null], // road-bike tire dimension, not a flotation size
  ["31x10 50", null], // decimal-width shorthand still requires an explicit rim construction
  ["31x10 50r99", null], // impossible rim
  ["37/12.50R22", null], // slash flotation requires an attached LT/P/ST construction prefix
  ["LT16/2.125R25", null], // directly attached but implausible flotation dimensions
  ["LT 37/12.50R22", null], // separated prefix must not be promoted to a trusted size
  ["LT37/12.50R22ZZ", null], // a trusted slash-flotation token cannot be a prefix of an identifier
  ["LT37/12.50R221", null], // nor a prefix of a longer rim-like number
  ["LT37/12.50R22/123", null], // nor a prefix of a slash-delimited identifier
];

describe("normalizeTireSize", () => {
  it.each(CASES)("normalizes %j -> %j", (input, expected) => {
    expect(normalizeTireSize(input)).toBe(expected);
  });
});

describe("normalizeTrustedCorpusTireSize", () => {
  it("uses exact-row model evidence to disambiguate a compact flotation tag", () => {
    expect(normalizeTrustedCorpusTireSize({
      size: "35125020",
      rawSizeText: "35125020",
      model: "35x12 50r20lt Trail model",
    })).toBe("35X12.50R20");
  });

  it("decodes only unambiguous compact decimal-rim commercial sizes", () => {
    expect(normalizeTrustedCorpusTireSize({ size: "29575225" })).toBe("295/75R22.5");
    expect(normalizeTrustedCorpusTireSize({ size: "35125020" })).toBeNull();
  });
});

describe("matchTireSize (raw span for description stripping)", () => {
  it.each([
    ["Atlas Force UHP 255/50R19 107Y", "255/50R19"],
    ["Nexen Roadian HP 275/55R20", "275/55R20"],
    ["Btr55st 235/80R16", "235/80R16"],
    ["Catchfors M T II LT 35x12.50R20", "35x12.50R20"],
    ["P255/50R19", "P255/50R19"],
    ["LT35x12.50R20", "LT35x12.50R20"],
    ["ST235/80R16", "ST235/80R16"],
    ["Falken Wildpeak LT37/12.50R22", "LT37/12.50R22"],
  ])("matches the size token without consuming a preceding model suffix: %s", (input, raw) => {
    expect(matchTireSize(input)?.raw).toBe(raw);
  });

  it("keeps a separated LT token in the parsed model before a flotation size", () => {
    expect(parseTireIdentity("Catchfors M T II LT 35x12.50R20").model).toBe("Catchfors M T II LT");
  });

  it("does not read a model code's trailing digits and letter as the load/speed", () => {
    const match = matchTireSize("Westlake SU318 H T 255/70R16 111T");
    expect(match?.canonical).toBe("255/70R16 111T");
  });

  it.each([
    ["BKT Agrimax RT 955 R-1 230/95R48 136A8/B", "230/95R48 136A8/B", "136A8/B", "BKT Agrimax RT 955 R-1"],
    ["BKT Agrimax RT 955 R-1 300/95R52 151A8/B", "300/95R52 151A8/B", "151A8/B", "BKT Agrimax RT 955 R-1"],
    ["BKT Agrimax RT 955 R-1 340/85R48 152A8/B", "340/85R48 152A8/B", "152A8/B", "BKT Agrimax RT 955 R-1"],
    ["BKT Agrimax RT 955 R-1 270/95R54 146A8/B", "270/95R54 146A8/B", "146A8/B", "BKT Agrimax RT 955 R-1"],
    ["BKT Agrimax RT 945 R-1w 320/90R50 150A8/B", "320/90R50 150A8/B", "150A8/B", "BKT Agrimax RT 945 R-1w"],
    ["BKT Agrimax RT 945 R-1w 320/90R46 146A8/B", "320/90R46 146A8/B", "146A8/B", "BKT Agrimax RT 945 R-1w"],
    ["BKT Agrimax RT 955 R-1 270/95R38 140A8/B", "270/95R38 140A8/B", "140A8/B", "BKT Agrimax RT 955 R-1"],
    ["BKT Agrimax RT 853 R-1 480/80R38 149A8/B", "480/80R38 149A8/B", "149A8/B", "BKT Agrimax RT 853 R-1"],
    ["BKT Agrimax RT 945 R-1w 380/90R50 151A8/B", "380/90R50 151A8/B", "151A8/B", "BKT Agrimax RT 945 R-1w"],
  ])("keeps agricultural model codes while recognizing the post-size compound load/speed: %s", (input, canonical, rawLoadSpeed, model) => {
    expect(matchTireSize(input)).toMatchObject({ canonical, rawLoadSpeed });
    expect(parseTireIdentity(input).model).toBe(model);
  });

  it("recognizes the corpus-backed agricultural dual-load D/A8 suffix", () => {
    expect(matchTireSize("Ascenso MDR 1000 440/80R30 153/157D/A8")).toMatchObject({
      canonical: "440/80R30 153/157D/A8",
      rawLoadSpeed: "153/157D/A8",
    });
  });

  it("returns the canonical value AND the raw matched substring", () => {
    const m = matchTireSize("Michelin Defender LTX M/S 235/65R18 104H BSW");
    expect(m?.canonical).toBe("235/65R18 104H");
    expect(m?.raw).toContain("235/65R18");
  });

  it("returns null when there is no confident size", () => {
    expect(matchTireSize("Coca-Cola Classic")).toBeNull();
  });
});

describe("plainTireSizeDigits - size-only digits, no spaces, no load/speed (owner filter column)", () => {
  it("strips letters/slashes/spaces and drops the load+speed", () => {
    expect(plainTireSizeDigits("255/55R19 111 V")).toBe("2555519");
    expect(plainTireSizeDigits("P225/60R18 103H")).toBe("2256018");
    expect(plainTireSizeDigits("Michelin Latitude Tour HP 255/55R19 111 V Tire")).toBe("2555519");
    expect(plainTireSizeDigits("265/70R17 115 T")).toBe("2657017");
  });
  it("returns empty for non-tire text (never guesses a size from arbitrary numbers)", () => {
    expect(plainTireSizeDigits("Coca-Cola Classic 12 Pack")).toBe("");
    expect(plainTireSizeDigits("")).toBe("");
    expect(plainTireSizeDigits(null)).toBe("");
  });
});
