// src/decoding/decode.countable.test.ts
import { describe, it, expect } from "vitest";
import { decideDecode, type DecodeParams } from "./decode";
import type { AiLookupResult, EvidenceResult } from "@/types";

// MASTER BASELINE v1: decideDecode auto-verifies any public barcode with strong app-verified evidence
// (single_source). Tire-spec completeness (size + model + load/speed) and non-tire/scan-context rejection
// are NOT decode-level gates anymore - the store auto-count gate (tireAutoCountOk + contextConflict)
// enforces those downstream. These tests pin the decode-level contract under the new policy.

// Test fixtures only need a subset of AiLookupResult/EvidenceResult fields; Partial<> + cast keeps
// the literals terse without weakening the assertions below.
function result(partial: Partial<AiLookupResult>): AiLookupResult {
  return partial as AiLookupResult;
}
function evidence(partial: Partial<EvidenceResult>): EvidenceResult {
  return partial as EvidenceResult;
}

const cooper: DecodeParams = {
  codeType: "upc_a" as const,
  confidenceThreshold: 0.8,
  code: "029142753568",
  scanContext: "tire" as const,
  results: [result({ productName: "Cooper Discoverer AT3 245/75R16", brand: "Cooper", confidence: 0.92, corroboratedByModel: true })],
  evidences: [evidence({ verified: true, strength: "fetched_source" })],
};

describe("decode-level verify (any-source baseline)", () => {
  it("verifies a tire with size+model and strong evidence", () => {
    expect(decideDecode(cooper).status).toBe("verified");
  });
  it("still verifies at the DECODE level when the model is thin (size only) - tire-spec completeness is a STORE-gate concern now", () => {
    const d = decideDecode({ ...cooper, results: [result({ productName: "Cooper 245/75R16", brand: "Cooper", confidence: 0.92, corroboratedByModel: true })] });
    expect(d.status).toBe("verified");
  });
  it("verifies a non-tire product with strong evidence (scan-anything) - the tire-only rejection moved to the store gate", () => {
    const d = decideDecode({ codeType: "upc_a", confidenceThreshold: 0.8, code: "745125495781", scanContext: "any",
      results: [result({ productName: "Manstel Rivet Kit", brand: "Manstel", confidence: 0.95 })],
      evidences: [evidence({ verified: true, strength: "fetched_source" })] });
    expect(d.status).toBe("verified");
  });
  it("PLAN C: a catalog-derived brand-prefix conflict is ADVISORY - with strong (fetched_source) evidence it no longer blocks", () => {
    // Reconciled (Plan C Task 2): GS1 prefixes are many-to-one; with the app-confirmed EXACT code in strong
    // evidence the brand-prefix mismatch no longer blocks (grounding/corpus wins). Category/poison guard is
    // enforced separately downstream (scanContextFirewall / store) and is unaffected.
    const d = decideDecode({ ...cooper, brandPrefixConflict: true });
    expect(d.status).toBe("verified");
  });
});
