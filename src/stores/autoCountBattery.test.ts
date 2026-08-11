import { describe, it, expect } from "vitest";
import { canAutoCount, type AutoCountInput } from "./scanGates";

// B5 (2026-07-15): a dedicated adversarial battery for the Phase-7 evidence gate, separate from
// scanGates.test.ts's per-clause unit tests. This file's job is to hammer REALISTIC composite inputs
// (the shapes a live decode would actually produce) and prove every doubtful one is rejected with an
// HONEST reason string. Wrong identity is FAILURE; unknown is ACCEPTABLE - every rejection here is a
// proof that the gate still refuses to guess. If any adversarial case below unexpectedly PASSES
// canAutoCount, that is a REAL FINDING (a hole in the 100% auto-count precision claim) - the test must
// NOT be adjusted to make it green; it must be reported.
const base: AutoCountInput = {
  codeType: "upc_a", tireOk: true, contextConflict: null, productNameUsable: true,
  decision: { status: "verified", confidence: 0.9, exactCodeEvidenceVerifiedByApp: true, corroborationPath: "app_verified" },
  productName: "Michelin Defender LTX M/S 275/60R20 115T",
};

describe("B5 auto-count adversarial battery - never count a doubtful identity", () => {
  it("control: fully verified + corroborated tire auto-counts", () => {
    expect(canAutoCount(base).allowed).toBe(true);
  });
  // D6 core (2026-07-20): the gptTrusted escape hatch is DELETED - a bare gpt_self_report can never
  // auto-count, even on a public barcode shape. This is now a reject case, not a control.
  it("gpt self-report on a public barcode does NOT auto-count (gptTrusted escape hatch deleted)", () => {
    const d = { ...base, decision: { ...base.decision, corroborationPath: "gpt_self_report", exactCodeEvidenceVerifiedByApp: false } };
    expect(canAutoCount(d).allowed).toBe(false);
  });
  const rejects: Array<[string, AutoCountInput, string]> = [
    ["vendor label shape", { ...base, codeType: "vendor_label", decision: { ...base.decision, corroborationPath: "gpt_self_report", exactCodeEvidenceVerifiedByApp: false } }, "not app-corroborated"],
    ["confidence 0.79", { ...base, decision: { ...base.decision, confidence: 0.79 } }, "confidence below 0.8"],
    ["suggested status", { ...base, decision: { ...base.decision, status: "suggested" } }, "not app-corroborated"],
    ["missing tire specs", { ...base, tireOk: false }, "tire scan missing countable identity"],
    ["brand-prefix conflict", { ...base, contextConflict: { kind: "brand_prefix" } }, "conflict"],
    ["unusable product name", { ...base, productNameUsable: false }, "no usable product name"],
    ["no decision at all", { ...base, decision: null }, "confidence below 0.8"],
    ["verified but NOT corroborated", { ...base, decision: { ...base.decision, exactCodeEvidenceVerifiedByApp: false, corroborationPath: "single_provider" } }, "not app-corroborated"],
    ["gpt self-report on NON-public shape", { ...base, codeType: "alpha_sku", decision: { ...base.decision, corroborationPath: "gpt_self_report", exactCodeEvidenceVerifiedByApp: false } }, "not app-corroborated"],
    ["zero confidence", { ...base, decision: { ...base.decision, confidence: 0 } }, "confidence below 0.8"],
  ];
  for (const [name, input, reasonPart] of rejects) {
    it(`rejects: ${name}`, () => {
      const r = canAutoCount(input);
      expect(r.allowed).toBe(false);
      expect(r.reason).toContain(reasonPart);
    });
  }
});
