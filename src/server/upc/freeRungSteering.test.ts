import { describe, it, expect } from "vitest";
import { steerFreeRungs } from "./freeRungSteering";

// Real fixtures pulled from src/services/tire/tirePrefixHints.ts (generated tire-prefix hint table):
//   - line 21: `"04501135": [{ brand: "Aplus", weight: "strong" }]` - an 8-digit STRONG prefix (Aplus).
//   - line 110: `"086699": [{ brand: "Michelin", weight: "strong" }, { brand: "BFGoodrich", weight: "strong" },
//     { brand: "Uniroyal (US)", weight: "strong" }, { brand: "Oliver", weight: "weak" }]` - a 6-digit
//     STRONG prefix (shared Michelin/BFGoodrich/Uniroyal GS1 company prefix) - AM-3's canonical
//     "shared 6-digit company prefix" false-positive case: strong weight, but too short to steer.
//   - line 18: `"025114": [{ brand: "Carlisle", weight: "weak" }, { brand: "ITP", weight: "weak" },
//     { brand: "Carlisle (Ag)", weight: "weak" }]` - a 6-digit prefix whose hints are ALL weak.
//
// GTIN-13 construction: lookupTirePrefix normalizes a 12-digit UPC-A `d` to GTIN-13 `"0" + d` and then
// matches `g.startsWith(prefix)` or `g.startsWith("0" + prefix)`. To land a match at the START of the
// GTIN-13 (so the matched prefix is exactly the table key, not some shorter/longer coincidental
// substring), each 12-digit fixture below is built as `(prefix's GTIN-13 form minus its leading
// zero).padEnd(12, "1")`.

describe("A6 free-rung tire steering (AM-3 hardened gate)", () => {
  it("skips free rungs for a REAL strong tire-prefix hint whose matched prefix is >= 8 digits (Aplus, 04501135)", () => {
    // GTIN-13 "0450113511111" -> UPC-A "450113511111" (prefix "04501135", 8 digits, strong).
    const s = steerFreeRungs("450113511111");
    expect(s.skip).toBe(true);
    expect(s.reason).toContain("tire-prefix steering");
    expect(s.reason).toContain("04501135");
  });

  it("does NOT skip a 6-digit STRONG shared-company prefix even though it is strong (Michelin/BFGoodrich, 086699 - false-positive protection)", () => {
    // GTIN-13 "0866991111111" -> UPC-A "866991111111" (prefix "086699", 6 digits, strong-but-short).
    const s = steerFreeRungs("866991111111");
    expect(s.skip).toBe(false);
  });

  it("weak-only hints do NOT steer (Carlisle/ITP, 025114 - no strong evidence at all)", () => {
    // GTIN-13 "0251141111111" -> UPC-A "251141111111" (prefix "025114", all weak).
    const s = steerFreeRungs("251141111111");
    expect(s.skip).toBe(false);
  });

  it("does not skip for an unrecognized prefix", () => {
    const s = steerFreeRungs("999999999999");
    expect(s.skip).toBe(false);
    expect(s.reason).toBe("");
  });

  it("non-GTIN shapes never steer (no prefix lookup is even possible)", () => {
    const s = steerFreeRungs("ABC123");
    expect(s.skip).toBe(false);
  });
});
