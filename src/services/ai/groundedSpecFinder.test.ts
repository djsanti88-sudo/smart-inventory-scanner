import { describe, it, expect } from "vitest";
import { parseSpecResponse } from "./groundedSpecFinder";

describe("groundedSpecFinder identity parse (pure)", () => {
  it("anchors the brand and builds productName from brand+model+size", () => {
    const out = parseSpecResponse({ brand: "WRONGBRAND", model: "Discoverer AT3", size: "245/75R16" }, "Cooper");
    expect(out.result?.brand).toBe("Cooper"); // anchor wins over the model's brand
    expect(out.result?.productName).toContain("Discoverer AT3");
    expect(out.result?.productName).toContain("245/75R16");
  });
  it("returns null when there is no model and no size", () => {
    expect(parseSpecResponse({ brand: "Cooper" }, "Cooper").result).toBeNull();
  });
});
