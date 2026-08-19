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
// Trust rule (owner decision 2026-08-19): every non-verified identity on the row carries the app-derived
// band ("Suggested - high/medium/low confidence"), never a bare identity, never a raw percentage, and
// the same wording whether the guess came through the inline-pending path or the auto-applied
// (>= 0.8, review auto-closed) path. An auto-applied row also gets the one-tap Approve.

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

function suggestionReview(code: string, confidence: number, extra: Partial<UnknownCodeReview> = {}): UnknownCodeReview {
  return {
    id: "rv1",
    cleanCode: code,
    suggestedProductName: "Michelin Defender LTX M/S 275/60R20",
    suggestedBrand: "Michelin",
    suggestedPrimarySku: "",
    confidence,
    decodeStatus: "suggested",
    evidenceStrength: "none",
    exactCodeEvidenceVerifiedByApp: false,
    status: "open",
    ...extra,
  } as unknown as UnknownCodeReview;
}

afterEach(() => {
  cleanup();
  useScanStore.setState({ scanFeed: [], needsReviewQueue: [], products: [], finalCounts: [] });
  mockIsPlatformOwner = false;
});

describe("LiveScanFeed - suggested identity over provisional placeholder (Task 3)", () => {
  it("shows the suggested identity instead of the Unidentified placeholder", () => {
    const code = "0866990000123";
    const product = provisionalProduct("prod1", code);
    const event = baseEvent(code, product.id);
    // Auto-applied: the review auto-closed (resolvedBy "auto"), the product stays provisional/unverified.
    const review = suggestionReview(code, 0.92, { status: "resolved", resolvedBy: "auto", provisionalProductId: product.id });
    useScanStore.setState({ scanFeed: [event], needsReviewQueue: [review], products: [product], finalCounts: [] });

    render(<LiveScanFeed />);

    expect(screen.getByText(/Michelin Defender LTX/)).toBeInTheDocument();
    expect(screen.queryByText(/Unidentified item/)).not.toBeInTheDocument();
    // The band, not the old neutral "unconfirmed" word, and never a percentage.
    const nameCell = screen.getByTestId("feed-product-ev1");
    expect(nameCell.textContent).toMatch(/Suggested - medium confidence/);
    expect(nameCell.textContent).not.toMatch(/unconfirmed|%/);
    // COSMETIC (2026-08-04, cocacola-bug-report.md): a real space between the name and the tag, so the
    // two differently-styled runs never read as one word ("Delinte D7Suggested") in a screenshot.
    expect(nameCell.textContent).toMatch(/\S\s+\(Suggested - medium confidence\)/);
    // One-tap Approve + Edit on the auto-applied row (Approve = the same human-approval core the sheet uses).
    expect(screen.getByTestId("approve-applied-ev1")).toHaveAttribute("tabindex", "-1");
    expect(screen.getByTestId("edit-identity-ev1")).toBeInTheDocument();
  });

  it("one-tap Approve on an auto-applied row confirms that identity (tenant alias), then the row shows Edit only", () => {
    const code = "0866990000123";
    const product = provisionalProduct("prod1", code);
    const event = baseEvent(code, product.id);
    const review = suggestionReview(code, 0.92, { status: "resolved", resolvedBy: "auto", provisionalProductId: product.id });
    const confirmRowIdentity = vi.fn((id: string, fields: { name: string; brand?: string }) => {
      // Simulate the store's outcome: product verified with the confirmed identity, alias approved.
      useScanStore.setState((s) => ({
        products: s.products.map((p) => (p.id === product.id ? { ...p, name: fields.name, brand: fields.brand ?? "", verified: true, provisional: false } : p)),
        needsReviewQueue: s.needsReviewQueue.map((r) => (r.id === review.id ? { ...r, resolvedBy: "human" } : r)),
      }));
    });
    useScanStore.setState({ scanFeed: [event], needsReviewQueue: [review], products: [product], finalCounts: [], confirmRowIdentity } as never);

    render(<LiveScanFeed />);
    fireEvent.click(screen.getByTestId("approve-applied-ev1"));

    expect(confirmRowIdentity).toHaveBeenCalledWith("ev1", { name: "Michelin Defender LTX M/S 275/60R20", brand: "Michelin" });
    expect(screen.queryByTestId("approve-applied-ev1")).not.toBeInTheDocument();
    expect(screen.queryByText(/Suggested -/)).not.toBeInTheDocument();
    expect(screen.getByTestId("edit-product-ev1")).toBeInTheDocument();
  });

  it("a review whose decode the app VERIFIED but did not auto-save reads the high band (same rule as the inline path)", () => {
    const code = "0866990000789";
    const product = provisionalProduct("prod3", code);
    const event = baseEvent(code, product.id);
    const review = suggestionReview(code, 0.9, {
      decodeStatus: "verified", exactCodeEvidenceVerifiedByApp: false, status: "resolved", resolvedBy: "auto", provisionalProductId: product.id,
    });
    useScanStore.setState({ scanFeed: [event], needsReviewQueue: [review], products: [product], finalCounts: [] });

    render(<LiveScanFeed />);

    expect(screen.getByTestId("feed-product-ev1").textContent).toMatch(/Suggested - high confidence/);
  });

  // Deep-review findings (2026-08-19): even if some path auto-applied it, a one-tap Approve must never sit
  // on a name that is not ONE real product - the prefix-floor naming aid or a multi-variant listing.
  it.each([
    ["prefix-floor naming aid", "Acme / product unconfirmed"],
    ["multi-variant listing", "Nokian 205 50 R17 93V, 93W, 93H"],
  ])("an auto-applied %s shows the band but NO one-tap Approve (Edit stays)", (_label, name) => {
    const code = "0866990000999";
    const product = provisionalProduct("prod9", code);
    const event = baseEvent(code, product.id);
    const review = suggestionReview(code, 0.85, {
      suggestedProductName: name, status: "resolved", resolvedBy: "auto", provisionalProductId: product.id,
    });
    useScanStore.setState({ scanFeed: [event], needsReviewQueue: [review], products: [product], finalCounts: [] });

    render(<LiveScanFeed />);

    expect(screen.getByTestId("feed-product-ev1").textContent).toMatch(/Suggested - medium confidence/);
    expect(screen.queryByTestId("approve-applied-ev1")).not.toBeInTheDocument();
    expect(screen.getByTestId("edit-identity-ev1")).toBeInTheDocument();
  });

  it("a low-confidence review-derived suggestion shows the low band and no Approve (deliberate hold stays in review)", () => {
    const code = "0866990000456";
    const product = provisionalProduct("prod2", code);
    const event = baseEvent(code, product.id);
    const review = suggestionReview(code, 0.55);
    useScanStore.setState({ scanFeed: [event], needsReviewQueue: [review], products: [product], finalCounts: [] });

    render(<LiveScanFeed />);

    expect(screen.getByText(/Michelin Defender LTX/)).toBeInTheDocument();
    expect(screen.getByTestId("feed-product-ev1").textContent).toMatch(/Suggested - low confidence/);
    expect(screen.queryByText(/unconfirmed|%/)).not.toBeInTheDocument();
    expect(screen.queryByTestId("approve-applied-ev1")).not.toBeInTheDocument();
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
