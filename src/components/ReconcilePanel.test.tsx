import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import ExcelJS from "exceljs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { useScanStore } from "@/stores/scanStore";
import { useReconcileStore } from "@/stores/reconcileStore";
import { ReconcilePanel } from "@/components/ReconcilePanel";
import type { AdapterResult } from "@/services/reconcile/types";
import type { MatchResult } from "@/services/reconcile/identityMatcher";
import { buildReconcileReport } from "@/services/reconcile/reconcileReport";
import type { Product } from "@/types";

// Task 7 component proof: bucket-grouped report table, delta highlight, honest empty state,
// visible adapter assumptions, CSV export, and the AM-R6/AM-R10f "Confirm barcode links" flow
// (confirming routes through the EXISTING scanStore human-approval path; NOTHING auto-approves).

vi.mock("@/services/exportFormats", () => ({
  downloadCsv: vi.fn(),
}));

const getSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  getSession: (...args: unknown[]) => getSession(...args),
}));

import { downloadCsv } from "@/services/exportFormats";

// A real, check-digit-valid UPC-A that is NOT in any seed data.
const LINK_BARCODE = "036000291452";
const LINK_PN = "PN123";

const product: Product = {
  id: "p1", businessId: "biz-1", name: "Cooper Discoverer AT3", brand: "Cooper", category: "Tires",
  specsShort: "265/70R17", specsFull: "", primarySku: LINK_PN, primaryBarcode: "", gtin: "", upc: "", ean: "",
  vendorCodes: [], aliases: [], imageUrl: "", productUrl: "", location: "", notes: "",
  status: "active", source: "human_review", confidence: 1, verified: true,
  createdAt: "", updatedAt: "", createdBy: "human", updatedBy: "human",
};

const adapter: AdapterResult = {
  rows: [
    { externalId: LINK_PN, partNumbers: [LINK_PN], brand: "Cooper", model: "Discoverer AT3", sizeText: "265/70R17", qty: 6, raw: {} },
    { externalId: "PN-UNKNOWN", partNumbers: ["PN-UNKNOWN"], brand: "Pirelli", sizeText: "205/55R16", qty: 2, raw: {} },
  ],
  uomReview: [],
  unparseable: [],
  assumptions: ['Quantities assumed unit "each" (no UOM column).'],
};

const matchedResult: MatchResult = {
  row: adapter.rows[0],
  status: "matched",
  reason: 'Part number hit for "Cooper Discoverer AT3" (brand corroborated, size corroborated).',
  candidate: { uid: "uid-1", brand: "Cooper", name: "Discoverer AT3", sizeToken: "265/70R17", partNumber: LINK_PN, barcode: LINK_BARCODE },
  linkageSuggestion: { barcode: LINK_BARCODE, partNumber: LINK_PN },
};

const unmatchedResult: MatchResult = {
  row: adapter.rows[1],
  status: "unmatched",
  reason: "No part-number hit and no identity match found in the corpus for this row.",
};

/** Seed both stores: a counted session (4 counted vs 6 expected -> variance -2) + a full report. */
function seedWithReport() {
  useScanStore.setState({
    products: [product],
    aliases: [],
    finalCounts: [{
      id: "c1", businessId: "biz-1", sessionId: "s", productId: "p1", quantity: 4,
      lastScannedAt: "", aliasesSeen: [], scanEventIds: [], createdAt: "", updatedAt: "",
      syncStatus: "synced", syncError: null, appliedIdempotencyKeys: [],
    }],
    needsReviewQueue: [],
    businessId: "biz-1",
  });
  const matches = [matchedResult, unmatchedResult];
  const report = buildReconcileReport({
    matches,
    adapter,
    countedByUid: { "uid-1": 4 },
  });
  useReconcileStore.setState({
    session: { fileName: "shopware.csv", importedAt: "2026-07-15T00:00:00.000Z", adapter },
    matches,
    report,
    _hasHydrated: true,
  });
}

