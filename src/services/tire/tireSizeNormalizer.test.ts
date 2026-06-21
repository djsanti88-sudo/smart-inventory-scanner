import { describe, it, expect } from "vitest";
import { normalizeTireSize, matchTireSize } from "@/services/tire/tireSizeNormalizer";

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
  // --- flotation / commercial ---
  ["35X12.50R20", "35X12.50R20"],
  ["11R22.5", "11R22.5"],
  ["295/75R22.5", "295/75R22.5"],
  // --- dual load index ---
  ["LT265/70R17 121/118S", "LT265/70R17 121/118S"],
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
];

describe("normalizeTireSize", () => {
  it.each(CASES)("normalizes %j -> %j", (input, expected) => {
    expect(normalizeTireSize(input)).toBe(expected);
  });
});

describe("matchTireSize (raw span for description stripping)", () => {
  it("returns the canonical value AND the raw matched substring", () => {
    const m = matchTireSize("Michelin Defender LTX M/S 235/65R18 104H BSW");
    expect(m?.canonical).toBe("235/65R18 104H");
    expect(m?.raw).toContain("235/65R18");
  });

  it("returns null when there is no confident size", () => {
    expect(matchTireSize("Coca-Cola Classic")).toBeNull();
  });
});
