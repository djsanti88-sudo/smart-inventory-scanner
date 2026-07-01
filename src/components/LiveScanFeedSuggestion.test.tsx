import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { LiveScanFeed } from "@/components/LiveScanFeed";
import { useScanStore } from "@/stores/scanStore";
import type { ScanEvent, UnknownCodeReview, Product } from "@/types";

// PHASE 1 (Suggested display, no count): a weak-source non-public scan (e.g. X004DY7YUT) that did NOT count
// must show its decoded suggested product name on the scan FEED row instead of "Product: -", tagged
// "(suggested)", while still NOT being counted. Read-only UI; no alias, no verified product, no count.

afterEach(() => {
  cleanup();
  useScanStore.setState({ scanFeed: [], needsReviewQueue: [], products: [], finalCounts: [] });
});

describe("LiveScanFeed - Suggested display (Phase 1)", () => {
  it("shows the decoded suggestion name on a non-counted Suggested row, tagged '(suggested)', not '-'", () => {
    const event = {
      id: "ev1", rawCode: "X004DY7YUT", cleanCode: "X004DY7YUT", matchedProductId: null, matchType: "unknown",
      status: "needs_review", quantityAfterScan: 0, decodeStatus: "suggested", reason: "Suggested, not trusted.",
      syncStatus: "synced", createdAt: Date.now(),
    } as unknown as ScanEvent;
    const review = {
      id: "rv1", cleanCode: "X004DY7YUT", suggestedProductName: "NatureBell Magnesium Glycinate 500mg",
      suggestedPrimarySku: "", status: "open",
    } as unknown as UnknownCodeReview;
    useScanStore.setState({ scanFeed: [event], needsReviewQueue: [review], products: [], finalCounts: [] });

    render(<LiveScanFeed />);

    expect(screen.getByText("NatureBell Magnesium Glycinate 500mg"), "suggested name shown on the row").toBeTruthy();
    expect(screen.getByText("(suggested)"), "row marked as a suggestion").toBeTruthy();
    // PHASE 1 guarantee: it is NOT counted.
    expect(useScanStore.getState().finalCounts, "Phase 1 shows but does not count").toHaveLength(0);
  });

  it("a counted (known) row shows the real product name with NO '(suggested)' tag", () => {
    const event = {
      id: "ev2", rawCode: "078742051451", cleanCode: "078742051451", matchedProductId: "p1", matchType: "barcode",
      status: "known", quantityAfterScan: 1, decodeStatus: "verified", reason: "", syncStatus: "synced", createdAt: Date.now(),
    } as unknown as ScanEvent;
    useScanStore.setState({
      scanFeed: [event], needsReviewQueue: [], finalCounts: [],
      products: [{ id: "p1", name: "Member's Mark Purified Water 500ml", primarySku: "" } as unknown as Product],
    });

    render(<LiveScanFeed />);

    expect(screen.getByText("Member's Mark Purified Water 500ml")).toBeTruthy();
    expect(screen.queryByText("(suggested)"), "a real counted product is not tagged suggested").toBeNull();
  });
});
