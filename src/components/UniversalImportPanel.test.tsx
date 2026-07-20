// src/components/UniversalImportPanel.test.tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UniversalImportPanel } from "@/components/UniversalImportPanel";
import type { UniversalSheet } from "@/services/importSchema";

afterEach(() => {
  cleanup();
});

const nonsenseSheet: UniversalSheet = {
  fileName: "nonsense.csv",
  kind: "csv",
  headers: ["Alpha", "Beta", "Gamma", "Delta", "Echo"],
  rows: [["ABC-1", "Acme", "Road", "225/45R18", "7"]],
  headerRowIndex: 0,
  sourceSignature: "source-nonsense",
};

function props() {
  return {
    readFile: vi.fn().mockResolvedValue(nonsenseSheet),
    loadMapping: vi.fn().mockResolvedValue(null),
    saveMapping: vi.fn().mockResolvedValue(undefined),
    // CORRECTION 1 (plan-reviewer, C2 fallout): the committed classifier's statusForMatch never
    // promotes an "unmatched" MatchResult to "exact" - it routes to "review". To prove a nonzero
    // "Matched N of M automatically" headline, the mock must return a genuinely matched row: status
    // "matched" with matchBasis "part_number_exact" (the only basis statusForMatch maps to "exact").
    matchRows: vi.fn().mockImplementation(async (rows) => rows.map((row: { expected: unknown }) => ({
      row: row.expected,
      status: "matched",
      matchBasis: "part_number_exact",
      reason: "Exact part number match.",
      confidence: 1,
    }))),
    onApply: vi.fn().mockResolvedValue({ applied: 1, queuedForReview: 0, rejected: 0 }),
  };
}

describe("UniversalImportPanel", () => {
  it("shows actual headers and sample values for a low-confidence file without applying anything", async () => {
    const handlers = props();
    render(<UniversalImportPanel {...handlers} />);
    fireEvent.change(screen.getByTestId("universal-import-file"), { target: { files: [new File(["x"], "nonsense.csv")] } });
    expect(await screen.findByTestId("column-mapping")).toHaveTextContent("Alpha");
    expect(screen.getByTestId("column-mapping")).toHaveTextContent("ABC-1");
    expect(handlers.onApply).not.toHaveBeenCalled();
    expect(handlers.saveMapping).not.toHaveBeenCalled();
    expect(screen.getByTestId("import-error")).toHaveAttribute("role", "alert");
  });

  it("previews after manual mapping and writes only after Apply", async () => {
    const handlers = props();
    render(<UniversalImportPanel {...handlers} />);
    fireEvent.change(screen.getByTestId("universal-import-file"), { target: { files: [new File(["x"], "nonsense.csv")] } });
    await screen.findByTestId("column-mapping");
    fireEvent.change(screen.getByLabelText("Part number column"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("Brand column"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Model column"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Size column"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("Quantity column"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview mapped file" }));
    expect(await screen.findByTestId("import-headline")).toHaveTextContent("Matched 1 of 1 automatically");
    expect(handlers.onApply).not.toHaveBeenCalled();
    expect(handlers.saveMapping).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply 1 rows" }));
    await waitFor(() => expect(handlers.onApply).toHaveBeenCalledTimes(1));
    expect(handlers.saveMapping).toHaveBeenCalledWith("source-nonsense", {
      partNumber: 0,
      brand: 1,
      model: 2,
      size: 3,
      quantity: 4,
    });
    expect(await screen.findByTestId("import-summary")).toHaveAttribute("aria-live", "polite");
  });
});
