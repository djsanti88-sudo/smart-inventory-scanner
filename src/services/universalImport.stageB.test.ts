import { describe, expect, it } from "vitest";
import { matchImportFuzzy } from "@/services/reconcile/importFuzzyMatcher";
import type { CorpusCandidate } from "@/services/reconcile/identityMatcher";
import type { ExpectedInventoryRow } from "@/services/reconcile/types";

const candidates: CorpusCandidate[] = [
  { uid: "one", brand: "Michelin", name: "Defender T H", sizeToken: "225/65R17" },
  { uid: "two", brand: "Acme", name: "Road Sport", sizeToken: "225/45R18" },
  { uid: "three", brand: "Acme", name: "Road Sports", sizeToken: "225/45R18" },
];

function imported(overrides: Partial<ExpectedInventoryRow>): ExpectedInventoryRow {
  return { externalId: "row", partNumbers: [], qty: 1, raw: {}, ...overrides };
}

describe("Stage B fixture outcomes", () => {
  it.each([
    {
      name: "typo brand and model",
      row: imported({ brand: "Micheln", model: "Defendr T H", sizeText: "225-65-17" }),
      expected: "fuzzy",
    },
    {
      name: "equivalent size notation",
      row: imported({ brand: "Michelin", model: "Defender T H", sizeText: "225 65 17" }),
      expected: "fuzzy",
    },
    {
      name: "near duplicate candidates",
      row: imported({ brand: "Acme", model: "Road Sport", sizeText: "225/45R18" }),
      expected: "ambiguous",
    },
    {
      name: "nonsense identity",
      row: imported({ brand: "Unknown", model: "Nothing Similar", sizeText: "225/45R18" }),
      expected: "review",
    },
  ])("classifies $name conservatively", ({ row, expected }) => {
    const result = matchImportFuzzy(row, candidates);
    expect(result.status).toBe(expected);
    expect(result.autoApprove).toBe(false);
  });
});
