import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { useScanStore } from "@/stores/scanStore";
import { NeedsReviewTable } from "@/review/NeedsReviewTable";
import type { Product, UnknownCodeReview } from "@/types";

// QA 2026-07-15 issue 3: "Approve suggestion" silently did nothing when the decode fuzzily matched
// an existing product. resolveUnknown's suggest_link branch attaches suggestedLinkProductId and
// keeps the review open, but no UI ever rendered that suggestion - the button stayed clickable and
// every click was a silent no-op. The fix renders a one-tap "Link to <product>" action (through the
// existing human-approved link_existing path) whenever suggestedLinkProductId is set.

const existing: Product = {
  id: "p-existing", businessId: "b1", name: "Voltrek GX9 265/70R17", brand: "Zephyra", category: "Tire",
  specsShort: "265/70R17", specsFull: "", primarySku: "VGX9", primaryBarcode: "111111111116", gtin: "", upc: "", ean: "",
  vendorCodes: [], aliases: ["111111111116"], imageUrl: "", productUrl: "", location: "", notes: "",
  status: "active", source: "human_review", confidence: 1, verified: true,
  createdAt: "", updatedAt: "", createdBy: "human", updatedBy: "human",
};

function makeReview(overrides: Partial<UnknownCodeReview> = {}): UnknownCodeReview {
  return {
    id: "r1", businessId: "b1", sessionId: "s1", rawCode: "222222222220", cleanCode: "222222222220",
    normalizedCandidates: ["222222222220"],
    suggestedProductName: "Voltrek GX9 265/70R17", suggestedBrand: "Zephyra", suggestedCategory: "Tire",
    suggestedSpecsShort: "", suggestedSpecsFull: "", suggestedPrimarySku: "", suggestedPrimaryBarcode: "",
    suggestedGtin: "", suggestedUpc: "", suggestedEan: "", suggestedImageUrl: "", suggestedProductUrl: "",
    suggestedAliases: [], sourceUrls: [], verifiedFacts: [], guesses: [],
    reason: "Suggested, not trusted.", providerName: "mock", confidence: 0.7,
    hasSuggestion: true, decodeStatus: "suggested", evidenceStrength: "none",
    exactCodeEvidenceVerifiedByApp: false, crossCheckDecision: "",
    status: "open", createdAt: "", resolvedAt: null, resolvedBy: null, resolutionAction: null,
    syncStatus: "pending", idempotencyKey: "b1:s1:evt-r1:222222222220",
    ...overrides,
  };
}

function seed(review: UnknownCodeReview) {
  useScanStore.setState({
    businessId: "b1",
    products: [existing],
    aliases: [],
    finalCounts: [],
    needsReviewQueue: [review],
    lastAliasConflicts: [],
  });
}

afterEach(() => cleanup());

describe("NeedsReviewTable - suggest_link one-tap action (QA issue 3)", () => {
  it("renders a one-tap 'Link to <product>' button instead of the dead Approve button when suggestedLinkProductId is set", () => {
    seed(makeReview({ suggestedLinkProductId: existing.id }));
    render(<NeedsReviewTable />);

    const linkBtn = screen.getByTestId("link-suggested");
    expect(linkBtn).toBeInTheDocument();
    expect(linkBtn.textContent).toMatch(/Voltrek GX9/i);
    // The generic Approve path would silently no-op on this review, so it must not be offered.
    expect(screen.queryByTestId("approve-suggestion")).not.toBeInTheDocument();
    // A visible explanation so the operator knows why linking (not creating) is offered.
    expect(screen.getByTestId("suggest-link-note").textContent).toMatch(/already in your (list|inventory|products)/i);
  });

  it("clicking the one-tap link resolves the review through link_existing (alias learned, review closed)", () => {
    seed(makeReview({ suggestedLinkProductId: existing.id }));
    render(<NeedsReviewTable />);

    fireEvent.click(screen.getByTestId("link-suggested"));

    const st = useScanStore.getState();
    const review = st.needsReviewQueue.find((r) => r.id === "r1")!;
    expect(review.status, "review no longer open after one-tap link").toBe("resolved");
    expect(review.resolutionAction).toBe("link_existing");
    const alias = st.aliases.find((a) => a.cleanCode === "222222222220");
    expect(alias, "scanned code learned as alias on the existing product").toBeDefined();
    expect(alias!.productId).toBe(existing.id);
    expect(alias!.approved).toBe(true);
  });

  it("still renders the normal Approve suggestion button when no suggestedLinkProductId is set", () => {
    seed(makeReview());
    render(<NeedsReviewTable />);
    expect(screen.getByTestId("approve-suggestion")).toBeInTheDocument();
    expect(screen.queryByTestId("link-suggested")).not.toBeInTheDocument();
  });

  it("falls back to the Approve button when the suggested link product no longer exists", () => {
    seed(makeReview({ suggestedLinkProductId: "gone-product" }));
    render(<NeedsReviewTable />);
    expect(screen.getByTestId("approve-suggestion")).toBeInTheDocument();
    expect(screen.queryByTestId("link-suggested")).not.toBeInTheDocument();
  });
});
