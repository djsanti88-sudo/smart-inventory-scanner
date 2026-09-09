import { describe, it, expect } from "vitest";
import { isBrandInPrefixFamily } from "../../src/products/tires/tirePrefixLookup.ts";

// Real barcodes for known brands MUST be in their STRONG prefix family after mining + merge.
// Convention-agnostic: goes through the lookup's dual-alignment, so 086699 vs 0086699 both work.
const KNOWN = [
  ["086699220585", "Michelin"], ["029142753568", "Cooper"], ["0848983018830", "Falken"],
  ["092971263164", "Bridgestone"], ["0715459431564", "Hankook"], ["4981910527329", "Toyo"],
  ["054137048381", "Pirelli"], ["0191563015119", "Nexen"], ["0721506160370", "Yokohama"],
];

describe("mined prefix table corroborates known brands' real barcodes", () => {
  for (const [code, brand] of KNOWN) {
    it(`${brand} ${code} is in its strong prefix family`, () => {
      expect(isBrandInPrefixFamily(code, brand, { strongOnly: true })).toBe(true);
    });
  }
});
