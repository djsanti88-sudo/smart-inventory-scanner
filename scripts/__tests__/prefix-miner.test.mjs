import { describe, it, expect } from "vitest";
import { normalizeToGtin13, longestCommonPrefix, deriveBrandPrefixes } from "../lib/prefix-miner.mjs";

describe("prefix-miner", () => {
  it("normalizes UPC-A to GTIN-13 by zero-padding", () => {
    expect(normalizeToGtin13("848983006257")).toBe("0848983006257");
    expect(normalizeToGtin13("4019238334760")).toBe("4019238334760");
    expect(normalizeToGtin13("abc")).toBe(null);
  });
  it("longestCommonPrefix stops where the item-references diverge", () => {
    // diverge at index 7 (the digit after the 7-digit company prefix) -> LCP is the prefix
    expect(longestCommonPrefix(["0848983106257", "0848983207933", "0848983325555"])).toBe("0848983");
  });
  it("derives a cross-confirmed prefix from >=2 barcodes (Falken-like)", () => {
    const out = deriveBrandPrefixes(["848983106257", "848983207933", "848983325555"]);
    expect(out).toHaveLength(1);
    expect(out[0].prefix).toBe("0848983");
    expect(out[0].count).toBe(3);
  });
  it("does NOT emit a prefix when only one barcode confirms it", () => {
    expect(deriveBrandPrefixes(["848983006257"])).toHaveLength(0);
  });
  it("emits multiple prefixes for a brand using two GS1 blocks", () => {
    const out = deriveBrandPrefixes(["086699220585", "086699091000", "352870111111", "352870222222"]);
    expect(out.map((o) => o.prefix).sort()).toEqual(["0086699", "0352870"]);
  });
});
