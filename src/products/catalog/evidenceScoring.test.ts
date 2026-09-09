import { describe, it, expect } from "vitest";
import { scoreCatalogCandidate, decideAutoVerification, type ScoreFlags, type AutoVerifySettings } from "@/products/catalog/evidenceScoring";

const SETTINGS: AutoVerifySettings = {
  autoCatalogLearningEnabled: true,
  autoVerifyConfidenceThreshold: 80,
  trustedSourceAutoVerifyEnabled: true,
  aiOnlyAutoVerifyAllowed: false,
};

function flags(over: Partial<ScoreFlags> = {}): ScoreFlags {
  return {
    exactBarcodeEvidence: true,
    appVerifiedStrongEvidence: false,
    decodedAProduct: true,
    sourceTier: "authoritative",
    independentAgreement: false,
    usableName: true,
    hasBrandOrCategory: true,
    aiMatchesEvidence: true,
    priorShopConfirmation: false,
    priorCommunityConfirmation: false,
    conflictingNames: false,
    aiOnlyNoEvidence: false,
    vendorCodeNoAlias: false,
    weakGenericName: false,
    privateDataDetected: false,
    conflictsVerifiedCatalog: false,
    ...over,
  };
}

describe("scoreCatalogCandidate + decideAutoVerification", () => {
  it("Tier 1 exact barcode match = 100 and auto-verifies (trusted_source)", () => {
    expect(scoreCatalogCandidate(flags())).toBe(100);
    const d = decideAutoVerification(flags(), SETTINGS);
    expect(d.status).toBe("auto_verify");
    expect(d.verifiedBy).toBe("trusted_source");
    expect(d.score).toBe(100);
  });

  it("Tier 2 exact barcode match scores 90+ and auto-verifies", () => {
    const f = flags({ sourceTier: "strong_commercial" });
    expect(scoreCatalogCandidate(f)).toBeGreaterThanOrEqual(90);
    expect(decideAutoVerification(f, SETTINGS).status).toBe("auto_verify");
  });

  it("AI product with no app-evidence still auto-adds (trust the AI), as a pending catalog entry", () => {
    const f = flags({ exactBarcodeEvidence: false, sourceTier: "weak", aiOnlyNoEvidence: true });
    const d = decideAutoVerification(f, SETTINGS);
    expect(d.status).toBe("auto_verify");
    expect(d.verifiedBy).toBeNull(); // not exact-evidence -> catalog pending, but still counted
  });

  it("a no-usable-product decode goes to Needs Review", () => {
    const d = decideAutoVerification(flags({ usableName: false, decodedAProduct: false, exactBarcodeEvidence: false }), SETTINGS);
    expect(d.status).toBe("needs_review");
  });

  it("Tier-3 single-provider still auto-adds a usable product (score capped at 79, but trusted)", () => {
    const f = flags({ sourceTier: "supporting", independentAgreement: false });
    expect(scoreCatalogCandidate(f)).toBe(79); // score cap still applies (metadata only)
    expect(decideAutoVerification(f, SETTINGS).status).toBe("auto_verify"); // product is trusted + counted
  });

  it("Tier-3 WITH independent agreement can auto-verify", () => {
    const f = flags({ sourceTier: "supporting", independentAgreement: true });
    expect(decideAutoVerification(f, SETTINGS).status).toBe("auto_verify");
  });

  it("conflict with a verified catalog entry -> Needs Review regardless of score", () => {
    const d = decideAutoVerification(flags({ conflictsVerifiedCatalog: true }), SETTINGS);
    expect(d.status).toBe("needs_review");
    expect(d.blockingReasons).toContain("Conflicts with a verified catalog entry");
  });

  it("real blockers (conflict) cannot be bypassed by any threshold", () => {
    const lax: AutoVerifySettings = { ...SETTINGS, autoVerifyConfidenceThreshold: 70 };
    const f = flags({ conflictsVerifiedCatalog: true });
    expect(decideAutoVerification(f, lax).status).toBe("needs_review");
  });

  it("disabling trusted-source still auto-adds (verifiedBy evidence_score, not trusted_source)", () => {
    const noTrust: AutoVerifySettings = { ...SETTINGS, trustedSourceAutoVerifyEnabled: false };
    const f = flags({ sourceTier: "authoritative", independentAgreement: false });
    const d = decideAutoVerification(f, noTrust);
    expect(d.status).toBe("auto_verify");
    expect(d.verifiedBy).toBe("evidence_score");
  });

  it("learning OFF still counts a strong match but does not write the catalog (auto_count)", () => {
    const off: AutoVerifySettings = { ...SETTINGS, autoCatalogLearningEnabled: false };
    expect(decideAutoVerification(flags(), off).status).toBe("auto_count");
  });

  it("a junk/unusable name is blocked (no usable product)", () => {
    const d = decideAutoVerification(flags({ usableName: false, exactBarcodeEvidence: false }), SETTINGS);
    expect(d.status).toBe("needs_review");
    expect(d.blockingReasons).toContain("No usable product was returned by the decode");
  });

  it("exact evidence but NO usable name -> Needs Review with the explicit reason (never Verified Unknown)", () => {
    const d = decideAutoVerification(flags({ usableName: false, exactBarcodeEvidence: true, appVerifiedStrongEvidence: true }), SETTINGS);
    expect(d.status).toBe("needs_review");
    expect(d.blockingReasons).toContain("Exact barcode evidence was found, but no usable product identity was returned");
  });

  it("FAST PATH: app-verified strong evidence auto-verifies a Tier-3 single-provider result (not capped to 79)", () => {
    const f = flags({ sourceTier: "supporting", independentAgreement: false, appVerifiedStrongEvidence: true });
    expect(scoreCatalogCandidate(f)).toBeGreaterThanOrEqual(80); // Tier-3 cap skipped
    const d = decideAutoVerification(f, SETTINGS);
    expect(d.status).toBe("auto_verify");
  });

  it("the fast path still respects real blockers (conflict) even with app-verified evidence", () => {
    const d = decideAutoVerification(flags({ appVerifiedStrongEvidence: true, conflictsVerifiedCatalog: true }), SETTINGS);
    expect(d.status).toBe("needs_review");
  });
});
