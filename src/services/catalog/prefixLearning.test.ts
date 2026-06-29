import { describe, it, expect } from "vitest";
import { isLearnablePrefix } from "@/services/catalog/prefixLearning";

// Self-learning flywheel gate: only a GENUINELY verified decode teaches the prefix map. Owner rule:
// verified + app-verified exact code + confidence >= 0.90 + a public barcode + a real brand. Anything
// weaker (suggested, model-confidence-only, vendor code, no brand) must NOT teach - garbage in = garbage
// vetoes. Learned prefixes are evidence, never identity truth (same trust posture as derived).

const base = {
  status: "verified",
  confidence: 0.95,
  exactCodeEvidenceVerifiedByApp: true,
  codeType: "upc_a" as const,
  brand: "Idahoan",
};

describe("isLearnablePrefix (flywheel gate)", () => {
  it("learns from a verified, app-verified, high-confidence public-barcode decode with a brand", () => {
    expect(isLearnablePrefix(base)).toBe(true);
  });
  it("does NOT learn below 0.90 confidence", () => {
    expect(isLearnablePrefix({ ...base, confidence: 0.89 })).toBe(false);
  });
  it("does NOT learn a non-verified decode", () => {
    expect(isLearnablePrefix({ ...base, status: "suggested" })).toBe(false);
  });
  it("does NOT learn without app-verified exact-code evidence (model self-claim is not enough)", () => {
    expect(isLearnablePrefix({ ...base, exactCodeEvidenceVerifiedByApp: false })).toBe(false);
  });
  it("does NOT learn from a vendor/internal code type", () => {
    expect(isLearnablePrefix({ ...base, codeType: "vendor_label" })).toBe(false);
  });
  it("does NOT learn without a brand", () => {
    expect(isLearnablePrefix({ ...base, brand: "" })).toBe(false);
  });
});
