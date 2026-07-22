import { describe, it, expect } from "vitest";
import {
  canAutoCount,
  shouldAutoApplySuggestion,
  decodeCorroborated,
  isPublicBarcodeShape,
  type AutoCountInput,
} from "./scanGates";

// Shared happy-path inputs; each test overrides only the field under scrutiny so the conjunction is exercised.
const baseCount: AutoCountInput = {
  codeType: "upc_a",
  decision: {
    status: "verified",
    corroborationPath: "exact_code_evidence",
    confidence: 0.95,
    exactCodeEvidenceVerifiedByApp: true,
  },
  productName: "Moen Faucet Cartridge 1225",
  productNameUsable: true,
  tireOk: true,
  contextConflict: undefined,
};

describe("decodeCorroborated - what counts as corroboration for auto-count", () => {
  it("true for app-verified exact code", () => {
    expect(decodeCorroborated({ exactCodeEvidenceVerifiedByApp: true })).toBe(true);
  });
  it("true for the internet two-source size path WITHOUT exact-code", () => {
    expect(decodeCorroborated({ exactCodeEvidenceVerifiedByApp: false, corroborationPath: "internet_two_source_size" })).toBe(true);
  });
  it("false for a bare suggested decode with neither", () => {
    expect(decodeCorroborated({ exactCodeEvidenceVerifiedByApp: false })).toBe(false);
  });
  it("false for other corroboration paths without exact code", () => {
    expect(decodeCorroborated({ exactCodeEvidenceVerifiedByApp: false, corroborationPath: "two_ai_agreement" })).toBe(false);
  });
  it("false for null/undefined", () => {
    expect(decodeCorroborated(null)).toBe(false);
    expect(decodeCorroborated(undefined)).toBe(false);
  });
});

describe("isPublicBarcodeShape", () => {
  it("true only for upc_a / ean_13 / gtin_14", () => {
    expect(isPublicBarcodeShape("upc_a")).toBe(true);
    expect(isPublicBarcodeShape("ean_13")).toBe(true);
    expect(isPublicBarcodeShape("gtin_14")).toBe(true);
  });
  it("false for vendor / SKU / part-number shapes", () => {
    for (const t of ["numeric_sku", "alpha_sku", "vendor_label", "messy", "ean_8", ""]) {
      expect(isPublicBarcodeShape(t)).toBe(false);
    }
  });
});

