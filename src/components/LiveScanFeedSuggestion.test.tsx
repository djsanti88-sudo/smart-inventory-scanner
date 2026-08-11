import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LiveScanFeed } from "@/components/LiveScanFeed";
import ScanPage from "@/app/(app)/scan/page";
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

  it("the underlying suggested product name string never contains the literal '(suggested)' tag itself (UI-only badge, not baked into stored/displayed name)", () => {
    const event = {
      id: "ev1b", rawCode: "X004DY7YUT", cleanCode: "X004DY7YUT", matchedProductId: null, matchType: "unknown",
      status: "needs_review", quantityAfterScan: 0, decodeStatus: "suggested", reason: "Suggested, not trusted.",
      syncStatus: "synced", createdAt: Date.now(),
    } as unknown as ScanEvent;
    const review = {
      id: "rv1b", cleanCode: "X004DY7YUT", suggestedProductName: "NatureBell Magnesium Glycinate 500mg",
      suggestedPrimarySku: "", status: "open",
    } as unknown as UnknownCodeReview;
    useScanStore.setState({ scanFeed: [event], needsReviewQueue: [review], products: [], finalCounts: [] });

    render(<LiveScanFeed />);

    // The stored suggestion name itself is clean - "(suggested)" is rendered as a SEPARATE sibling
    // span (the status badge), never concatenated into the name string.
    expect(review.suggestedProductName).not.toContain("(suggested)");
    const nameCell = screen.getByTestId(`feed-product-${event.id}`);
    expect(nameCell.textContent).toContain("NatureBell Magnesium Glycinate 500mg");
    expect(nameCell.textContent).toContain("(suggested)");
    // The name and the "(suggested)" tag are rendered as separate DOM nodes (a text node + a
    // sibling <span>), never one concatenated name string - the tag element's OWN text is exactly
    // "(suggested)", not the product name plus the tag.
    const tagSpan = screen.getByText("(suggested)");
    expect(tagSpan.textContent).toBe("(suggested)");
    expect(tagSpan.textContent).not.toContain("NatureBell");
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

// Task 9b (owner-ratified 2026-07-14): inline suggestion approve/decline on the feed row.
// SCANNER SAFETY is test-enforced here: the ✓/✕ controls are tabIndex={-1} pointer targets with
// onMouseDown preventDefault, so clicking them NEVER moves focus off #scanner-input and a scanner
// Enter burst can never trigger them. Decode responses are mocked - no live provider is ever called.

const CODE9B = "0792080004312";

function suggested9bResponse(confidence = 0.3) {
  return {
    providerNames: ["gpt-5.5-ladder"],
    results: [
      {
        productName: "Original Anchor Bar Hot Sauce", brand: "Anchor Bar", category: "food",
        specsShort: "", specsFull: "", primarySku: "", primaryBarcode: "", gtin: "", upc: "", ean: "",
        aliases: [], imageUrl: "", productUrl: "", sourceUrls: ["https://go-upc.com/search?q=" + CODE9B],
        confidence, verifiedFacts: [], guesses: ["g"], needsHumanReview: true,
      },
    ],
    decision: {
      status: "suggested", confidence, reason: "Suggested", evidenceStrength: "none",
      exactCodeEvidenceVerifiedByApp: false,
      crossCheck: { decision: "single_provider", confidence, reason: "", brandSimilarity: 0, nameSimilarity: 0, contradictions: [] },
    },
  };
}

/** Enable aggressive auto-decode with a mocked fetch (GET status stays untouched; POST = suggested). */
function mockDecodeFetch() {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if ((init?.method ?? "GET").toUpperCase() !== "POST") {
      return { ok: false, json: async () => ({}) } as Response;
    }
    return { ok: true, json: async () => suggested9bResponse(0.3) } as Response;
  }) as unknown as typeof fetch;
  return () => (globalThis.fetch = original);
}

function enableAutoDecode() {
  useScanStore.setState((s) => ({
    // scanContext "any": this is the plain retail (hot sauce) case; the tire-context firewall and the
    // tire background-verify escalation keep their own (unchanged) review behavior and own tests.
    settings: { ...s.settings, aiLookupEnabled: true, scanContext: "any" },
    aiStatus: { ...s.aiStatus, openaiConfigured: true, liveEnabled: true, autoDecodeOnScan: true, emergencyStop: false },
    online: true,
  }));
}

