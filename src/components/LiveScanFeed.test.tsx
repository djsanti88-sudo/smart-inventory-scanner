import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { LiveScanFeed } from "@/components/LiveScanFeed";
import { useScanStore } from "@/stores/scanStore";
import type { ScanEvent, UnknownCodeReview, Product } from "@/types";

// Task 3: a scan that already minted a PROVISIONAL placeholder product ("Unidentified item (barcode X)")
// must still surface the decoded suggestion identity on the feed row instead of showing the placeholder
// forever. ensureProvisionalCount ALWAYS creates that placeholder before decode finishes, so `product` is
// truthy and a naive `product ? undefined : suggestion` lookup skips the suggestion entirely (the bug).
// Trust rule: a high-confidence (>=0.8) suggestion is tagged "unconfirmed" (neutral), never a bare identity
// and never the amber "(suggested)" tag reserved for low-confidence (<0.8) suggestions.

function provisionalProduct(id: string, code: string): Product {
  return {
    id,
    businessId: "biz1",
    name: `Unidentified item (barcode ${code})`,
    brand: "",
    category: "",
    specsShort: "",
    specsFull: "",
    primarySku: "",
    primaryBarcode: code,
    gtin: "",
    upc: "",
    ean: "",
    aliases: [],
    verified: false,
    provisional: true,
    confidence: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: "ai",
    updatedAt: "2026-01-01T00:00:00.000Z",
    updatedBy: "ai",
  } as unknown as Product;
}

function baseEvent(code: string, productId: string): ScanEvent {
  return {
    id: "ev1",
    rawCode: code,
    cleanCode: code,
    matchedProductId: productId,
    matchType: "unknown",
    status: "known",
    quantityAfterScan: 1,
    decodeStatus: "suggested",
    reason: "Suggested, not trusted.",
    syncStatus: "synced",
    createdAt: Date.now(),
  } as unknown as ScanEvent;
}

function suggestionReview(code: string, confidence: number): UnknownCodeReview {
  return {
    id: "rv1",
    cleanCode: code,
    suggestedProductName: "Michelin Defender LTX M/S 275/60R20",
    suggestedBrand: "Michelin",
    suggestedPrimarySku: "",
    confidence,
    status: "open",
  } as unknown as UnknownCodeReview;
}

afterEach(() => {
  cleanup();
  useScanStore.setState({ scanFeed: [], needsReviewQueue: [], products: [], finalCounts: [] });
});

describe("LiveScanFeed - suggested identity over provisional placeholder (Task 3)", () => {
  it("shows the suggested identity instead of the Unidentified placeholder", () => {
    const code = "0866990000123";
    const product = provisionalProduct("prod1", code);
    const event = baseEvent(code, product.id);
    const review = suggestionReview(code, 0.92);
    useScanStore.setState({ scanFeed: [event], needsReviewQueue: [review], products: [product], finalCounts: [] });

    render(<LiveScanFeed />);

    expect(screen.getByText(/Michelin Defender LTX/)).toBeInTheDocument();
    expect(screen.queryByText(/Unidentified item/)).not.toBeInTheDocument();
    expect(screen.getByText(/unconfirmed/i)).toBeInTheDocument();
    expect(screen.queryByText(/\(suggested\)/)).not.toBeInTheDocument();
  });

  it("low-confidence suggestion keeps the (suggested) tag", () => {
    const code = "0866990000456";
    const product = provisionalProduct("prod2", code);
    const event = baseEvent(code, product.id);
    const review = suggestionReview(code, 0.55);
    useScanStore.setState({ scanFeed: [event], needsReviewQueue: [review], products: [product], finalCounts: [] });

    render(<LiveScanFeed />);

    expect(screen.getByText(/Michelin Defender LTX/)).toBeInTheDocument();
    expect(screen.getByText(/\(suggested\)/)).toBeInTheDocument();
    expect(screen.queryByText(/^unconfirmed$/i)).not.toBeInTheDocument();
  });

  it("a real (non-provisional) product still displays normally with no tag", () => {
    const event = {
      id: "ev3", rawCode: "078742051451", cleanCode: "078742051451", matchedProductId: "p1", matchType: "barcode",
      status: "known", quantityAfterScan: 1, decodeStatus: "verified", reason: "", syncStatus: "synced", createdAt: Date.now(),
    } as unknown as ScanEvent;
    useScanStore.setState({
      scanFeed: [event], needsReviewQueue: [], finalCounts: [],
      products: [{ id: "p1", name: "Member's Mark Purified Water 500ml", primarySku: "", provisional: false } as unknown as Product],
    });

    render(<LiveScanFeed />);

    expect(screen.getByText("Member's Mark Purified Water 500ml")).toBeInTheDocument();
    expect(screen.queryByText(/\(suggested\)/)).not.toBeInTheDocument();
    expect(screen.queryByText(/unconfirmed/i)).not.toBeInTheDocument();
  });

  it("prettifies a corpus slug product name (Task 5)", () => {
    const event = {
      id: "ev5", rawCode: "078742051987", cleanCode: "078742051987", matchedProductId: "p5", matchType: "barcode",
      status: "known", quantityAfterScan: 1, decodeStatus: "verified", reason: "", syncStatus: "synced", createdAt: Date.now(),
    } as unknown as ScanEvent;
    useScanStore.setState({
      scanFeed: [event], needsReviewQueue: [], finalCounts: [],
      products: [{ id: "p5", name: "wrangler_workhorse_at", primarySku: "", provisional: false } as unknown as Product],
    });

    render(<LiveScanFeed />);

    expect(screen.getByText("Wrangler Workhorse AT")).toBeInTheDocument();
    expect(screen.queryByText("wrangler_workhorse_at")).not.toBeInTheDocument();
  });

  it("shows a dash when neither a real product nor a suggestion exists", () => {
    const event = {
      id: "ev4", rawCode: "999", cleanCode: "999", matchedProductId: null, matchType: "unknown",
      status: "needs_review", quantityAfterScan: 0, decodeStatus: "needs_review", reason: "No match", syncStatus: "synced", createdAt: Date.now(),
    } as unknown as ScanEvent;
    useScanStore.setState({ scanFeed: [event], needsReviewQueue: [], products: [], finalCounts: [] });

    render(<LiveScanFeed />);

    expect(screen.getByTestId("feed-product-ev4").textContent?.trim()).toBe("-");
  });
});
