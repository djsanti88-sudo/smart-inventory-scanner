// src/services/ai/decode.countable.test.ts
import { describe, it, expect } from "vitest";
import { decideDecode } from "./decode";

// A real Cooper prefix (029142...) with a size+model name but no load/speed. Strong fetched_source evidence.
const cooper = {
  codeType: "upc_a" as const,
  confidenceThreshold: 0.85,
  code: "029142753568",
  scanContext: "tire" as const,
  results: [{ productName: "Cooper Discoverer AT3 245/75R16", brand: "Cooper", confidence: 0.92, corroboratedByModel: true } as any],
  evidences: [{ verified: true, strength: "fetched_source" } as any],
};

describe("countable tire verify (brand+size+model)", () => {
  it("verifies a prefix-family tire with size+model and strong evidence (no load/speed needed)", () => {
    expect(decideDecode(cooper).status).toBe("verified");
  });
  it("does NOT verify when the model is missing (size only)", () => {
    const d = decideDecode({ ...cooper, results: [{ productName: "Cooper 245/75R16", brand: "Cooper", confidence: 0.92, corroboratedByModel: true } as any] });
    expect(d.status).not.toBe("verified");
  });
  it("does NOT verify a non-tire poison even with strong evidence", () => {
    const d = decideDecode({ codeType: "upc_a", confidenceThreshold: 0.85, code: "745125495781", scanContext: "tire",
      results: [{ productName: "Manstel Rivet Kit", brand: "Manstel", confidence: 0.95 } as any],
      evidences: [{ verified: true, strength: "fetched_source" } as any] });
    expect(d.status).not.toBe("verified");
  });
});