describe("LiveScanFeed - Task 9b inline suggestion approve/decline (scanner-safe)", () => {
  it("approve: '(suggested, 30%)' tag + controls render; clicking ✓ keeps focus on the scan input, saves the approved alias, clears the tag", async () => {
    useScanStore.getState().clearLocalCache();
    const user = userEvent.setup();
    const restore = mockDecodeFetch();
    try {
      render(<ScanPage />);
      enableAutoDecode();
      const input = screen.getByTestId("scanner-input") as HTMLInputElement;
      await user.type(input, `${CODE9B}{Enter}`);

      // The decode settles async -> the row gains a PENDING inline suggestion.
      await vi.waitFor(() => {
        expect(useScanStore.getState().scanFeed.find((e) => e.cleanCode === CODE9B)?.suggestion?.status).toBe("pending");
      }, { timeout: 5_000 });
      const row = useScanStore.getState().scanFeed.find((e) => e.cleanCode === CODE9B)!;
      // Honest confidence copy, per the owner-ratified format.
      expect(screen.getByTestId(`feed-suggestion-${row.id}`).textContent).toContain("(suggested, 30%)");
      // No open Needs Review item was created for the suggestion.
      expect(useScanStore.getState().needsReviewQueue.filter((r) => r.status === "open")).toHaveLength(0);

      const approveBtn = screen.getByTestId(`approve-suggestion-${row.id}`);
      const declineBtn = screen.getByTestId(`decline-suggestion-${row.id}`);
      // SCANNER SAFETY: pointer-only targets, never in the tab/Enter path.
      expect(approveBtn.getAttribute("tabindex")).toBe("-1");
      expect(declineBtn.getAttribute("tabindex")).toBe("-1");
      expect(approveBtn.getAttribute("aria-label")).toBe("Approve Original Anchor Bar Hot Sauce");
      expect(declineBtn.getAttribute("aria-label")).toBe("Not this product");

      expect(input).toHaveFocus();
      await user.click(approveBtn);
      // Focus NEVER left the scan input (onMouseDown preventDefault) - the scanner keeps working.
      expect(input).toHaveFocus();

      // Approve went through the existing human-approval core: permanent approved alias.
      const alias = useScanStore.getState().aliases.find((a) => a.cleanCode === CODE9B);
      expect(alias?.approved).toBe(true);
      // The tag + controls are gone (suggestion settled).
      expect(screen.queryByTestId(`feed-suggestion-${row.id}`)).toBeNull();

      // Rescan: deterministic-known via the approved alias, still focused, no extra review.
      await user.type(input, `${CODE9B}{Enter}`);
      expect(input).toHaveFocus();
      expect(useScanStore.getState().scanFeed[0].matchType).not.toBe("unknown");
    } finally {
      restore();
      useScanStore.getState().clearLocalCache();
    }
  });

  it("decline: clicking ✕ keeps focus on the scan input, renames the row to the safe placeholder, and ONLY THEN opens the review", async () => {
    useScanStore.getState().clearLocalCache();
    const user = userEvent.setup();
    const restore = mockDecodeFetch();
    try {
      render(<ScanPage />);
      enableAutoDecode();
      const input = screen.getByTestId("scanner-input") as HTMLInputElement;
      await user.type(input, `${CODE9B}{Enter}`);
      await vi.waitFor(() => {
        expect(useScanStore.getState().scanFeed.find((e) => e.cleanCode === CODE9B)?.suggestion?.status).toBe("pending");
      }, { timeout: 5_000 });
      const row = useScanStore.getState().scanFeed.find((e) => e.cleanCode === CODE9B)!;

      expect(input).toHaveFocus();
      await user.click(screen.getByTestId(`decline-suggestion-${row.id}`));
      expect(input).toHaveFocus(); // scanner safety holds on decline too

      const st = useScanStore.getState();
      expect(st.scanFeed.find((e) => e.id === row.id)?.suggestion?.status).toBe("declined");
      // Decline is the only suggestion path that creates a review - and it is OPEN with the honest reason.
      const open = st.needsReviewQueue.filter((r) => r.status === "open");
      expect(open).toHaveLength(1);
      expect(open[0].reason).toContain("Suggestion declined");
      // The counted row never keeps the declined identity.
      const prod = st.products.find((p) => p.id === row.matchedProductId)!;
      expect(prod.name).not.toContain("Anchor Bar");
      expect(prod.verified).toBe(false);
      // The count itself survives (count-decouple: the physical item is still on the shelf).
      expect(st.finalCounts.some((c) => c.productId === row.matchedProductId)).toBe(true);
    } finally {
      restore();
      useScanStore.getState().clearLocalCache();
    }
  });
});
