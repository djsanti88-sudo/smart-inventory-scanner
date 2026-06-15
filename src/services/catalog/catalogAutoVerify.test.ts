import { describe, it, expect } from "vitest";
import { planAutoVerify } from "@/services/catalog/catalogAutoVerify";
import { sanitizeCatalogEntry } from "@/services/catalog/sanitizeCatalog";
import type { AiLookupResult, DecodeDecision } from "@/types";
import type { AutoVerifySettings } from "@/services/catalog/evidenceScoring";

const SETTINGS: AutoVerifySettings = {
  autoCatalogLearningEnabled: true,
  autoVerifyConfidenceThreshold: 80,
  trustedSourceAutoVerifyEnabled: true,
  aiOnlyAutoVerifyAllowed: false,
};

function best(over: Partial<AiLookupResult> = {}): AiLookupResult {
  return {
    productName: "BIC Classic Pocket Lighter", brand: "BIC", category: "Lighters", specsShort: "", specsFull: "",
    primarySku: "", primaryBarcode: "070330611016", gtin: "", upc: "", ean: "", aliases: [],
    imageUrl: "", productUrl: "", sourceUrls: ["https://www.amazon.com/dp/B000"], confidence: 0.9,
    verifiedFacts: [], guesses: [], needsHumanReview: false, ...over,
  };
}
function decision(over: Partial<DecodeDecision> = {}): DecodeDecision {
  return {
    status: "verified", confidence: 0.9, reason: "", evidenceStrength: "snippet",
    exactCodeEvidenceVerifiedByApp: true,
    crossCheck: { decision: "agree", confidence: 0.9, reason: "", brandSimilarity: 1, nameSimilarity: 1, contradictions: [] },
    ...over,
  };
}

describe("planAutoVerify (decode evidence -> tier -> score -> decision)", () => {
  it("strong Tier-2 exact-evidence decode auto-verifies (no extra inputs needed)", () => {
    const plan = planAutoVerify({ code: "070330611016", codeType: "upc_a", decision: decision(), best: best(), catalog: [], settings: SETTINGS });
    expect(plan.status).toBe("auto_verify");
    expect(plan.score).toBeGreaterThanOrEqual(80);
    expect(plan.sourceTier).toBe("strong_commercial");
  });

  it("AI product with no app-evidence still auto-adds (trust the AI), catalog pending", () => {
    const plan = planAutoVerify({
      code: "070330611016", codeType: "upc_a",
      decision: decision({ status: "suggested", evidenceStrength: "none", exactCodeEvidenceVerifiedByApp: false, crossCheck: { decision: "single_provider", confidence: 0.4, reason: "", brandSimilarity: 0, nameSimilarity: 0, contradictions: [] } }),
      best: best({ sourceUrls: [] }), catalog: [], settings: SETTINGS,
    });
    expect(plan.status).toBe("auto_verify");
    expect(plan.verifiedBy).toBeNull(); // no exact evidence -> counted + aliased, catalog pending
  });

  it("a decode that returned NO usable product -> Needs Review", () => {
    const plan = planAutoVerify({
      code: "070330611016", codeType: "upc_a",
      decision: decision({ status: "needs_review", evidenceStrength: "none", exactCodeEvidenceVerifiedByApp: false }),
      best: best({ productName: "" }), catalog: [], settings: SETTINGS,
    });
    expect(plan.status).toBe("needs_review");
  });

  it("conflict with an existing verified catalog entry -> Needs Review (no overwrite)", () => {
    const existing = sanitizeCatalogEntry(
      { barcode: "070330611016", normalizedBarcode: "070330611016", name: "Totally Different Product" },
      { now: "t", verificationStatus: "verified", verifiedBy: "owner", by: "owner" },
    );
    const plan = planAutoVerify({ code: "070330611016", codeType: "upc_a", decision: decision(), best: best(), catalog: [existing], settings: SETTINGS });
    expect(plan.status).toBe("needs_review");
    expect(plan.blockingReasons).toContain("Conflicts with a verified catalog entry");
  });

  it("a junk-looking source still auto-adds a usable verified product (trust the AI)", () => {
    const plan = planAutoVerify({
      code: "070330611016", codeType: "upc_a", decision: decision(),
      best: best({ sourceUrls: ["https://www.amazon.com/s?k=bic"] }), catalog: [], settings: SETTINGS,
    });
    expect(plan.status).toBe("auto_verify");
  });

  it("a vendor/internal code without an approved alias -> Needs Review", () => {
    const plan = planAutoVerify({ code: "X004DY7YUT", codeType: "vendor_label", decision: decision(), best: best(), catalog: [], settings: SETTINGS });
    expect(plan.status).toBe("needs_review");
    expect(plan.blockingReasons).toContain("Vendor/internal code without an approved alias");
  });
});
