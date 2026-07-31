import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { LiveScanFeed } from "@/components/LiveScanFeed";
import { useScanStore } from "@/stores/scanStore";
import type { ScanEvent, UnknownCodeReview, Product } from "@/types";

// The decodeNote platformOwner suffix is only ever rendered for platformOwner. Mock it true just for
// the stale-decodeNote suite below so we can assert on the suffix; every other describe block in this
// file relies on the real (non-platform) default and must keep passing unmocked.
let mockIsPlatformOwner = false;
vi.mock("@/services/security/useAccessLevel", () => ({
  useIsPlatformOwner: () => mockIsPlatformOwner,
}));

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
  mockIsPlatformOwner = false;
  delete process.env.NEXT_PUBLIC_LOCAL_DEMO;
});

describe("LiveScanFeed - local demo proof selectors", () => {
  it("bounds the initial DOM for a 250-scan feed and can reveal the oldest scan", () => {
    const rows = Array.from({ length: 250 }, (_, index) => ({
      ...baseEvent(`code-${index}`, `product-${index}`), id: `event-${index}`,
    }));
    useScanStore.setState({ scanFeed: rows, products: [], needsReviewQueue: [], finalCounts: [] });
    render(<LiveScanFeed />);

    expect(screen.getAllByTestId(/^feed-barcode-event-/)).toHaveLength(100);
    expect(screen.queryByTestId("feed-barcode-event-249")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /show 100 older scans/i }));
    fireEvent.click(screen.getByRole("button", { name: /show 50 older scans/i }));
    expect(screen.getByTestId("feed-barcode-event-249")).toBeInTheDocument();
  });
  it("adds the event, matched-product, and direct canonical-UID selectors to each row in local-demo mode", () => {
    process.env.NEXT_PUBLIC_LOCAL_DEMO = "1";
    const event = {
      ...baseEvent("758823190407", "TIRE_5BAC923891027924DEE7"),
      localDemoCanonicalProductUid: "tire-canonical-uid",
    };
    const unmatchedEvent = { ...event, id: "ev2", matchedProductId: null, localDemoCanonicalProductUid: undefined };
    useScanStore.setState({ scanFeed: [event, unmatchedEvent], needsReviewQueue: [], products: [], finalCounts: [] });

    render(<LiveScanFeed />);

    const row = screen.getByTestId("local-demo-event-ev1");
    expect(row).toHaveAttribute("data-local-demo-event-id", "ev1");
    expect(row).toHaveAttribute("data-local-demo-matched-product-id", "TIRE_5BAC923891027924DEE7");
    expect(row).toHaveAttribute("data-local-demo-canonical-product-uid", "tire-canonical-uid");
    const unmatchedRow = screen.getByTestId("local-demo-event-ev2");
    expect(unmatchedRow).toHaveAttribute("data-local-demo-event-id", "ev2");
    expect(unmatchedRow).toHaveAttribute("data-local-demo-matched-product-id", "");
    expect(unmatchedRow).not.toHaveAttribute("data-local-demo-canonical-product-uid");
  });

  it("does not expose local-demo proof selectors outside local-demo mode", () => {
    const event = {
      ...baseEvent("758823190407", "TIRE_5BAC923891027924DEE7"),
      localDemoCanonicalProductUid: "tire-canonical-uid",
    };
    useScanStore.setState({ scanFeed: [event], needsReviewQueue: [], products: [], finalCounts: [] });

    render(<LiveScanFeed />);

    expect(screen.queryByTestId("local-demo-event-ev1")).not.toBeInTheDocument();
    const row = screen.getByTestId("feed-barcode-ev1").closest("tr");
    expect(row).not.toHaveAttribute("data-local-demo-event-id");
    expect(row).not.toHaveAttribute("data-local-demo-matched-product-id");
    expect(row).not.toHaveAttribute("data-local-demo-canonical-product-uid");
  });
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

  it("Task 9: an app-verified off-category row shows the 'Off-category item' tag (hot sauce in a tire shop)", () => {
    const event = {
      id: "evOff", rawCode: "0792080004312", cleanCode: "0792080004312", matchedProductId: "pOff", matchType: "barcode",
      status: "known", quantityAfterScan: 1, decodeStatus: "verified", reason: "", syncStatus: "synced", createdAt: Date.now(),
      offCategory: true,
    } as unknown as ScanEvent;
    useScanStore.setState({
      scanFeed: [event], needsReviewQueue: [], finalCounts: [],
      products: [{ id: "pOff", name: "Original Anchor Bar Hot Sauce", primarySku: "", provisional: false } as unknown as Product],
    });

    render(<LiveScanFeed />);

    expect(screen.getByText("Original Anchor Bar Hot Sauce")).toBeInTheDocument();
    expect(screen.getByTestId("feed-off-category-evOff")).toHaveTextContent("Off-category item");
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

// Owner order 2026-07-10: a scanned tire's BRAND must be visible on the feed, matching the counts
// table's prettifyBrand treatment. Real product brand wins; a still-provisional row falls back to the
// decode suggestion's brand.
describe("LiveScanFeed - Brand column (owner order 2026-07-10)", () => {
  it("shows the matched product's brand for a verified tire scan", () => {
    const code = "697662155102";
    const tire = {
      ...provisionalProduct("prod9", code),
      name: "wrangler_steadfast_ht",
      brand: "goodyear",
      provisional: false,
      verified: true,
    } as unknown as Product;
    useScanStore.setState({ scanFeed: [baseEvent(code, "prod9")], needsReviewQueue: [], products: [tire], finalCounts: [] });

    render(<LiveScanFeed />);

    expect(screen.getByText("Brand")).toBeInTheDocument();
    expect(screen.getByTestId("feed-brand-ev1").textContent).toBe("Goodyear");
  });

  it("falls back to the decode suggestion's brand while the product is still provisional", () => {
    const code = "086699998538";
    useScanStore.setState({
      scanFeed: [baseEvent(code, "prod1")],
      needsReviewQueue: [suggestionReview(code, 0.9)],
      products: [provisionalProduct("prod1", code)],
      finalCounts: [],
    });

    render(<LiveScanFeed />);

    expect(screen.getByTestId("feed-brand-ev1").textContent).toBe("Michelin");
  });
});

// Owner order: the Size column shows the linked product's structured size (specsShort, parsed via
// matchTireSize - same source FinalCountTable already uses), falling back to canonicalTireSize() of
// the row's display name when the product has no parseable structured size. Never guesses; "-" when
// nothing resolves.
describe("LiveScanFeed - Size column", () => {
  it("shows the product's structured tire size under the Size header", () => {
    const event = {
      id: "evSize1", rawCode: "078742051451", cleanCode: "078742051451", matchedProductId: "pSize1",
      matchType: "barcode", status: "known", quantityAfterScan: 1, decodeStatus: "verified", reason: "",
      syncStatus: "synced", createdAt: Date.now(),
    } as unknown as ScanEvent;
    useScanStore.setState({
      scanFeed: [event], needsReviewQueue: [], finalCounts: [],
      products: [{
        id: "pSize1", name: "Wrangler Workhorse AT", primarySku: "", provisional: false,
        specsShort: "245/40R18 97Y",
      } as unknown as Product],
    });

    render(<LiveScanFeed />);

    expect(screen.getByText("Size")).toBeInTheDocument();
    expect(screen.getByTestId("feed-size-evSize1").textContent?.trim()).toBe("245/40R18");
  });

  it("shows a dash when the product has no parseable size", () => {
    const event = {
      id: "evSize2", rawCode: "999999999999", cleanCode: "999999999999", matchedProductId: "pSize2",
      matchType: "barcode", status: "known", quantityAfterScan: 1, decodeStatus: "verified", reason: "",
      syncStatus: "synced", createdAt: Date.now(),
    } as unknown as ScanEvent;
    useScanStore.setState({
      scanFeed: [event], needsReviewQueue: [], finalCounts: [],
      products: [{
        id: "pSize2", name: "Member's Mark Purified Water 500ml", primarySku: "", provisional: false,
        specsShort: "",
      } as unknown as Product],
    });

    render(<LiveScanFeed />);

    expect(screen.getByTestId("feed-size-evSize2").textContent?.trim()).toBe("-");
  });
});

// Stale-UI fix (goupc-cap-rootcause item 3): decodeNote is set once at scan time to the in-flight
// "Decoding with AI..." note. Once the row settles to a final decodeStatus, that note must never still
// read "Decoding with AI..." - the store now clears/refreshes it on settle, and this suite also proves
// the component-level backstop (never render the in-flight note on a non-decoding row).
describe("LiveScanFeed - decodeNote must not show a stale 'Decoding with AI...' suffix after settle", () => {
  it("platformOwner: a genuinely in-flight row still shows the honest in-flight note", () => {
    mockIsPlatformOwner = true;
    const code = "0866990001111";
    const event = {
      ...baseEvent(code, "prod1"),
      decodeStatus: "decoding",
      reason: "Unknown code - looking it up.",
      decodeNote: "Decoding with AI...",
    } as unknown as ScanEvent;
    useScanStore.setState({ scanFeed: [event], needsReviewQueue: [], products: [], finalCounts: [] });

    render(<LiveScanFeed />);

    expect(screen.getByText(/Decoding with AI/)).toBeInTheDocument();
  });

  it("platformOwner: a settled needs_review row never shows the stale in-flight note", () => {
    mockIsPlatformOwner = true;
    const code = "0866990002222";
    const event = {
      ...baseEvent(code, "prod1"),
      decodeStatus: "needs_review",
      reason: "No provider returned a usable product",
      // Simulates the pre-fix bug directly: a stale note left over from scan time on an otherwise
      // settled row. The component-level backstop must hide it even if a settle path ever regresses.
      decodeNote: "Decoding with AI...",
    } as unknown as ScanEvent;
    useScanStore.setState({ scanFeed: [event], needsReviewQueue: [], products: [], finalCounts: [] });

    render(<LiveScanFeed />);

    expect(screen.getByText("No provider returned a usable product")).toBeInTheDocument();
    expect(screen.queryByText(/Decoding with AI/)).not.toBeInTheDocument();
  });

  it("platformOwner: a settled row with a real post-decode transparency note still shows that note", () => {
    mockIsPlatformOwner = true;
    const code = "0866990003333";
    const event = {
      ...baseEvent(code, "prod1"),
      decodeStatus: "needs_review",
      reason: "No provider returned a usable product",
      decodeNote: "gpt-5.5-ladder skipped: budget_exceeded",
    } as unknown as ScanEvent;
    useScanStore.setState({ scanFeed: [event], needsReviewQueue: [], products: [], finalCounts: [] });

    render(<LiveScanFeed />);

    expect(screen.getByText(/budget_exceeded/)).toBeInTheDocument();
  });

  it("non-platform customer: never sees any decodeNote suffix, settled or in-flight", () => {
    mockIsPlatformOwner = false;
    const code = "0866990004444";
    const event = {
      ...baseEvent(code, "prod1"),
      decodeStatus: "decoding",
      reason: "Unknown code - looking it up.",
      decodeNote: "Decoding with AI...",
    } as unknown as ScanEvent;
    useScanStore.setState({ scanFeed: [event], needsReviewQueue: [], products: [], finalCounts: [] });

    render(<LiveScanFeed />);

    expect(screen.queryByText(/Decoding with AI/)).not.toBeInTheDocument();
  });
});
