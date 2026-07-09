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
