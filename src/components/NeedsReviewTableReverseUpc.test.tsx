import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { UnknownCodeReview } from "@/types";

// The reverse-UPC conflict note is an INTERNAL platformOwner diagnostic. platformOwner must see it;
// business/customer users must NOT (same gate as the other internal hints like the prefix firewall).

let mockPlatform = true;
vi.mock("@/services/security/useAccessLevel", () => ({
  useIsPlatformOwner: () => mockPlatform,
  useAccessLevel: () => (mockPlatform ? "platform" : "customer"),
}));

import { NeedsReviewTable } from "@/components/NeedsReviewTable";
import { useScanStore } from "@/stores/scanStore";

const reviewWithNote = {
  id: "rv-1",
  rawCode: "555000555000",
  cleanCode: "555000555000",
  status: "open",
  suggestedProductName: "Acme Widget",
  reverseUpcConflictNote: "Already in your catalog under: 012345678905",
  decodeStatus: "needs_review",
  hasSuggestion: true,
} as unknown as UnknownCodeReview;

afterEach(() => {
  cleanup();
  useScanStore.setState({ needsReviewQueue: [] });
});

describe("NeedsReviewTable - reverse-UPC heads-up visibility", () => {
  it("platformOwner SEES the reverse-UPC conflict note", () => {
    mockPlatform = true;
    useScanStore.setState({ needsReviewQueue: [reviewWithNote] });
    render(<NeedsReviewTable />);
    // sanity: the row rendered
    expect(screen.getByText("Acme Widget"), "review row is shown").toBeTruthy();
    expect(screen.getByTestId("reverse-upc-conflict"), "owner sees the warning badge").toBeTruthy();
    expect(screen.getByText(/Already in your catalog under: 012345678905/)).toBeTruthy();
  });

  it("business user does NOT see the reverse-UPC note (internal diagnostic hidden)", () => {
    mockPlatform = false;
    useScanStore.setState({ needsReviewQueue: [reviewWithNote] });
    render(<NeedsReviewTable />);
    expect(screen.queryByTestId("reverse-upc-conflict"), "business user does not see the internal warning").toBeNull();
    expect(screen.queryByText(/Already in your catalog under/), "the diagnostic text is hidden from business users").toBeNull();
  });
});
