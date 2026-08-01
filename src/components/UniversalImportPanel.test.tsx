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

// Foreign headers: 'Mfr Code' (fuzzy -> partNumber HIGH once corroborated) but 'Qty On Hand'
// resolves quantity, and a MEDIUM guess is present. This sheet exercises the tiered mapping UI.
const foreignSheet: UniversalSheet = {
  fileName: "foreign.csv",
  kind: "csv",
  // 'Mfr Code' -> partNumber (HIGH: fuzzy header + SKU-shaped values agree). 'Qty On Hand' -> quantity
  // (exact synonym, HIGH). 'Brnd' -> brand (MEDIUM: a header typo close to "brand" by edit similarity;
  // plain-word values give no corroborating content shape), which forces the tiered confirm UI.
  headers: ["Mfr Code", "Brnd", "Qty On Hand"],
  rows: [
    ["MT-2657017", "acme", "7"],
    ["DEF-LTX-01", "acme", "8"],
  ],
  headerRowIndex: 0,
  sourceSignature: "source-foreign",
};

function signedChunks(tokens = ["chunk-a", "chunk-b"]) {
  return tokens.map((token, chunkIndex) => JSON.stringify({
    manifestVersion: "identity-preview-v1", chunkIndex, chunkCount: tokens.length,
    sanitizedContentRootHash: "root-a", importId: "import-a", previewFingerprint: "preview-a",
    signature: token,
  }));
}

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
  it("uses every workbook sheet and retains every signed preview chunk in local identity mode", async () => {
    const handlers = props();
    const secondSheet: UniversalSheet = { ...nonsenseSheet, importedSheetName: "Second", sourceSignature: "source-second" };
    const previewIdentity = vi.fn().mockResolvedValue({
      preview: { decisions: [
        { kind: "automatic" }, { kind: "review" }, { kind: "abstain" }, { kind: "non_product" }, { kind: "invalid" },
      ] },
      signedPayloads: signedChunks(),
    });
    const localProps = {
      ...handlers,
      localIdentity: { enabled: true, role: "counter", mode: "physical_count" as const, readWorkbook: vi.fn().mockResolvedValue([nonsenseSheet, secondSheet]), previewIdentity },
    };
    render(<UniversalImportPanel {...localProps} />);
    fireEvent.change(screen.getByTestId("universal-import-file"), { target: { files: [new File(["x"], "book.xlsx")] } });

    expect(await screen.findByTestId("identity-preview")).toHaveTextContent("2 sheets");
    expect(screen.getByTestId("identity-preview")).toHaveTextContent("automatic 1");
    expect(screen.getByTestId("identity-preview")).toHaveTextContent("review 1");
    expect(screen.queryByTestId("import-apply")).not.toBeInTheDocument();
    expect(handlers.matchRows).not.toHaveBeenCalled();
    expect(previewIdentity).toHaveBeenCalledWith(expect.objectContaining({ sheets: [nonsenseSheet, secondSheet] }));
  });

  it("submits the complete ordered signed payload set for an authorized local identity apply", async () => {
    const handlers = props();
    const chunks = signedChunks();
    const applyIdentity = vi.fn().mockResolvedValue({ importId: "import-a", mode: "physical_count", countedRows: 2, countQuantity: 3, rows: [{ rowId: "r1", status: "counted" }, { rowId: "r2", status: "not_counted" }] });
    const localProps = {
      ...handlers,
      localIdentity: {
        enabled: true, role: "admin", mode: "physical_count" as const, readWorkbook: vi.fn().mockResolvedValue([nonsenseSheet]),
        previewIdentity: vi.fn().mockResolvedValue({ preview: { decisions: [{ kind: "automatic" }, { kind: "review" }] }, signedPayloads: chunks }),
        applyIdentity,
      },
    };
    render(<UniversalImportPanel {...localProps} />);
    fireEvent.change(screen.getByTestId("universal-import-file"), { target: { files: [new File(["x"], "book.xlsx")] } });
    await screen.findByTestId("identity-preview");
    fireEvent.click(screen.getByTestId("identity-apply"));
    await waitFor(() => expect(applyIdentity).toHaveBeenCalledWith({ signedPayloads: chunks, mode: "physical_count", corrections: [] }));
    expect(handlers.onApply).not.toHaveBeenCalled();
  });

  it("disables apply for unknown roles and incomplete or duplicate signed chunk sets", async () => {
    const handlers = props();
    for (const signedPayloads of [[signedChunks()[0]!], [signedChunks()[0]!, signedChunks()[0]!]]) {
      const view = render(<UniversalImportPanel {...handlers} localIdentity={{
        enabled: true, role: undefined, mode: "physical_count", readWorkbook: vi.fn().mockResolvedValue([nonsenseSheet]),
        previewIdentity: vi.fn().mockResolvedValue({ preview: { decisions: [{ kind: "review" as const }] }, signedPayloads }),
        applyIdentity: vi.fn(),
      }} />);
      fireEvent.change(screen.getByTestId("universal-import-file"), { target: { files: [new File(["x"], "book.xlsx")] } });
      expect(await screen.findByTestId("identity-preview")).toHaveTextContent(/signed preview.*incomplete|invalid/i);
      expect(screen.queryByTestId("identity-apply")).not.toBeInTheDocument();
      view.unmount();
    }
  });

  it("does not grant the non-server manager role an Apply control", async () => {
    const handlers = props();
    render(<UniversalImportPanel {...handlers} localIdentity={{ enabled: true, role: "manager", mode: "physical_count", readWorkbook: vi.fn().mockResolvedValue([nonsenseSheet]), previewIdentity: vi.fn().mockResolvedValue({ preview: { decisions: [{ kind: "review" }] }, signedPayloads: signedChunks() }), applyIdentity: vi.fn() }} />);
    fireEvent.change(screen.getByTestId("universal-import-file"), { target: { files: [new File(["x"], "book.xlsx")] } });
    await screen.findByTestId("identity-preview");
    expect(screen.queryByTestId("identity-apply")).not.toBeInTheDocument();
  });

  it.each(["apply_target_stale", "apply_preview_invalidated", "preview_versions_stale"])("re-previews %s and requires an explicit retry with replacement chunks", async (code) => {
    const handlers = props();
    const oldChunks = signedChunks();
    const newChunks = signedChunks(["new-a", "new-b"]);
    const previewIdentity = vi.fn()
      .mockResolvedValueOnce({ preview: { decisions: [{ kind: "review" }] }, signedPayloads: oldChunks })
      .mockResolvedValueOnce({ preview: { decisions: [{ kind: "automatic" }] }, signedPayloads: newChunks });
    const applyIdentity = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("Preview is stale."), { code }))
      .mockResolvedValueOnce({ importId: "import-a", mode: "physical_count", countedRows: 1, countQuantity: 1, rows: [{ rowId: "r1", status: "counted" }] });
    render(<UniversalImportPanel {...handlers} localIdentity={{ enabled: true, role: "owner", mode: "physical_count", readWorkbook: vi.fn().mockResolvedValue([nonsenseSheet]), previewIdentity, applyIdentity }} />);
    fireEvent.change(screen.getByTestId("universal-import-file"), { target: { files: [new File(["x"], "book.xlsx")] } });
    await screen.findByTestId("identity-apply");
    fireEvent.click(screen.getByTestId("identity-apply"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/preview refreshed.*apply again/i);
    fireEvent.click(screen.getByTestId("identity-apply"));
    await waitFor(() => expect(applyIdentity).toHaveBeenLastCalledWith({ signedPayloads: newChunks, mode: "physical_count", corrections: [] }));
  });

  it("fails closed when refreshing a stale preview fails and invites a recoverable re-preview", async () => {
    const handlers = props();
    const previewIdentity = vi.fn()
      .mockResolvedValueOnce({ preview: { decisions: [{ kind: "review" }] }, signedPayloads: signedChunks() })
      .mockRejectedValueOnce(new Error("Snapshot unavailable"));
    const applyIdentity = vi.fn().mockRejectedValueOnce(Object.assign(new Error("Preview invalidated"), { code: "apply_preview_invalidated" }));
    render(<UniversalImportPanel {...handlers} localIdentity={{ enabled: true, role: "admin", mode: "physical_count", readWorkbook: vi.fn().mockResolvedValue([nonsenseSheet]), previewIdentity, applyIdentity }} />);
    fireEvent.change(screen.getByTestId("universal-import-file"), { target: { files: [new File(["x"], "book.xlsx")] } });
    await screen.findByTestId("identity-apply");
    fireEvent.click(screen.getByTestId("identity-apply"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not refresh.*choose the file again/i);
    expect(screen.queryByTestId("identity-apply")).not.toBeInTheDocument();
  });

  it("submits stable-row corrections and renders the real apply result with a bounded review surface", async () => {
    const handlers = props();
    const reviews = Array.from({ length: 100 }, (_, index) => ({ kind: "review", candidates: [{ productId: `product-${index}` }] }));
    const token = JSON.stringify({ manifestVersion: "identity-preview-v1", chunkIndex: 0, chunkCount: 1, sanitizedContentRootHash: "root", importId: "import", previewFingerprint: "preview", signature: "sig", rowIds: reviews.map((_, index) => `row-${index}`), decisions: reviews });
    const applyIdentity = vi.fn().mockResolvedValue({ importId: "import", mode: "reconcile", countedRows: 0, countQuantity: 0, rows: reviews.map((_, index) => ({ rowId: `row-${index}`, status: "reconciled" })), reconciliation: { expectedRows: 100, expectedQuantity: 450 } });
    render(<UniversalImportPanel {...handlers} localIdentity={{ enabled: true, role: "owner", mode: "reconcile", readWorkbook: vi.fn().mockResolvedValue([nonsenseSheet]), previewIdentity: vi.fn().mockResolvedValue({ preview: { decisions: reviews }, signedPayloads: [token] }), applyIdentity }} />);
    fireEvent.change(screen.getByTestId("universal-import-file"), { target: { files: [new File(["x"], "book.xlsx")] } });
    await screen.findByTestId("identity-apply");
    expect(screen.getAllByRole("combobox", { name: /Correction for row-/ })).toHaveLength(25);
    fireEvent.change(screen.getByRole("combobox", { name: "Correction for row-0" }), { target: { value: "product-0" } });
    fireEvent.click(screen.getByTestId("identity-apply"));
    await waitFor(() => expect(applyIdentity).toHaveBeenCalledWith({ signedPayloads: [token], mode: "reconcile", corrections: [{ rowId: "row-0", targetProductId: "product-0" }] }));
    expect(await screen.findByTestId("identity-apply-summary")).toHaveTextContent("Reconciled 100 rows, expected quantity 450");
  });

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
    fireEvent.click(screen.getByRole("button", { name: "Confirm and preview" }));
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

  it("pre-fills MEDIUM guesses and shows a confirm affordance instead of silently applying", async () => {
    const handlers = { ...props(), readFile: vi.fn().mockResolvedValue(foreignSheet) };
    render(<UniversalImportPanel {...handlers} />);
    fireEvent.change(screen.getByTestId("universal-import-file"), { target: { files: [new File(["x"], "foreign.csv")] } });
    // The tiered mapping UI opens (not the preview) because a MEDIUM guess needs confirmation.
    const mappingUi = await screen.findByTestId("column-mapping");
    // partNumber column is pre-filled from the fuzzy header 'Mfr Code'.
    expect((screen.getByLabelText("Part number column") as HTMLSelectElement).value).toBe("0");
    // The Manufacturer Ref column is a MEDIUM guess and is surfaced for a one-tap confirm.
    expect(screen.getByTestId("mapping-confirm")).toBeTruthy();
    expect(mappingUi).toHaveTextContent(/confirm/i);
    // Nothing was applied automatically.
    expect(handlers.onApply).not.toHaveBeenCalled();
    expect(handlers.saveMapping).not.toHaveBeenCalled();
  });
});
