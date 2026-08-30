import { describe, expect, it, vi } from "vitest";
import { GPT_DECODE_WORST_CASE_USD, type GptDecodeResult } from "./gptDecodeClient";
import { mapGptDecodeResult, shouldRunGptDecode } from "./gptDecodePolicy";

const baseInput = {
  code: "049000006346",
  codeType: "upc_a",
  apiKeyPresent: true,
  budget: async () => ({ allowed: true, spentUsd: 0, capUsd: 3 }),
};

const result = (overrides: Partial<GptDecodeResult> = {}): GptDecodeResult => ({
  tier: "suggested",
  brand: "Acme",
  productName: "Acme Product",
  category: "Retail",
  specs: "12 oz",
  gtin: "049000006346",
  confidence: 0.7,
  exactCodeFound: false,
  basis: "Evidence",
  sourceUrls: ["https://example.com/product"],
  searches: 1,
  usdComputedFloor: 0.02,
  usdWorstCase: GPT_DECODE_WORST_CASE_USD,
  aborted: false,
  ...overrides,
});

describe("shouldRunGptDecode", () => {
  it("runs for a public code with a key and remaining budget", async () => {
    await expect(shouldRunGptDecode(baseInput)).resolves.toEqual({ run: true, skipReason: "" });
  });

  it("rejects vendor labels before reading the budget", async () => {
    const budget = vi.fn(baseInput.budget);
    await expect(shouldRunGptDecode({ ...baseInput, code: "X001DY7YUT", codeType: "vendor_label", budget }))
      .resolves.toEqual({ run: false, skipReason: "non_public_code_type" });
    expect(budget).not.toHaveBeenCalled();
  });

  it("rejects a missing key before reading the budget", async () => {
    const budget = vi.fn(baseInput.budget);
    await expect(shouldRunGptDecode({ ...baseInput, apiKeyPresent: false, budget }))
      .resolves.toEqual({ run: false, skipReason: "no_api_key" });
    expect(budget).not.toHaveBeenCalled();
  });

  it("reports an exhausted budget", async () => {
    await expect(shouldRunGptDecode({ ...baseInput, budget: async () => ({ allowed: false, spentUsd: 3, capUsd: 3 }) }))
      .resolves.toEqual({ run: false, skipReason: "budget_exceeded" });
  });
});

describe("mapGptDecodeResult", () => {
  it("maps an exact self-report to a suggestion that requires review", () => {
    const mapped = mapGptDecodeResult(result({ tier: "verified", exactCodeFound: true, confidence: 0.95 }), baseInput.code);
    expect(mapped?.decision).toMatchObject({
      status: "suggested",
      exactCodeEvidenceVerifiedByApp: false,
      corroborationPath: "gpt_self_report",
    });
    expect(mapped?.result.needsHumanReview).toBe(true);
  });

  it("maps a weaker identity to a suggestion and preserves plausible identifiers", () => {
    const mapped = mapGptDecodeResult(result(), baseInput.code);
    expect(mapped?.result).toMatchObject({
      productName: "Acme Product",
      primaryBarcode: baseInput.code,
      gtin: baseInput.code,
      upc: baseInput.code,
      ean: "",
    });
    expect(mapped?.decision.status).toBe("suggested");
  });

  it("returns null for an honest miss", () => {
    expect(mapGptDecodeResult(result({ tier: "none", productName: "" }), baseInput.code)).toBeNull();
  });
});