function fixtureFile(name: string, content: string, type = "text/csv"): File {
  const bytes = new TextEncoder().encode(content);
  const file = new File([bytes], name, { type });
  // jsdom's File may lack text/arrayBuffer in older versions - provide them explicitly so the REAL
  // readUniversalFile / parseShopwareCsv code paths run unchanged (same pattern as
  // UniversalImportPanel.fixtures.test.tsx).
  if (typeof file.text !== "function") {
    Object.defineProperty(file, "text", { value: async () => content });
  }
  if (typeof file.arrayBuffer !== "function") {
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
  }
  return file;
}

async function xlsxFile(name: string, rows: string[][]): Promise<File> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Inventory");
  for (const row of rows) worksheet.addRow(row);
  const buffer = await workbook.xlsx.writeBuffer();
  const bytes = new Uint8Array(buffer);
  const file = new File([bytes], name, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  if (typeof file.arrayBuffer !== "function") {
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
  }
  return file;
}

const shopwareFixtureText = readFileSync(
  path.join(process.cwd(), "src", "services", "reconcile", "fixtures", "shopware-sample.csv"),
  "utf-8",
);

beforeEach(() => {
  vi.unstubAllEnvs();
  getSession.mockReset().mockResolvedValue({ getIdToken: vi.fn().mockResolvedValue("firebase-token") });
  window.localStorage.clear();
  useReconcileStore.setState({ session: null, matches: null, report: null, unitCosts: {}, _hasHydrated: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ReconcilePanel - empty state", () => {
  it("shows an honest empty state when nothing has been imported", () => {
    render(<ReconcilePanel />);
    expect(screen.getByTestId("reconcile-empty-state").textContent).toMatch(/No file imported yet/i);
    expect(screen.queryByTestId("reconcile-report")).not.toBeInTheDocument();
  });
});

describe("ReconcilePanel - report rendering", () => {
  it("renders bucket-grouped sections with the lines in the right groups", () => {
    seedWithReport();
    render(<ReconcilePanel />);
    const varianceSection = screen.getByTestId("bucket-variance");
    expect(varianceSection.textContent).toContain(LINK_PN);
    const unmatchedSection = screen.getByTestId("bucket-unmatched");
    expect(unmatchedSection.textContent).toContain("PN-UNKNOWN");
    // empty buckets are not rendered as sections
    expect(screen.queryByTestId("bucket-non_tire")).not.toBeInTheDocument();
  });

  it("highlights the variance delta", () => {
    seedWithReport();
    render(<ReconcilePanel />);
    const delta = screen.getAllByTestId("reconcile-delta")[0];
    expect(delta.textContent).toBe("-2");
    expect(delta.className).toContain("text-red-700");
  });

  it("surfaces the adapter assumptions (the each-unit assumption) in the report header area", () => {
    seedWithReport();
    render(<ReconcilePanel />);
    expect(screen.getByTestId("reconcile-assumptions").textContent).toContain('assumed unit "each"');
  });

  it("exports the report CSV through the shared download helper", () => {
    seedWithReport();
    render(<ReconcilePanel />);
    fireEvent.click(screen.getByTestId("reconcile-export-csv"));
    expect(downloadCsv).toHaveBeenCalledTimes(1);
    const [csv] = vi.mocked(downloadCsv).mock.calls[0];
    expect(csv).toContain("bucket");
    expect(csv).toContain(LINK_PN);
  });
});

describe("ReconcilePanel session scoping (M2, same leak class as F2)", () => {
  it("sends the active business and Firebase token when live auth is enabled", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_MODE", "live");
    useScanStore.setState({
      products: [product], aliases: [], finalCounts: [], needsReviewQueue: [], businessId: "biz-1",
      currentSession: null,
    });
    useReconcileStore.setState({
      session: { fileName: "shopware.csv", importedAt: "", adapter }, matches: null, report: null, _hasHydrated: true,
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ matches: [matchedResult, unmatchedResult] }) });
    vi.stubGlobal("fetch", fetchMock);

    render(<ReconcilePanel />);
    fireEvent.click(screen.getByTestId("reconcile-run"));
    await screen.findByTestId("reconcile-report");

    const request = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(request).toMatchObject({ businessId: "biz-1", idToken: "firebase-token" });
  });

  // refreshFromCloud intentionally does an ADDITIVE cross-session merge into finalCounts (a tested
  // cross-device sync path - see refreshFromCloud.store.test.ts). onRunCompare's deriveCountedByUid
  // call must use only the CURRENT session's counts, not every session's counts merged into the store.
  it("runs the compare using only the current session's counted qty, excluding another session's count for the same product", async () => {
    useScanStore.setState({
      products: [product],
      aliases: [],
      finalCounts: [
        {
          id: "c1", businessId: "biz-1", sessionId: "session-1", productId: "p1", quantity: 4,
          lastScannedAt: "", aliasesSeen: [], scanEventIds: [], createdAt: "", updatedAt: "",
          syncStatus: "synced", syncError: null, appliedIdempotencyKeys: [],
        },
        // Merged in from another device's session by refreshFromCloud (overwrites p1's mapped qty to
        // 100 in deriveCountedByUid's last-write-wins Map if not filtered by session first).
        {
          id: "cOther", businessId: "biz-1", sessionId: "other-session-id", productId: "p1", quantity: 100,
          lastScannedAt: "", aliasesSeen: [], scanEventIds: [], createdAt: "", updatedAt: "",
          syncStatus: "synced", syncError: null, appliedIdempotencyKeys: [],
        },
      ],
      needsReviewQueue: [],
      businessId: "biz-1",
      currentSession: {
        id: "session-1",
        businessId: "biz-1",
        name: "Default Session",
        location: "Main",
        status: "active",
        startedAt: "",
        completedAt: null,
        createdBy: "demo",
        notes: "",
        syncStatus: "synced",
      },
    });
    useReconcileStore.setState({
      session: { fileName: "shopware.csv", importedAt: "2026-07-15T00:00:00.000Z", adapter },
      matches: null,
      report: null,
      _hasHydrated: true,
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ matches: [matchedResult, unmatchedResult] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ReconcilePanel />);
    fireEvent.click(screen.getByTestId("reconcile-run"));
    await screen.findByTestId("reconcile-report");

    const delta = screen.getAllByTestId("reconcile-delta")[0];
    // Expected 6, current-session counted 4 -> delta -2. If the other session's 100 leaked into
    // deriveCountedByUid's finalCounts input, this would be +94 instead.
    expect(delta.textContent).toBe("-2");

    vi.unstubAllGlobals();
  });
});