describe("canAutoCount - Phase-7 evidence gate (pure)", () => {
  it("auto-counts an app-verified exact code on a public barcode", () => {
    expect(canAutoCount(baseCount).allowed).toBe(true);
  });

  it("auto-counts the internet_two_source_size path (no exact code) on a public barcode", () => {
    expect(
      canAutoCount({
        ...baseCount,
        decision: { status: "verified", corroborationPath: "internet_two_source_size", confidence: 0.9, exactCodeEvidenceVerifiedByApp: false },
      }).allowed,
    ).toBe(true);
  });

  // D6 core (2026-07-20): the gptTrusted escape hatch is DELETED. A bare GPT self-report
  // (corroborationPath "gpt_self_report", not app-corroborated) can no longer auto-count, even on a
  // public barcode shape and even at high confidence. The evidence-corroborated branch is now the
  // ONLY verified-auto-count path.
  it("REFUSES a gpt_self_report verified decode even on a PUBLIC barcode (gptTrusted escape hatch deleted)", () => {
    expect(
      canAutoCount({
        ...baseCount,
        codeType: "upc_a",
        decision: { status: "verified", corroborationPath: "gpt_self_report", confidence: 0.95, exactCodeEvidenceVerifiedByApp: false },
      }).allowed,
    ).toBe(false);
  });

  it("REFUSES a gpt_self_report verified decode on a NON-public (vendor/SKU) shape - the code-1225 lesson", () => {
    for (const codeType of ["numeric_sku", "alpha_sku", "vendor_label", "messy"]) {
      expect(
        canAutoCount({
          ...baseCount,
          codeType,
          decision: { status: "verified", corroborationPath: "gpt_self_report", confidence: 0.95, exactCodeEvidenceVerifiedByApp: false },
        }).allowed,
      ).toBe(false);
    }
  });

  it("REFUSES a verified decode with neither exact-code nor two-source corroboration", () => {
    expect(
      canAutoCount({
        ...baseCount,
        decision: { status: "verified", corroborationPath: "two_ai_agreement", confidence: 0.95, exactCodeEvidenceVerifiedByApp: false },
      }).allowed,
    ).toBe(false);
  });

  it("REFUSES a non-verified (suggested) decode even with exact-code claim", () => {
    expect(
      canAutoCount({
        ...baseCount,
        decision: { status: "suggested", corroborationPath: "exact_code_evidence", confidence: 0.95, exactCodeEvidenceVerifiedByApp: true },
      }).allowed,
    ).toBe(false);
  });

  it("REFUSES when confidence is below 0.8", () => {
    expect(canAutoCount({ ...baseCount, decision: { ...baseCount.decision!, confidence: 0.79 } }).allowed).toBe(false);
  });

  it("REFUSES when the product name is not usable (wrong identity is failure, unknown is acceptable)", () => {
    expect(canAutoCount({ ...baseCount, productNameUsable: false }).allowed).toBe(false);
  });

  it("REFUSES when a tire scan lacks a countable identity (tireOk false)", () => {
    expect(canAutoCount({ ...baseCount, tireOk: false }).allowed).toBe(false);
  });

  it("REFUSES on any scan-context / brand-prefix conflict (firewall)", () => {
    expect(canAutoCount({ ...baseCount, contextConflict: "category_context_conflict" }).allowed).toBe(false);
  });

  it("still refuses a gpt_self_report decode when a firewall conflict is also present (belt-and-suspenders)", () => {
    expect(
      canAutoCount({
        ...baseCount,
        decision: { status: "verified", corroborationPath: "gpt_self_report", confidence: 0.95, exactCodeEvidenceVerifiedByApp: false },
        contextConflict: "brand_prefix_conflict",
      }).allowed,
    ).toBe(false);
  });
});

describe("shouldAutoApplySuggestion - high-trust suggestion auto-apply (pure)", () => {
  const base = {
    autoAddOn: true,
    contextConflict: undefined as unknown,
    productNameUsable: true,
    confidence: 0.9,
    status: "suggested" as string | undefined,
    exactCodeEvidenceVerifiedByApp: false,
  };

  it("applies a confidence>=0.8 NON-verified suggestion", () => {
    expect(shouldAutoApplySuggestion({ ...base })).toBe(true);
  });

  it("applies an app-verified exact 'verified' decode", () => {
    expect(shouldAutoApplySuggestion({ ...base, status: "verified", confidence: 0.5, exactCodeEvidenceVerifiedByApp: true })).toBe(true);
  });

  // TRUST FIREWALL: raw confidence on a "verified" decode is the provider's self-report, not proof.
  it("REFUSES a high-confidence 'verified' decode that is NOT app-verified exact (T20/1225 class)", () => {
    expect(shouldAutoApplySuggestion({ ...base, status: "verified", confidence: 0.95, exactCodeEvidenceVerifiedByApp: false })).toBe(false);
  });

  it("REFUSES when confidence < 0.8 and not app-verified exact", () => {
    expect(shouldAutoApplySuggestion({ ...base, confidence: 0.7 })).toBe(false);
  });

  it("REFUSES when the master switch autoAddOn is off", () => {
    expect(shouldAutoApplySuggestion({ ...base, autoAddOn: false })).toBe(false);
  });

  it("REFUSES on a context conflict", () => {
    expect(shouldAutoApplySuggestion({ ...base, contextConflict: "category_context_conflict" })).toBe(false);
  });

  it("REFUSES when the product name is not usable", () => {
    expect(shouldAutoApplySuggestion({ ...base, productNameUsable: false })).toBe(false);
  });
});
