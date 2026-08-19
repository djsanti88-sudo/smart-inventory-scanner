import { describe, it, expect } from "vitest";
import { getIdentityConfidenceBand, getReviewIdentityBand, identityBandLabel, identityBandWord } from "@/services/ai/identityConfidenceBand";
import { sanitizeReview } from "@/services/security/serializers";
import type { UnknownCodeReview } from "@/types";

// The band is the ONLY confidence the product shows (owner decision 2026-08-19). It is derived from the
// app's own evidence, never from a provider's self-reported percentage, so these cases pin the trust
// line: app-verified evidence is the only way to reach "high".

describe("getIdentityConfidenceBand", () => {
  it("app-verified exact code is high", () => {
    expect(getIdentityConfidenceBand({ status: "suggested", confidence: 0.4, exactCodeEvidenceVerifiedByApp: true })).toBe("high");
  });

  it("a decode the app settled as verified is high", () => {
    expect(getIdentityConfidenceBand({ status: "verified", confidence: 0.9, exactCodeEvidenceVerifiedByApp: false })).toBe("high");
  });

  it("a suggestion at or above the auto-apply threshold (0.8) is medium, never high", () => {
    expect(getIdentityConfidenceBand({ status: "suggested", confidence: 0.8 })).toBe("medium");
    expect(getIdentityConfidenceBand({ status: "suggested", confidence: 0.99 })).toBe("medium");
  });

  it("a suggestion backed by a source the app actually fetched is medium even at low confidence", () => {
    expect(getIdentityConfidenceBand({ status: "suggested", confidence: 0.3, evidenceStrength: "fetched_source" })).toBe("medium");
  });

  it("a weak or evidence-less guess is low", () => {
    expect(getIdentityConfidenceBand({ status: "suggested", confidence: 0.3, evidenceStrength: "url_only" })).toBe("low");
    expect(getIdentityConfidenceBand({ status: "needs_review", confidence: 0 })).toBe("low");
    expect(getIdentityConfidenceBand(null)).toBe("low");
    expect(getIdentityConfidenceBand(undefined)).toBe("low");
  });

  it("labels a suggestion with the band, never a percentage", () => {
    expect(identityBandLabel("medium")).toBe("Suggested - medium confidence");
    expect(identityBandLabel("low")).not.toMatch(/%|\d/);
  });
});

describe("identityBandWord", () => {
  it("renders the band alone for a Confidence column, never a percentage", () => {
    expect(identityBandWord("high")).toBe("High");
    expect(identityBandWord("medium")).toBe("Medium");
    expect(identityBandWord("low")).toBe("Low");
  });
});

describe("getReviewIdentityBand", () => {
  const review = {
    decodeStatus: "suggested", confidence: 0.85, evidenceStrength: "none", exactCodeEvidenceVerifiedByApp: false,
    hasSuggestion: true, suggestedProductName: "Chandelle Sabor Chocolate", cleanCode: "005761392531", status: "resolved",
  } as unknown as UnknownCodeReview;

  it("bands a live review from its decode fields (same rule as the decision)", () => {
    expect(getReviewIdentityBand(review)).toBe("medium");
    expect(getReviewIdentityBand({ ...review, decodeStatus: "verified" })).toBe("high");
    expect(getReviewIdentityBand({ ...review, confidence: 0.3 })).toBe("low");
  });

  it("keeps the SAME band after the customer-safe persist strips confidence/evidence (deep-review finding 2026-08-19)", () => {
    const persisted = sanitizeReview(review as unknown as Record<string, unknown>, "business") as unknown as UnknownCodeReview;
    expect((persisted as unknown as Record<string, unknown>).confidence, "raw confidence never reaches a customer's disk").toBeUndefined();
    expect(getReviewIdentityBand(persisted), "the displayed band survives the reload").toBe("medium");
  });
});
