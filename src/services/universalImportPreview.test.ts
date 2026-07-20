import { describe, expect, it } from "vitest";
import type { UniversalSheet } from "@/services/importSchema";
import {
  buildImportPreview,
  mapUniversalRows,
  type PreviewMatchResult,
} from "@/services/universalImportPreview";

const sheet: UniversalSheet = {
  fileName: "boss.csv",
  kind: "csv",
  headers: ["PN", "Make", "Model", "Tire Size", "QOH", "Cost"],
  rows: [
    ["ABC-1", "Acme", "Road", "225/45R18", "7", "99"],
    ["ABC-2", "Acme", "Road+", "225/45R18", "2", "88"],
    ["ABC-3", "Acme", "Road", "225/45R18", "bad", "77"],
  ],
  headerRowIndex: 0,
  sourceSignature: "source-1",
};

describe("universalImportPreview", () => {
  it("maps sanitized rows, excludes cost, and rejects an invalid quantity", () => {
    const result = mapUniversalRows(sheet, {
      partNumber: 0,
      brand: 1,
      model: 2,
      size: 3,
      quantity: 4,
    });
    expect(result.rows).toHaveLength(2);
    expect(result.rejected).toHaveLength(1);
    expect(result.rows[0].expected.raw.cost).toBeUndefined();
    expect(result.rows[0].quantity).toBe(7);
  });

  it("auto-applies only corroborated exact PN hits and routes token matches to fuzzy review", () => {
    const mapped = mapUniversalRows(sheet, {
      partNumber: 0,
      brand: 1,
      model: 2,
      size: 3,
      quantity: 4,
    });
    const matches: PreviewMatchResult[] = [
      {
        row: mapped.rows[0].expected,
        status: "matched",
        reason: "Part number hit for exact candidate.",
        confidence: 1,
        matchBasis: "part_number_exact",
        candidate: { uid: "uid-1", brand: "Acme", name: "Road" },
      },
      {
        row: mapped.rows[1].expected,
        status: "matched",
        reason: "Identity match on size and model name similarity.",
        confidence: 0.75,
        matchBasis: "identity_jaccard",
        candidate: { uid: "uid-2", brand: "Acme", name: "Road Plus" },
      },
    ];
    const preview = buildImportPreview(mapped, matches, "header");
    expect(preview).toMatchObject({ total: 3, exact: 1, fuzzy: 1, review: 0, reject: 1 });
    expect(preview.headline).toBe("Matched 1 of 3 automatically");
    expect(preview.rows[1].status).toBe("fuzzy");
  });

  it("keeps ambiguous and affix-core candidates out of automatic apply", () => {
    const mapped = mapUniversalRows({ ...sheet, rows: [sheet.rows[0]] }, {
      partNumber: 0,
      brand: 1,
      model: 2,
      size: 3,
      quantity: 4,
    });
    const ambiguous: PreviewMatchResult = {
      row: mapped.rows[0].expected,
      status: "ambiguous",
      reason: "Two candidates.",
      confidence: null,
      candidates: [
        { uid: "a", brand: "Acme", name: "Road" },
        { uid: "b", brand: "Acme", name: "Road" },
      ],
    };
    expect(buildImportPreview(mapped, [ambiguous], "header").rows[0].status).toBe("review");

    const affix: PreviewMatchResult = {
      row: mapped.rows[0].expected,
      status: "matched",
      reason: "Part number hit through affix core.",
      confidence: 1,
      matchBasis: "part_number_affix_core",
      candidate: { uid: "a", brand: "Acme", name: "Road" },
      viaAffixCore: true,
    };
    expect(buildImportPreview(mapped, [affix], "header").rows[0].status).toBe("fuzzy");
  });
});
