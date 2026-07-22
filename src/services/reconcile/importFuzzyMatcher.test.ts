// src/services/reconcile/importFuzzyMatcher.test.ts
import { describe, expect, it } from "vitest";
import { matchImportFuzzy } from "@/services/reconcile/importFuzzyMatcher";
import type { CorpusCandidate } from "@/services/reconcile/identityMatcher";
import type { ExpectedInventoryRow } from "@/services/reconcile/types";

function row(overrides: Partial<ExpectedInventoryRow> = {}): ExpectedInventoryRow {
  return {
    externalId: "row-1",
    partNumbers: [],
    brand: "Micheln",
    model: "Defendr T H",
    sizeText: "225-65-17",
    qty: 4,
    raw: {},
    ...overrides,
  };
}

function candidate(overrides: Partial<CorpusCandidate> = {}): CorpusCandidate {
  return {
    uid: "candidate-1",
    brand: "Michelin",
    name: "Defender T H",
    sizeToken: "225/65R17",
    ...overrides,
  };
}

describe("matchImportFuzzy", () => {
  it("finds a unique typo candidate but never auto-approves it", () => {
    const result = matchImportFuzzy(row(), [candidate()]);
    expect(result.status).toBe("fuzzy");
    expect(result.confidence).toBeGreaterThanOrEqual(0.75);
    expect(result.autoApprove).toBe(false);
  });

  it("normalizes tire notation and rejects a size mismatch", () => {
    expect(matchImportFuzzy(row(), [candidate()]).status).toBe("fuzzy");
    expect(matchImportFuzzy(row(), [candidate({ sizeToken: "235/65R17" })]).status).toBe("review");
  });

  it("routes below-threshold results to review", () => {
    const result = matchImportFuzzy(
      row({ brand: "Unknown", model: "Completely Different" }),
      [candidate()],
    );
    expect(result.status).toBe("review");
    expect(result.autoApprove).toBe(false);
  });

  it("returns ambiguous for two qualifying candidates", () => {
    const result = matchImportFuzzy(row(), [
      candidate({ uid: "one" }),
      candidate({ uid: "two", name: "Defender TH" }),
    ]);
    expect(result.status).toBe("ambiguous");
    expect(result.candidates).toHaveLength(2);
    expect(result.autoApprove).toBe(false);
  });

  it("vetoes a genuine plus-generation pair (R8 vs R8+) to review, never a match", () => {
    // nameTokens keeps the trailing "+", so plusGenerationDiff fires and the candidate is
    // dropped - nothing qualifies -> review. Exercises the real veto, not a below-threshold miss.
    const result = matchImportFuzzy(
      row({ brand: "Acme", model: "Grabber R8" }),
      [candidate({ brand: "Acme", name: "Grabber R8+" })],
    );
    expect(result.status).toBe("review");
    expect(result.autoApprove).toBe(false);
  });

  it("routes a distinct look-alike brand to review, never fuzzy", () => {
    // Different real brands that merely look similar must NOT bridge via edit distance:
    // "Kelso" vs "Kelly" (~0.6) is below FUZZY_BRAND_MIN even though the model matches exactly.
    const result = matchImportFuzzy(
      row({ brand: "Kelso", model: "Defender T H", sizeText: "225/65R17" }),
      [candidate({ brand: "Kelly", name: "Defender T H" })],
    );
    expect(result.status).toBe("review");
    expect(result.autoApprove).toBe(false);
  });

  it("routes a sizeless row to review, never fuzzy (size is a hard gate) when the CANDIDATE has a tire size", () => {
    // Candidate carries a real tire size; the row has none -> one-sided size, conservative no-match.
    const result = matchImportFuzzy(
      row({ sizeText: "", specs: "", model: "Defender T H" }),
      [candidate()],
    );
    expect(result.status).toBe("review");
    expect(result.autoApprove).toBe(false);
  });

  // ---- IMPROVEMENT 1: prefix-aware name tokens ----
  describe("prefix-aware name tokens (Improvement 1)", () => {
    it("1a: 'Def LTX' vs 'Defender LTX' (same brand + same size) surfaces as fuzzy", () => {
      const result = matchImportFuzzy(
        row({ brand: "Michelin", model: "Def LTX", sizeText: "265/70R17" }),
        [candidate({ brand: "Michelin", name: "Defender LTX", sizeToken: "265/70R17" })],
      );
      expect(result.status).toBe("fuzzy");
      expect(result.confidence).toBeGreaterThanOrEqual(0.75);
      expect(result.autoApprove).toBe(false);
    });

    it("1b: 'Wrangler' vs 'Wrangler AT' (same brand + same size) surfaces as fuzzy", () => {
      const result = matchImportFuzzy(
        row({ brand: "Goodyear", model: "Wrangler", sizeText: "265/70R17" }),
        [candidate({ brand: "Goodyear", name: "Wrangler AT", sizeToken: "265/70R17" })],
      );
      expect(result.status).toBe("fuzzy");
      expect(result.autoApprove).toBe(false);
    });

    it("1c: a 2-char token is NOT treated as a prefix match (no junk bridging)", () => {
      // "AT LTX" vs "Attitude Terrain LTX": only "ltx" is a real shared token; "at" (2 chars) must
      // NOT count as a prefix of "attitude" or "terrain". Jaccard stays low -> review, not fuzzy.
      const result = matchImportFuzzy(
        row({ brand: "Michelin", model: "AT LTX", sizeText: "265/70R17" }),
        [candidate({ brand: "Michelin", name: "Attitude Terrain LTX", sizeToken: "265/70R17" })],
      );
      expect(result.status).toBe("review");
      expect(result.autoApprove).toBe(false);
    });
  });

  // ---- IMPROVEMENT 2: non-tire fuzzy ----
  describe("non-tire fuzzy matching (Improvement 2)", () => {
    function retailRow(over: Partial<ExpectedInventoryRow> = {}): ExpectedInventoryRow {
      return {
        externalId: "r-1",
        partNumbers: [],
        brand: "Duracell",
        model: "AA 8ct",
        sizeText: "",
        qty: 1,
        raw: {},
        ...over,
      };
    }
    function retailCand(over: Partial<CorpusCandidate> = {}): CorpusCandidate {
      return { uid: "rc-1", brand: "Duracell", name: "AA 8 count", ...over };
    }

    it("2a: 'Duracell AA 8ct' vs 'Duracell AA 8 count' (same product, size agrees) -> fuzzy, review-only", () => {
      const result = matchImportFuzzy(retailRow(), [retailCand()]);
      expect(result.status).toBe("fuzzy");
      expect(result.autoApprove).toBe(false);
    });

    it("2b: different generic size 'Coca-Cola 12oz' vs 'Coca-Cola 20oz' -> NO match (size-distinct)", () => {
      const result = matchImportFuzzy(
        retailRow({ brand: "Coca-Cola", model: "Classic 12oz" }),
        [retailCand({ brand: "Coca-Cola", name: "Classic 20oz" })],
      );
      expect(result.status).toBe("review");
      expect(result.autoApprove).toBe(false);
    });

    it("2b': different pack count 'Bounty 6pk' vs 'Bounty 12pk' -> NO match (size-distinct)", () => {
      const result = matchImportFuzzy(
        retailRow({ brand: "Bounty", model: "Paper Towels 6pk" }),
        [retailCand({ brand: "Bounty", name: "Paper Towels 12pk" })],
      );
      expect(result.status).toBe("review");
    });

    it("2c: brand typo 'Duracel' vs 'Duracell' (same name+size) -> fuzzy", () => {
      const result = matchImportFuzzy(
        retailRow({ brand: "Duracel", model: "AA 8ct" }),
        [retailCand({ brand: "Duracell", name: "AA 8ct" })],
      );
      expect(result.status).toBe("fuzzy");
      expect(result.autoApprove).toBe(false);
    });

    it("2d: two genuinely different non-tire products (different brand AND name) -> no match", () => {
      const result = matchImportFuzzy(
        retailRow({ brand: "Energizer", model: "Max AAA 4ct" }),
        [retailCand({ brand: "Duracell", name: "Coppertop AA 8ct" })],
      );
      expect(result.status).toBe("review");
      expect(result.autoApprove).toBe(false);
    });

    it("2e: one side has a size token, the other has none -> conservative no match", () => {
      const result = matchImportFuzzy(
        retailRow({ brand: "Duracell", model: "AA 8ct" }),
        [retailCand({ brand: "Duracell", name: "AA Batteries" })],
      );
      expect(result.status).toBe("review");
    });

    it("2f: SAME brand+size but a DISCRIMINATING model token differs -> NOT a confident fuzzy match", () => {
      // Safety property 2: 'Coppertop AA 8ct' vs 'Rechargeable AA 8ct' agree on brand and size but the
      // model word differs; the discriminating token must keep this out of a single confident fuzzy.
      const result = matchImportFuzzy(
        retailRow({ brand: "Duracell", model: "Coppertop AA 8ct" }),
        [retailCand({ brand: "Duracell", name: "Rechargeable AA 8ct" })],
      );
      expect(result.status).toBe("review");
      expect(result.autoApprove).toBe(false);
    });
  });
});