describe("ReconcilePanel - Confirm barcode links (AM-R6 / AM-R10f)", () => {
  it("AM-R10f: NO approved alias exists before the user confirms; confirming creates one through the existing human-approval path; nothing is counted", () => {
    seedWithReport();
    render(<ReconcilePanel />);

    // BEFORE: the reconcile match alone must not have written any alias for the barcode.
    expect(
      useScanStore.getState().aliases.some((a) => a.cleanCode === LINK_BARCODE),
    ).toBe(false);

    const countsBefore = useScanStore.getState().finalCounts.map((c) => ({ ...c }));

    fireEvent.click(screen.getByTestId(`confirm-link-${LINK_BARCODE}`));

    // AFTER: an APPROVED alias exists, pointing at the product the part number resolves to.
    const alias = useScanStore.getState().aliases.find((a) => a.cleanCode === LINK_BARCODE);
    expect(alias).toBeDefined();
    expect(alias!.approved).toBe(true);
    expect(alias!.productId).toBe("p1");

    // AM-R6: nothing auto-counts from a reconcile confirmation.
    expect(useScanStore.getState().finalCounts).toEqual(countsBefore);
  });

  it("a linkage whose part number resolves to NO local product shows an honest message instead of a confirm button", () => {
    seedWithReport();
    // Point the linkage at a part number no product owns.
    const orphanMatch: MatchResult = {
      ...matchedResult,
      candidate: { ...matchedResult.candidate!, uid: "uid-9", partNumber: "PN-NOBODY", barcode: "079567300403" },
      linkageSuggestion: { barcode: "079567300403", partNumber: "PN-NOBODY" },
    };
    useReconcileStore.setState({ matches: [orphanMatch, unmatchedResult] });
    render(<ReconcilePanel />);
    expect(screen.queryByTestId("confirm-link-079567300403")).not.toBeInTheDocument();
    expect(screen.getByTestId("confirm-links").textContent).toMatch(/No product in your inventory matches part number/i);
  });
});

