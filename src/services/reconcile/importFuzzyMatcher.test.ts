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

  it("routes a sizeless row to review, never fuzzy (size is a hard gate)", () => {
    const result = matchImportFuzzy(
      row({ sizeText: "", specs: "", model: "Defender T H" }),
      [candidate()],
    );
    expect(result.status).toBe("review");
    expect(result.autoApprove).toBe(false);
  });
});
