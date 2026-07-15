import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
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

beforeEach(() => {
  window.localStorage.clear();
  useReconcileStore.setState({ session: null, matches: null, report: null, _hasHydrated: true });
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