// M3/H1: de-brand the page ("Reconcile with Shop-Ware" -> generic "Reconcile your inventory
// export"); the header-synonym matching underneath already supports non-Shop-Ware files.
describe("ReconcilePanel - de-branded copy (M3/H1)", () => {
  it("uses generic language, not Shop-Ware-specific branding, in the header and empty state", () => {
    render(<ReconcilePanel />);
    expect(screen.getByRole("heading", { name: /Reconcile your inventory export/i })).toBeInTheDocument();
    expect(screen.queryByText(/Reconcile with Shop-Ware/i)).not.toBeInTheDocument();
    expect(screen.getByTestId("reconcile-empty-state").textContent).not.toMatch(/Shop-Ware/i);
  });

  it("uses generic language in the report table header and variance bucket label", () => {
    seedWithReport();
    render(<ReconcilePanel />);
    expect(screen.getByTestId("reconcile-report").textContent).not.toMatch(/Shop-Ware/i);
  });
});

// M3/H1: XLSX/TSV intake. readUniversalFile (CSV/TSV/XLSX) + column-mapping intelligence are
// reused (read-only) so any spreadsheet a shop exports runs the compare-vs-counted loop; the
// Shop-Ware CSV path keeps working unchanged as a fast path.
describe("ReconcilePanel - universal file intake (M3/H1)", () => {
  it("uses the complete signed identity preview and reconcile apply flow when the local identity flag is on", async () => {
    vi.stubEnv("NEXT_PUBLIC_LOCAL_HYBRID_IDENTITY_V1", "1");
    vi.stubEnv("NEXT_PUBLIC_LOCAL_IDENTITY_ROLE", "manager");
    const chunks = [0, 1].map((chunkIndex) => JSON.stringify({ manifestVersion: "identity-preview-v1", chunkIndex, chunkCount: 2, sanitizedContentRootHash: "root-r", importId: "import-r", previewFingerprint: "preview-r", signature: `sig-${chunkIndex}` }));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ preview: { decisions: [{ kind: "automatic" }] }, signedPayloads: chunks }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ applied: 0, queuedForReview: 0, rejected: 0 }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<ReconcilePanel />);
    const csv = "Name,Brand,Part Number,Barcode,Quantity\nWidget,Acme,W-1,012345678905,9\n";
    fireEvent.change(screen.getByTestId("reconcile-file"), { target: { files: [fixtureFile("generic.csv", csv)] } });
    expect(await screen.findByTestId("identity-preview")).toHaveTextContent("automatic 1");
    fireEvent.click(screen.getByTestId("identity-apply"));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]!.body))).toEqual({ signedPayloads: chunks, mode: "reconcile", corrections: [] });
    expect(useReconcileStore.getState().session).toBeNull();
  });

  it("keeps the Shop-Ware CSV fast path working (regression): the real fixture still imports via parseShopwareCsv", async () => {
    render(<ReconcilePanel />);
    fireEvent.change(screen.getByTestId("reconcile-file"), {
      target: { files: [fixtureFile("shopware-export.csv", shopwareFixtureText)] },
    });
    const summary = await screen.findByTestId("reconcile-session-summary");
    // Fixture: Michelin (merged, 1 row) + Goodyear (1 row) = 2 rows; Continental held for unit
    // review (box, not each); BAD-ROW-NO-QTY is unreadable (see shopwareCsvAdapter.test.ts).
    expect(summary.textContent).toContain("2 rows");
    expect(summary.textContent).toContain("1 held for unit review");
    expect(summary.textContent).toContain("1 unreadable");
    expect(screen.queryByTestId("reconcile-import-error")).not.toBeInTheDocument();
  });

  it("falls back to the universal column-mapping path for a CSV that is not Shop-Ware-shaped (no on-hand/available quantity column)", async () => {
    render(<ReconcilePanel />);
    const csv = "Name,Brand,Part Number,Barcode,Quantity\nWidget,Acme,W-1,012345678905,9\n";
    fireEvent.change(screen.getByTestId("reconcile-file"), {
      target: { files: [fixtureFile("generic.csv", csv)] },
    });
    const summary = await screen.findByTestId("reconcile-session-summary");
    expect(summary.textContent).toContain("1 rows");
    expect(screen.queryByTestId("reconcile-import-error")).not.toBeInTheDocument();
  });

  it("imports an XLSX file (universal reader + column mapping) and matches through to a report", async () => {
    const file = await xlsxFile("inventory.xlsx", [
      ["Part Number", "Brand", "Model", "Size", "Quantity"],
      ["XLS-1", "Acme", "Road King", "225/45R18", "5"],
    ]);
    const xlsMatch: MatchResult = {
      row: { externalId: "XLS-1", partNumbers: ["XLS-1"], brand: "Acme", model: "Road King", sizeText: "225/45R18", qty: 5, raw: {} },
      status: "unmatched",
      reason: "No part-number hit and no identity match found in the corpus for this row.",
    };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ matches: [xlsMatch] }) });
    vi.stubGlobal("fetch", fetchMock);

    render(<ReconcilePanel />);
    fireEvent.change(screen.getByTestId("reconcile-file"), { target: { files: [file] } });
    const summary = await screen.findByTestId("reconcile-session-summary");
    expect(summary.textContent).toContain("1 rows");

    fireEvent.click(screen.getByTestId("reconcile-run"));
    await screen.findByTestId("reconcile-report");
    expect(screen.getByTestId("bucket-unmatched").textContent).toContain("XLS-1");

    const posted = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as { rows: Array<{ externalId: string; qty: number }> };
    expect(posted.rows[0].externalId).toBe("XLS-1");
    expect(posted.rows[0].qty).toBe(5);

    vi.unstubAllGlobals();
  });
});

