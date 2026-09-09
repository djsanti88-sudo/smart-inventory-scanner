import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { LiveScanFeed, FEED_RENDER_WINDOW, FEED_RENDER_CHUNK } from "@/scanning/LiveScanFeed";
import { useScanStore } from "@/stores/scanStore";
import type { ScanEvent, Product } from "@/types";

// DEFECT #29/#37 residual (live-reproduced 2026-08-05/06, canelo round 2): after the Map-lookup fix,
// a fresh-device restore of a 4,500-event business STILL freezes the renderer ~30s because the feed
// synchronously mounts ALL scanFeed rows into the DOM. This suite proves the sanctioned contingency
// (feed windowing): only a bounded window of the MOST RECENT rows mounts, with an honest summary row
// stating exactly how many earlier scans are hidden, and a "Show more" control that expands it. The
// TOP-LEVEL LAW is untouched: every scan still COUNTS (the header's "N scans" total stays unwindowed)
// even though only a bounded number of rows are physically in the DOM.
function makeFeed(n: number): ScanEvent[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `ev-${i}`,
    rawCode: `code-${i}`,
    cleanCode: `code-${i}`,
    matchedProductId: "p1",
    matchType: "barcode",
    status: "known",
    quantityAfterScan: i + 1,
    decodeStatus: "verified",
    reason: "",
    syncStatus: "synced",
    createdAt: Date.now() - i, // newest first, matching the store's documented ordering
  })) as unknown as ScanEvent[];
}

const product: Product = {
  id: "p1",
  businessId: "biz1",
  name: "Test Widget",
  brand: "Acme",
  specsShort: "",
  primarySku: "SKU1",
  provisional: false,
} as unknown as Product;

afterEach(() => {
  cleanup();
  useScanStore.setState({ scanFeed: [], needsReviewQueue: [], products: [], finalCounts: [] });
});

describe("LiveScanFeed windowing (defect #29/#37 residual, 4,500-event freeze)", () => {
  it("mounts only a bounded window of DOM rows even when scanFeed has 1,000 events", () => {
    const scanFeed = makeFeed(1000);
    useScanStore.setState({ scanFeed, needsReviewQueue: [], products: [product], finalCounts: [] });

    render(<LiveScanFeed />);

    const body = screen.getByTestId("scan-feed-body");
    const dataRows = within(body).getAllByTestId(/^feed-product-/);
    expect(dataRows.length).toBeLessThanOrEqual(FEED_RENDER_WINDOW);
    expect(dataRows.length).toBeGreaterThan(0);
  });

  it("the session total still reflects ALL rows, not just the rendered window (TOP-LEVEL LAW)", () => {
    const scanFeed = makeFeed(1000);
    useScanStore.setState({ scanFeed, needsReviewQueue: [], products: [product], finalCounts: [] });

    render(<LiveScanFeed />);

    expect(screen.getByText("1000 scans")).toBeInTheDocument();
  });

  it("shows an honest hidden-row count in the summary row", () => {
    const n = 1000;
    const scanFeed = makeFeed(n);
    useScanStore.setState({ scanFeed, needsReviewQueue: [], products: [product], finalCounts: [] });

    render(<LiveScanFeed />);

    const summary = screen.getByTestId("feed-hidden-summary");
    expect(summary.textContent).toContain(String(n - FEED_RENDER_WINDOW));
  });

  it("newest rows stay visible exactly as today (first rendered row is the newest scan)", () => {
    const scanFeed = makeFeed(1000);
    useScanStore.setState({ scanFeed, needsReviewQueue: [], products: [product], finalCounts: [] });

    render(<LiveScanFeed />);

    expect(screen.getByTestId("feed-product-ev-0")).toBeInTheDocument();
    expect(screen.queryByTestId(`feed-product-ev-${FEED_RENDER_WINDOW}`)).not.toBeInTheDocument();
  });

  it("Show more expands the window by FEED_RENDER_CHUNK and shrinks the hidden count", () => {
    const n = 1000;
    const scanFeed = makeFeed(n);
    useScanStore.setState({ scanFeed, needsReviewQueue: [], products: [product], finalCounts: [] });

    render(<LiveScanFeed />);

    fireEvent.click(screen.getByTestId("feed-show-more"));

    const body = screen.getByTestId("scan-feed-body");
    const dataRows = within(body).getAllByTestId(/^feed-product-/);
    expect(dataRows.length).toBe(FEED_RENDER_WINDOW + FEED_RENDER_CHUNK);

    const summary = screen.getByTestId("feed-hidden-summary");
    expect(summary.textContent).toContain(String(n - (FEED_RENDER_WINDOW + FEED_RENDER_CHUNK)));
  });

  it("does not render the summary row when the feed fits inside the window", () => {
    const scanFeed = makeFeed(10);
    useScanStore.setState({ scanFeed, needsReviewQueue: [], products: [product], finalCounts: [] });

    render(<LiveScanFeed />);

    expect(screen.queryByTestId("feed-hidden-summary")).not.toBeInTheDocument();
  });
});
