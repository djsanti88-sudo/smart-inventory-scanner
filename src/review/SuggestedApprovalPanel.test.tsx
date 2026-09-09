import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { useScanStore } from "@/stores/scanStore";
import { SuggestedApprovalPanel } from "@/review/SuggestedApprovalPanel";
import type { UnknownCodeReview } from "@/types";

// Build 3 review Finding 3 (Low): a Suggested row with ZERO sourceUrls carries no evidence at all.
// Bulk approvers scanning a long list can miss that, so a visible "No sources" marker must render for
// any source-less row (and must NOT render for a row that has a source).

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

describe("SuggestedApprovalPanel - no-sources marker (Build 3 review Finding 3)", () => {
  it("renders a visible 'No sources' marker for a row with zero sourceUrls", () => {
    useScanStore.setState({
      needsReviewQueue: [
        review({
          id: "nosrc1",
          cleanCode: "4000000000001",
          hasSuggestion: true,
          suggestedProductName: "Evidence-less Widget",
          sourceUrls: [],
        }),
      ],
    });
    render(<SuggestedApprovalPanel />);
    expect(screen.queryByTestId("suggested-no-sources-4000000000001")).not.toBeNull();
  });

  it("does NOT render the marker for a row that has a source URL", () => {
    useScanStore.setState({
      needsReviewQueue: [
        review({
          id: "hassrc1",
          cleanCode: "5000000000002",
          hasSuggestion: true,
          suggestedProductName: "Sourced Widget",
          sourceUrls: ["https://example.com/sourced-widget"],
        }),
      ],
    });
    render(<SuggestedApprovalPanel />);
    expect(screen.queryByTestId("suggested-no-sources-5000000000002")).toBeNull();
  });
});
