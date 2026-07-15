import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { useScanStore } from "@/stores/scanStore";
import { NeedsReviewTable } from "@/components/NeedsReviewTable";
import type { UnknownCodeReview } from "@/types";

function review(over: Partial<UnknownCodeReview>): UnknownCodeReview {
  return {
    id: "r", businessId: "b", sessionId: "s", rawCode: "111", cleanCode: "111",
    normalizedCandidates: [], suggestedProductName: "", suggestedBrand: "", suggestedCategory: "",
    suggestedSpecsShort: "", suggestedSpecsFull: "", suggestedPrimarySku: "", suggestedPrimaryBarcode: "",
    suggestedGtin: "", suggestedUpc: "", suggestedEan: "", suggestedImageUrl: "", suggestedProductUrl: "",
    suggestedAliases: [], sourceUrls: [], verifiedFacts: [], guesses: [], reason: "unknown", decodeNote: "",
    providerName: "", confidence: 0, hasSuggestion: false, decodeStatus: "needs_review", evidenceStrength: "none",
    exactCodeEvidenceVerifiedByApp: false, crossCheckDecision: "", status: "open", createdAt: "",
    resolvedAt: null, resolvedBy: null, resolutionAction: null, syncStatus: "pending", idempotencyKey: "k",
    ...over,
  };
}

afterEach(() => {
  cleanup();
  delete process.env.NEXT_PUBLIC_E2E_PLATFORM_OWNER;
});

describe("NeedsReviewTable - Barcode column visible to all roles (Task 4)", () => {
  it("shows a Barcode column header and the code text for a non-platformOwner role", () => {
    delete process.env.NEXT_PUBLIC_E2E_PLATFORM_OWNER;
    useScanStore.setState({
      needsReviewQueue: [
        review({ id: "bc1", cleanCode: "086699998538", status: "open", syncStatus: "pending" }),
      ],
    });
    render(<NeedsReviewTable />);
    expect(screen.getByText("Barcode")).not.toBeNull();
    expect(screen.getByTestId("review-barcode")).toHaveTextContent("086699998538");
  });
});

describe("NeedsReviewTable - prettifies product dropdown labels (Task 5)", () => {
  it("shows a Title Case option label for a corpus-slug product name", () => {
    useScanStore.setState({
      needsReviewQueue: [review({ id: "pd1", cleanCode: "086699998600", status: "open", syncStatus: "pending" })],
      products: [{ id: "prod-slug", name: "wrangler_workhorse_at" } as unknown as import("@/types").Product],
    });
    render(<NeedsReviewTable />);
    expect(screen.getByRole("option", { name: "Wrangler Workhorse AT" })).toBeInTheDocument();
  });
});

describe("NeedsReviewTable - Task 9 copy fix (no bogus demotion on a verified decode)", () => {
  it("does NOT show 'Confidence too low to save automatically' when the decode was VERIFIED (the hot-sauce 90% incident)", () => {
    // Real incident: an app-verified 90% off-category decode rendered a bogus "50/100" demotion. A verified
    // decode's confidence is honest - the "too low to save" copy must be suppressed for decodeStatus verified.
    useScanStore.setState({
      needsReviewQueue: [
        review({ id: "v1", cleanCode: "0792080004312", status: "open", syncStatus: "pending", decodeStatus: "verified", autoVerifyScore: 50 }),
      ],
    });
    render(<NeedsReviewTable />);
    expect(screen.queryByTestId("review-score")).toBeNull();
  });

  it("STILL shows the demotion copy for a NON-verified decode that scored below the auto-save bar", () => {
    useScanStore.setState({
      needsReviewQueue: [
        review({ id: "nv1", cleanCode: "0000000000001", status: "open", syncStatus: "pending", decodeStatus: "needs_review", autoVerifyScore: 50 }),
      ],
    });
    render(<NeedsReviewTable />);
    expect(screen.getByTestId("review-score")).toHaveTextContent("50/100");
  });
});

describe("NeedsReviewTable - hide solved+synced (owner rule)", () => {
  it("hides an item that is resolved AND synced, keeps open items", () => {
    useScanStore.setState({
      needsReviewQueue: [
        review({ id: "open1", cleanCode: "1000000000001", status: "open", syncStatus: "pending" }),
        review({ id: "done1", cleanCode: "2000000000002", status: "resolved", syncStatus: "synced" }),
      ],
    });
    render(<NeedsReviewTable />);
    expect(screen.queryByTestId("review-row-1000000000001")).not.toBeNull(); // open -> shown
    expect(screen.queryByTestId("review-row-2000000000002")).toBeNull(); // resolved+synced -> hidden
  });

  it("keeps a resolved item that is NOT yet synced (nothing looks lost before it saves)", () => {
    useScanStore.setState({
      needsReviewQueue: [
        review({ id: "pend1", cleanCode: "3000000000003", status: "resolved", syncStatus: "pending" }),
      ],
    });
    render(<NeedsReviewTable />);
    expect(screen.queryByTestId("review-row-3000000000003")).not.toBeNull(); // resolved but pending sync -> still shown
  });
});
