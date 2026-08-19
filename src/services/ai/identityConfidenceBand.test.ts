import { describe, it, expect } from "vitest";
import { getIdentityConfidenceBand, identityBandLabel, identityBandWord } from "@/services/ai/identityConfidenceBand";

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
