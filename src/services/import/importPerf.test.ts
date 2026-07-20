// src/services/import/importPerf.test.ts
// Task 11 (Phase 4 Stage A ship gate), AC4: the FULL Stage A shaping chain over a 5000-data-row
// matrix must complete in under 10 seconds with no network. This closes C7 from the earlier draft,
// which only timed inferColumnMapping - here the chain is inferColumnMapping -> mapUniversalRows ->
// buildImportPreview, exactly the sequence UniversalImportPanel.previewWith runs (see
// src/components/UniversalImportPanel.tsx), with a synthetic no-match result per row (no corpus/
// network call) standing in for the real /api/reconcile/match response.
import { describe, expect, it } from "vitest";
import { inferColumnMapping } from "@/services/columnIntelligence";
import { buildSourceSignature, type UniversalSheet } from "@/services/importSchema";
import { buildImportPreview, mapUniversalRows, type PreviewMatchResult } from "@/services/universalImportPreview";

const ROW_COUNT = 5000;

function buildMatrix(): { headers: string[]; rows: string[][] } {
  const headers = ["Part Number", "Brand", "Description", "Size", "Qty"];
  const rows: string[][] = [];
  for (let i = 0; i < ROW_COUNT; i += 1) {
    rows.push([`PN-${i}`, "Acme", `Widget ${i}`, "", String((i % 50) + 1)]);
  }
  return { headers, rows };
}

describe("Phase 4 Stage A perf (AC4)", () => {
  it("shapes 5000 rows end to end (infer -> map -> preview) in under 10 seconds", () => {
    const { headers, rows } = buildMatrix();
    const start = Date.now();

    const inference = inferColumnMapping([headers, ...rows]);
    expect(inference.mapping.partNumber).toBeGreaterThanOrEqual(0);
    expect(inference.mapping.quantity).toBeGreaterThanOrEqual(0);

    const sheet: UniversalSheet = {
      fileName: "perf.csv",
      kind: "csv",
      headers,
      rows,
      headerRowIndex: 0,
      sourceSignature: buildSourceSignature(headers),
    };

    const mapped = mapUniversalRows(sheet, inference.mapping);
    expect(mapped.rows.length).toBe(ROW_COUNT);

    // Synthetic no-match result per mapped row: buildImportPreview requires exactly one match per
    // mapped.rows entry (it throws otherwise - see universalImportPreview.ts), and this test proves
    // shaping-chain performance only, not corpus matching (that is proven live in the e2e spec).
    const matches: PreviewMatchResult[] = mapped.rows.map((row) => ({
      row: row.expected,
      status: "unmatched",
      reason: "perf test: no corpus lookup performed",
    }));

    const preview = buildImportPreview(mapped, matches, inference.source);
    expect(preview.total).toBe(ROW_COUNT);

    const elapsedMs = Date.now() - start;
    expect(elapsedMs).toBeLessThan(10_000);
  });
});
