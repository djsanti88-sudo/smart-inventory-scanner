import { describe, it, expect } from "vitest";
import { decodeCorroborated } from "./scanStore";

describe("decodeCorroborated - what counts as corroboration for auto-count", () => {
  it("true for app-verified exact code", () => {
    expect(decodeCorroborated({ exactCodeEvidenceVerifiedByApp: true } as any)).toBe(true);
  });
  it("true for the internet two-source size path WITHOUT exact-code", () => {
    expect(decodeCorroborated({ exactCodeEvidenceVerifiedByApp: false, corroborationPath: "internet_two_source_size" } as any)).toBe(true);
  });
  it("false for a bare suggested decode with neither", () => {
    expect(decodeCorroborated({ exactCodeEvidenceVerifiedByApp: false } as any)).toBe(false);
  });
  it("false for other corroboration paths without exact code", () => {
    expect(decodeCorroborated({ exactCodeEvidenceVerifiedByApp: false, corroborationPath: "two_ai_agreement" } as any)).toBe(false);
  });
});
