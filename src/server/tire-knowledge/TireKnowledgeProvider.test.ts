import { describe, it, expect, beforeEach, vi } from "vitest";

// RC4 (owner-ratified pilot PN recall rule): "if only the distributor affix differs and the digits
// are identical, approve" - a part-number match is high-trust identity. resolveExactPartNumber used
// to return confidence 0.6 unconditionally; it must now grade the tier by WHICH candidate key hit:
// 0.85 when the plain (unaffixed) key hit, 0.8 when only the affix-core variant hit. Status must stay
// "suggested" and exactCodeEvidenceVerifiedByApp must stay false in both cases - a PN match never
// mints "verified" or an alias (no barcode evidence). The >=0.8 auto-apply-suggestion gate elsewhere
// (scanGates.ts) is what turns a high-confidence suggestion into a displayed, approve/decline row -
// this module only ever returns an honest suggestion.

const mockLookupByExactPartNumber = vi.fn();
vi.mock("@/server/tire-knowledge/tireKnowledgeIndex", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/tire-knowledge/tireKnowledgeIndex")>();
  return { ...actual, lookupByExactPartNumber: (pn: string) => mockLookupByExactPartNumber(pn) };
});

import { resolveExactPartNumber } from "@/server/tire-knowledge/TireKnowledgeProvider";

const CORPUS_ROW = {
  canonical_product_uid: "uid-1",
  brand: "hankook",
  brand_normalized: "hankook",
  model: "Dynapro",
  model_normalized: "dynapro",
  size: "265/70R17",
  raw_size_text: "P265/70R17",
  load_index: "113",
  speed_rating: "S",
  load_range: "SL",
  type: "all_season",
  season: "all_season",
  manufacturer_part_number: "2265992",
  barcode: "029142869880",
  barcode_type: "upc_a",
  confidence: "verified_2src",
  current_status: "active",
  usable_for: "sale",
  field_completeness_score: "1.0",
  missing_fields: "",
  source_count: 2,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveExactPartNumber - confidence tiers (RC4)", () => {
  it("returns null on a corpus miss", async () => {
    mockLookupByExactPartNumber.mockResolvedValueOnce(null);
    const result = await resolveExactPartNumber("BH4120176");
    expect(result).toBeNull();
  });

  it("plain (unaffixed) PN match: confidence 0.85, status suggested, exactCodeEvidenceVerifiedByApp false", async () => {
    mockLookupByExactPartNumber.mockResolvedValueOnce(CORPUS_ROW);
    const result = await resolveExactPartNumber("2265992");

    expect(result).not.toBeNull();
    expect(result!.decision.status).toBe("suggested");
    expect(result!.decision.confidence).toBe(0.85);
    expect(result!.decision.exactCodeEvidenceVerifiedByApp).toBe(false);
  });

  it("distributor-affix PN match (e.g. KH2265992): confidence 0.8, status suggested, exactCodeEvidenceVerifiedByApp false", async () => {
    mockLookupByExactPartNumber.mockResolvedValueOnce(CORPUS_ROW);
    const result = await resolveExactPartNumber("KH2265992");

    expect(result).not.toBeNull();
    expect(result!.decision.status).toBe("suggested");
    expect(result!.decision.confidence).toBe(0.8);
    expect(result!.decision.exactCodeEvidenceVerifiedByApp).toBe(false);
  });

  it("never returns status verified, regardless of tier", async () => {
    mockLookupByExactPartNumber.mockResolvedValueOnce(CORPUS_ROW);
    const plain = await resolveExactPartNumber("2265992");
    mockLookupByExactPartNumber.mockResolvedValueOnce(CORPUS_ROW);
    const affixed = await resolveExactPartNumber("F-2265992");

    expect(plain!.decision.status).not.toBe("verified");
    expect(affixed!.decision.status).not.toBe("verified");
  });

  it("reason text is honest and customer-safe: no internal rung/module names leaked", async () => {
    mockLookupByExactPartNumber.mockResolvedValueOnce(CORPUS_ROW);
    const result = await resolveExactPartNumber("KH2265992");

    const reason = result!.decision.reason.toLowerCase();
    expect(reason).toContain("part number");
    expect(reason).not.toMatch(/rung|ladder|tirekn|gpt|goupc|fetchv2/i);
  });

  it("distributor-affix reason mentions the prefix was stripped", async () => {
    mockLookupByExactPartNumber.mockResolvedValueOnce(CORPUS_ROW);
    const result = await resolveExactPartNumber("KH2265992");
    expect(result!.decision.reason.toLowerCase()).toContain("prefix");
  });
});
