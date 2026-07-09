// src/services/upc/gtin.test.ts
import { describe, it, expect } from "vitest";
import { canonicalGtin, gtinVariants, isValidCheckDigit, isGtinShaped } from "./gtin";

describe("gtin utilities", () => {
  it("canonicalizes UPC-A and its zero-padded EAN-13 to the SAME key", () => {
    expect(canonicalGtin("036000291452")).toBe(canonicalGtin("0036000291452"));
  });
  it("NEVER collapses a case-pack GTIN-14 (indicator >= 1) into the unit GTIN", () => {
    // 10016000507255 is the CASE of unit 016000507255 - different countable products
    expect(canonicalGtin("10016000507255")).not.toBe(canonicalGtin("016000507255"));
  });
  it("returns null for non-GTIN input", () => {
    expect(canonicalGtin("DCB205")).toBeNull();
    expect(canonicalGtin("X004DY7YUT")).toBeNull();
  });
  it("variants cover 12/13/14 digit zero-pads (matches retailKnowledgeIndex behavior)", () => {
    const v = gtinVariants("848983006257");
    expect(v).toContain("848983006257");
    expect(v).toContain("0848983006257");
    expect(v).toContain("00848983006257");
  });
  it("validates GS1 check digits", () => {
    expect(isValidCheckDigit("036000291452")).toBe(true);  // real UPC-A
    expect(isValidCheckDigit("036000291453")).toBe(false); // last digit off by one
    expect(isValidCheckDigit("4006381333931")).toBe(true); // real EAN-13
  });
  it("isGtinShaped accepts 8/12/13/14 digits only", () => {
    expect(isGtinShaped("12345678")).toBe(true);
    expect(isGtinShaped("1234567")).toBe(false);
    expect(isGtinShaped("FL-820-S")).toBe(false);
  });
});
