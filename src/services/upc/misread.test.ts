import { describe, it, expect } from "vitest";
import { isLikelyMisreadGtin } from "./misread";
import { expandUpcE } from "./gtin";

describe("isLikelyMisreadGtin (A3)", () => {
  it("valid UPC-A is not a misread", () => {
    expect(isLikelyMisreadGtin("049000006346")).toBe(false);
  });
  it("12-digit with wrong check digit IS a misread", () => {
    expect(isLikelyMisreadGtin("049000006345")).toBe(true);
  });
  it("13/14-digit with wrong check digit IS a misread", () => {
    expect(isLikelyMisreadGtin("0049000006345")).toBe(true);
    expect(isLikelyMisreadGtin("00049000006345")).toBe(true);
  });
  it("valid EAN-8 is not a misread", () => {
    expect(isLikelyMisreadGtin("96385074")).toBe(false);
  });
  it("8-digit failing EAN-8 check but expanding to a valid UPC-E/UPC-A is not a misread", () => {
    // Fixture verified: expandUpcE("04252614") -> "042100005264" (a valid UPC-A). Confirm the
    // fixture actually satisfies the expansion contract before relying on it (plan instruction).
    const upcE = "04252614";
    expect(expandUpcE(upcE)).not.toBeNull();
    expect(isLikelyMisreadGtin(upcE)).toBe(false);
  });
  it("8-digit failing BOTH ean-8 check and upc-e expansion IS a misread", () => {
    expect(expandUpcE("12345678")).toBeNull();
    expect(isLikelyMisreadGtin("12345678")).toBe(true); // invalid EAN-8 check, ns 1 expansion invalid
  });
  it("non-GTIN shapes are never misreads (vendor labels, skus)", () => {
    expect(isLikelyMisreadGtin("X001ABC123")).toBe(false);
    expect(isLikelyMisreadGtin("BR-1234")).toBe(false);
    expect(isLikelyMisreadGtin("12345")).toBe(false);
  });

  describe("AM-2: legitimate non-GS1 shapes still fail the check digit BY DESIGN", () => {
    it("a number-system-2 in-store UPC (starts with 2, bad plain GS1 check) is flagged as a misread candidate too", () => {
      // 212345678900 is GTIN-shaped (12 digits) and fails the plain GS1 check digit exactly like a
      // real scanner misread would - the helper cannot distinguish "misread" from "in-store price-
      // embedded code" by shape alone (AM-2). The additive reason (resolver.ts) is what tells the
      // human BOTH possibilities; this helper only answers "does the check digit fail".
      expect(isLikelyMisreadGtin("212345678900")).toBe(true);
    });
    it("a 13-digit non-GS1 warehouse numeric is also flagged (same reason: check digit fails)", () => {
      expect(isLikelyMisreadGtin("9876543210981")).toBe(true);
    });
    it("a 14-digit ITF-14-shaped wrapper with a bad plain check is also flagged", () => {
      expect(isLikelyMisreadGtin("18400000567895")).toBe(true);
    });
  });
});
