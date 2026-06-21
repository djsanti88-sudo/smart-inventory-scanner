import { describe, it, expect } from "vitest";
import { lookupTirePrefix, isBrandInPrefixFamily } from "@/services/tire/tirePrefixLookup";
import { TIRE_PREFIX_HINTS, type PrefixHint } from "@/services/tire/tirePrefixHints";

describe("tire prefix data: tiers loaded, excluded rows held out", () => {
  it("loads strong and weak tiers correctly", () => {
    expect(TIRE_PREFIX_HINTS["086699"].find((h) => h.brand === "Michelin")?.weight).toBe("strong");
    expect(TIRE_PREFIX_HINTS["352870"].find((h) => h.brand === "Kleber")?.weight).toBe("weak");
  });

  it("excludes exclude_partnumber and review_before_use rows (per-row, not per-prefix)", () => {
    const allBrands = Object.values(TIRE_PREFIX_HINTS).flat().map((h) => h.brand);
    expect(allBrands).not.toContain("Hoosier"); // exclude_partnumber
    expect(allBrands).not.toContain("Interco (Super Swamper)"); // exclude_partnumber
    expect(allBrands).not.toContain("Roadmaster"); // review_before_use
    // 069766 is ingested via Dunlop (hint_strong) but Goodyear's row is review_before_use -> held out
    expect(TIRE_PREFIX_HINTS["069766"].some((h) => h.brand === "Dunlop")).toBe(true);
    expect(TIRE_PREFIX_HINTS["069766"].some((h) => h.brand === "Goodyear")).toBe(false);
  });
});

describe("lookupTirePrefix: leading-zero variance + longest-prefix-wins", () => {
  it("maps a US UPC-A whose 6-digit prefix sits after the GTIN-13 leading zero", () => {
    const m = lookupTirePrefix("086699220585"); // Michelin UPC-A
    expect(m?.prefix).toBe("086699");
    expect(m?.brands.map((b) => b.brand)).toEqual(expect.arrayContaining(["Michelin", "BFGoodrich"]));
  });

  it("maps 7-digit (leading zero included) and 8-digit and EAN-13 prefixes", () => {
    expect(lookupTirePrefix("0848983018830")?.prefix).toBe("0848983"); // Falken, 13-digit
    expect(lookupTirePrefix("840139644610")?.prefix).toBe("08401396"); // Fortune, 8-digit prefix from a 12-digit UPC
    expect(lookupTirePrefix("4019238334760")?.prefix).toBe("4019238"); // Continental, EAN-13
  });

  it("longest matching prefix wins when prefixes nest", () => {
    const table: Record<string, PrefixHint[]> = {
      "086699": [{ brand: "Short", weight: "weak" }],
      "0866992": [{ brand: "Long", weight: "strong" }],
    };
    expect(lookupTirePrefix("086699220585", table)?.prefix).toBe("0866992");
  });

  it("returns null for a non-public or unmapped code (no guess)", () => {
    expect(lookupTirePrefix("ABC123")).toBeNull();
    expect(lookupTirePrefix("000000000000")).toBeNull();
  });
});

describe("isBrandInPrefixFamily: shared prefix = family, no false conflict", () => {
  it("any sibling brand in the family is recognized", () => {
    expect(isBrandInPrefixFamily("086699220585", "BFGoodrich")).toBe(true);
    expect(isBrandInPrefixFamily("086699220585", "Uniroyal")).toBe(true);
    expect(isBrandInPrefixFamily("086699220585", "Michelin")).toBe(true);
  });

  it("an unrelated brand is NOT in the family", () => {
    expect(isBrandInPrefixFamily("086699220585", "Bridgestone")).toBe(false);
    expect(isBrandInPrefixFamily("086699220585", "")).toBe(false);
  });
});