// M3/H1: optional, LOCALLY-stored unit-cost column drives a dollar-variance headline. Cost data
// must NEVER be sent to /api/reconcile/match (or any AI/network path) - mirrors the existing
// SENSITIVE_HEADER exclusion for AI paths (universalImportPreview.ts).
describe("ReconcilePanel - dollar variance (opt-in, LOCAL-ONLY, M3/H1)", () => {
  it("shows a dollar-variance headline computed from the local unit cost map", () => {
    seedWithReport();
    useReconcileStore.setState({ unitCosts: { [LINK_PN]: 50 } });
    render(<ReconcilePanel />);
    // matchedResult: expected 6, counted 4 -> delta -2; |-2| * $50 = $100 across 1 SKU.
    expect(screen.getByTestId("reconcile-dollar-variance").textContent).toBe("$100.00 variance across 1 SKUs");
  });

  it("shows no headline when no priced variance line exists", () => {
    seedWithReport();
    render(<ReconcilePanel />);
    expect(screen.queryByTestId("reconcile-dollar-variance")).not.toBeInTheDocument();
  });

  it("GUARD: the local unit cost map is never included in the /api/reconcile/match request payload", async () => {
    seedWithReport();
    useReconcileStore.setState({ unitCosts: { [LINK_PN]: 999.99 } });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ matches: [matchedResult, unmatchedResult] }) });
    vi.stubGlobal("fetch", fetchMock);

    render(<ReconcilePanel />);
    fireEvent.click(screen.getByTestId("reconcile-run"));
    await screen.findByTestId("reconcile-report");

    const bodyText = String(fetchMock.mock.calls[0][1].body);
    expect(bodyText).not.toContain("999.99");
    expect(bodyText).not.toContain("unitCost");
    const posted = JSON.parse(bodyText) as { rows: Array<Record<string, unknown>> };
    expect(posted.rows.every((row) => !("unitCost" in row))).toBe(true);

    vi.unstubAllGlobals();
  });
});
