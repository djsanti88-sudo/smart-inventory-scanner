// src/components/UniversalImportPanel.fixtures.test.tsx
// @vitest-environment jsdom
//
// STRESS WAVE 2, Item 3: on the DEPLOYED preview, importing clean.csv (exact headers, sidecar says
// confidence high -> straight to preview) and semicolon.csv (';' delimiter with a quoted comma field)
// both ended with NEITHER the preview NOR the column-mapping UI visible and an empty error string.
// This suite drives the REAL byte-for-byte fixtures through the REAL parse (readUniversalFile) +
// REAL mapping intelligence (inferColumnMapping) + the REAL panel component end to end (only the
// network callbacks - loadMapping/matchRows - are mocked, per the test-safety rule), to determine
// whether the failure reproduces locally or was a deployment-lane condition.
//
// VERDICT (2026-07-20): does NOT reproduce locally - both fixtures parse, auto-map HIGH, and reach
// the preview. These tests pin that end-to-end contract; the deployed symptom is consistent with the
// lane's own 20s waitForSelector timeout racing a cold /api/reconcile/match round-trip (see
// wave2-report.md), not a parse/mapping defect.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { UniversalImportPanel } from "@/components/UniversalImportPanel";
import { readUniversalFile } from "@/services/universalFileReader";
import { inferColumnMapping } from "@/services/columnIntelligence";
import type { UploadFileLike } from "@/services/importSchema";

afterEach(() => {
  cleanup();
});

// Keep these bytes with the test instead of under an ignored workflow directory.
// That makes this regression suite reproducible in a fresh checkout and in CI.
const FIXTURES = path.join(__dirname, "fixtures");

function fixtureFile(name: string): UploadFileLike & File {
  const content = fs.readFileSync(path.join(FIXTURES, name), "utf8");
  const bytes = new TextEncoder().encode(content);
  const file = new File([bytes], name, { type: "text/csv" });
  // jsdom's File may lack text/arrayBuffer in older versions - provide them explicitly so the REAL
  // readUniversalFile code path runs unchanged.
  if (typeof file.text !== "function") {
    Object.defineProperty(file, "text", { value: async () => content });
  }
  if (typeof file.arrayBuffer !== "function") {
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
  }
  return file as UploadFileLike & File;
}

function panelProps() {
  return {
    loadMapping: vi.fn().mockResolvedValue(null),
    saveMapping: vi.fn().mockResolvedValue(undefined),
    matchRows: vi.fn().mockImplementation(async (rows: Array<{ expected: unknown }>) =>
      rows.map((row) => ({
        row: row.expected,
        status: "matched",
        matchBasis: "part_number_exact",
        reason: "Exact part number match.",
        confidence: 1,
      })),
    ),
    onApply: vi.fn().mockResolvedValue({ applied: 30, queuedForReview: 0, rejected: 0 }),
  };
}

describe("stress fixtures: parse + mapping decision (service layer, real files)", () => {
  it("clean.csv parses to 5 exact headers + 30 rows and infers an all-HIGH mapping (auto-preview path)", async () => {
    const sheet = await readUniversalFile(fixtureFile("clean.csv"));
    expect(sheet.kind).toBe("csv");
    expect(sheet.headers).toEqual(["Name", "Brand", "Part Number", "Barcode", "Quantity"]);
    expect(sheet.rows).toHaveLength(30);
    const inferred = inferColumnMapping([sheet.headers, ...sheet.rows]);
    expect(inferred.confidence).toBe("high");
    expect(inferred.mapping).toMatchObject({ name: 0, brand: 1, partNumber: 2, barcode: 3, quantity: 4 });
    const allHigh = Object.values(inferred.tiers).every((tier) => tier === "high");
    expect(allHigh, "every mapped column HIGH -> the panel auto-applies and goes straight to preview").toBe(true);
  });

  it("semicolon.csv detects the ';' delimiter and preserves the quoted comma field unsplit", async () => {
    const sheet = await readUniversalFile(fixtureFile("semicolon.csv"));
    expect(sheet.kind).toBe("csv");
    expect(sheet.headers).toEqual(["Name", "Brand", "Part Number", "Barcode", "Quantity"]);
    expect(sheet.rows).toHaveLength(30);
    // The quoted field "Premier LTX 225/65R17, All-Season" must stay ONE cell (comma preserved).
    expect(sheet.rows[0][0]).toBe("Premier LTX 225/65R17, All-Season");
    expect(sheet.rows[0]).toHaveLength(5);
    const inferred = inferColumnMapping([sheet.headers, ...sheet.rows]);
    expect(inferred.confidence).toBe("high");
    const allHigh = Object.values(inferred.tiers).every((tier) => tier === "high");
    expect(allHigh).toBe(true);
  });
});

describe("stress fixtures: full panel flow (real parse + real inference, mocked network)", () => {
  for (const fixture of ["clean.csv", "semicolon.csv"]) {
    it(`${fixture}: upload goes STRAIGHT to the preview (no mapping-confirm step, no error, nothing applied)`, async () => {
      const handlers = panelProps();
      render(<UniversalImportPanel {...handlers} />);
      fireEvent.change(screen.getByTestId("universal-import-file"), {
        target: { files: [fixtureFile(fixture)] },
      });
      const headline = await screen.findByTestId("import-headline");
      expect(headline).toHaveTextContent("Matched 30 of 30 automatically");
      // The exact deployed-lane symptom must NOT exist locally: preview IS visible, mapping UI is NOT.
      expect(screen.getByTestId("import-preview")).toBeTruthy();
      expect(screen.queryByTestId("column-mapping")).toBeNull();
      expect(screen.queryByTestId("import-error")).toBeNull();
      expect(handlers.onApply).not.toHaveBeenCalled();
      expect(handlers.saveMapping).not.toHaveBeenCalled();
      expect(handlers.matchRows).toHaveBeenCalledTimes(1);
      expect(handlers.matchRows.mock.calls[0][0]).toHaveLength(30);
    });
  }

  it("a matchRows failure surfaces a VISIBLE error (never an empty silent dead-end)", async () => {
    // Regression guard for the observed deployed symptom class: if the match call fails, the user
    // must see an honest error - never a blank panel with no preview, no mapping UI, and no message.
    const handlers = { ...panelProps(), matchRows: vi.fn().mockRejectedValue(new Error("Could not match the uploaded rows.")) };
    render(<UniversalImportPanel {...handlers} />);
    fireEvent.change(screen.getByTestId("universal-import-file"), {
      target: { files: [fixtureFile("clean.csv")] },
    });
    const error = await screen.findByTestId("import-error");
    expect(error).toHaveTextContent("Could not match the uploaded rows.");
    expect(screen.queryByTestId("import-preview")).toBeNull();
  });

  it("a matchRows failure with an EMPTY error message still shows a visible fallback error (empty-string dead-end fixed)", async () => {
    // The deployed lane recorded error="" - an Error with an empty message previously rendered
    // NOTHING ({error && ...} is falsy for ""), leaving the exact silent dead-end observed.
    const handlers = { ...panelProps(), matchRows: vi.fn().mockRejectedValue(new Error("")) };
    render(<UniversalImportPanel {...handlers} />);
    fireEvent.change(screen.getByTestId("universal-import-file"), {
      target: { files: [fixtureFile("clean.csv")] },
    });
    const error = await screen.findByTestId("import-error");
    expect(error.textContent ?? "").not.toBe("");
    expect(screen.queryByTestId("import-preview")).toBeNull();
  });
});
