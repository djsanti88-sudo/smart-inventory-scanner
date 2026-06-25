import { describe, it, expect } from "vitest";
import { parseSpecResponse } from "./groundedSpecFinder";

describe("groundedSpecFinder parse", () => {
  it("maps a grounded JSON answer to a result + strong evidence when the exact code is grounded", () => {
    const out = parseSpecResponse(
      { brand: "Cooper", model: "Discoverer AT3", size: "245/75R16", loadIndex: "111", speedRating: "T",
        sourceUrl: "https://www.coopertires.com/...", exactCodeGrounded: true },
      "029142753568", "Cooper");
    expect(out.result?.productName).toContain("Discoverer AT3");
    expect(out.result?.productName).toContain("245/75R16");
    expect(out.result?.brand).toBe("Cooper");
    expect(out.result?.corroboratedByModel).toBe(true);
    expect(out.evidence.verified).toBe(true);
    expect(["fetched_source", "grounding_chunk"]).toContain(out.evidence.strength);
  });
  it("returns weak evidence when the exact code is NOT grounded", () => {
    const out = parseSpecResponse({ brand: "Cooper", model: "AT3", size: "245/75R16", exactCodeGrounded: false }, "029142753568", "Cooper");
    expect(out.evidence.verified).toBe(false);
  });
});
