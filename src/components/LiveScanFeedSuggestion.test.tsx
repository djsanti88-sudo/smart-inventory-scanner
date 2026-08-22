import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LiveScanFeed } from "@/components/LiveScanFeed";
import ScanPage from "@/app/(app)/scan/page";
import { useScanStore } from "@/stores/scanStore";
import type { Alias, ScanEvent, UnknownCodeReview, Product } from "@/types";

// PHASE 1 (Suggested display, no count): a weak-source non-public scan (e.g. X004DY7YUT) that did NOT count
// must show its decoded suggested product name on the scan FEED row instead of "Product: -", tagged
// with the app-derived band ("Suggested - low confidence"), while still NOT being counted. Read-only UI; no alias, no verified product, no count.

afterEach(() => {
  cleanup();
  useScanStore.setState({ scanFeed: [], needsReviewQueue: [], products: [], finalCounts: [] });
});

describe("LiveScanFeed - Suggested display (Phase 1)", () => {
  it("shows the decoded suggestion name on a non-counted Suggested row, tagged with the low band, not '-'", () => {
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
    expect(screen.getByText("(Suggested - low confidence)"), "row marked as a suggestion").toBeTruthy();
    // PHASE 1 guarantee: it is NOT counted.
    expect(useScanStore.getState().finalCounts, "Phase 1 shows but does not count").toHaveLength(0);
  });

  it("the underlying suggested product name string never contains the band tag itself (UI-only badge, not baked into stored/displayed name)", () => {
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

    // The stored suggestion name itself is clean - the band tag is rendered as a SEPARATE sibling
    // span (the status badge), never concatenated into the name string.
    expect(review.suggestedProductName).not.toContain("Suggested -");
    const nameCell = screen.getByTestId(`feed-product-${event.id}`);
    expect(nameCell.textContent).toContain("NatureBell Magnesium Glycinate 500mg");
    expect(nameCell.textContent).toContain("(Suggested - low confidence)");
    // The name and the band tag are rendered as separate DOM nodes (a text node + a sibling
    // <span>), never one concatenated name string - the tag element's OWN text is exactly the
    // band, not the product name plus the tag.
    const tagSpan = screen.getByText("(Suggested - low confidence)");
    expect(tagSpan.textContent).toBe("(Suggested - low confidence)");
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
    expect(screen.queryByText(/Suggested -/), "a real counted product is not tagged suggested").toBeNull();
  });
});

// Task 9b (owner-ratified 2026-07-14): inline suggestion approve/decline on the feed row.
// SCANNER SAFETY is test-enforced here: the ✓/✕ controls are tabIndex={-1} pointer targets with
// onMouseDown preventDefault, so clicking them NEVER moves focus off #scanner-input and a scanner
// Enter burst can never trigger them. Decode responses are mocked - no live provider is ever called.

const CODE9B = "0792080004312";

function suggested9bResponse(confidence = 0.3) {
  return {
    providerNames: ["gpt-5.4-mini"],
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
      });
      const row = useScanStore.getState().scanFeed.find((e) => e.cleanCode === CODE9B)!;
      // Owner decision 2026-08-19: an app-derived band, never a raw provider percentage.
      const tag = screen.getByTestId(`feed-suggestion-${row.id}`).textContent ?? "";
      expect(tag).toContain("Suggested - low confidence");
      expect(tag).not.toContain("%");
      // The raw number is still on the event for audit.
      expect(row.suggestion?.confidence).toBeCloseTo(0.3);
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
      // Approve and Edit sit together on a suggested row; Edit opens the confirm sheet, never a
      // separate umbrella action.
      expect(screen.queryByTestId(`edit-identity-${row.id}`), "Edit is gone with the settled suggestion").toBeNull();
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
      });
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

// Best-guess identity row controls (owner decision 2026-08-19). Three DISTINCT operations wired by row
// state: confirm identity (tenant alias), edit metadata (product fields only), reassign (count transfer).

/** A WEAK decode: honest status "needs_review", but with a usable name worth showing. */
function weakResponse() {
  const r = suggested9bResponse(0.3);
  return { ...r, decision: { ...r.decision, status: "needs_review" } };
}

function seedRow(over: Partial<ScanEvent> = {}, product?: Partial<Product>) {
  const event = {
    id: "row1", rawCode: "078742051451", cleanCode: "078742051451", matchedProductId: product ? "p1" : null,
    matchType: "barcode", status: product ? "known" : "needs_review", quantityAfterScan: product ? 1 : 0,
    reason: "", syncStatus: "synced", createdAt: Date.now(), ...over,
  } as unknown as ScanEvent;
  useScanStore.setState({
    scanFeed: [event], needsReviewQueue: [], finalCounts: [],
    products: product ? [{ id: "p1", name: "Purified Water 500ml", brand: "Member's Mark", primarySku: "", ...product } as unknown as Product] : [],
  });
  return event;
}

describe("LiveScanFeed - row identity controls by state", () => {
  it("a weak (needs_review) decode with a usable name shows the name, the band, Approve and Edit - and no percentage", async () => {
    useScanStore.getState().clearLocalCache();
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_u: unknown, init?: RequestInit) =>
      ((init?.method ?? "GET").toUpperCase() !== "POST"
        ? { ok: false, json: async () => ({}) }
        : { ok: true, json: async () => weakResponse() }) as Response,
    ) as unknown as typeof fetch;
    const user = userEvent.setup();
    try {
      render(<ScanPage />);
      enableAutoDecode();
      const input = screen.getByTestId("scanner-input") as HTMLInputElement;
      await user.type(input, `${CODE9B}{Enter}`);
      await vi.waitFor(() => {
        expect(useScanStore.getState().scanFeed.find((e) => e.cleanCode === CODE9B)?.suggestion?.status).toBe("pending");
      });
      const row = useScanStore.getState().scanFeed.find((e) => e.cleanCode === CODE9B)!;

      expect(screen.getByTestId(`feed-product-${row.id}`).textContent).toContain("Original Anchor Bar Hot Sauce");
      const tag = screen.getByTestId(`feed-suggestion-${row.id}`).textContent ?? "";
      expect(tag).toContain("Suggested - low confidence");
      expect(tag).not.toContain("%");
      expect(screen.getByTestId(`approve-suggestion-${row.id}`)).toBeTruthy();
      const edit = screen.getByTestId(`edit-identity-${row.id}`);
      expect(edit.getAttribute("tabindex"), "scanner safety").toBe("-1");
      // Opening the sheet never steals focus from the scan input.
      expect(input).toHaveFocus();
      await user.click(edit);
      expect(input).toHaveFocus();
      expect(screen.getByTestId(`identity-sheet-${row.id}`)).toBeTruthy();
    } finally {
      globalThis.fetch = original;
      useScanStore.getState().clearLocalCache();
    }
  });

  it("a verified row offers Edit (metadata) and never Approve", () => {
    const event = seedRow({ decodeStatus: "verified" }, { verified: true, provisional: false });
    render(<LiveScanFeed />);
    expect(screen.getByTestId(`edit-product-${event.id}`)).toBeTruthy();
    expect(screen.queryByTestId(`approve-suggestion-${event.id}`)).toBeNull();
  });

  it("editing a verified row changes product fields only - the alias is untouched", async () => {
    const user = userEvent.setup();
    const event = seedRow({ decodeStatus: "verified" }, { verified: true, provisional: false });
    useScanStore.setState({
      aliases: [{ id: "a1", productId: "p1", cleanCode: event.cleanCode, approved: true, confidence: 1 } as unknown as Alias],
    });
    render(<LiveScanFeed />);

    await user.click(screen.getByTestId(`edit-product-${event.id}`));
    const name = screen.getByTestId(`identity-name-${event.id}`);
    expect((name as HTMLInputElement).value, "metadata edit opens on the current product fields").toBe("Purified Water 500ml");
    await user.clear(name);
    await user.type(name, "Spring Water 500ml");
    await user.click(screen.getByTestId(`identity-save-${event.id}`));

    const st = useScanStore.getState();
    expect(st.products.find((p) => p.id === "p1")?.name).toBe("Spring Water 500ml");
    expect(st.aliases).toHaveLength(1);
    expect(st.aliases[0].approved, "metadata edits never touch alias trust").toBe(true);
    expect(st.aliases[0].productId).toBe("p1");
  });

  it("an unidentified row offers Identify, and confirming a typed identity teaches a tenant approved alias", async () => {
    useScanStore.getState().clearLocalCache();
    const user = userEvent.setup();
    try {
      render(<ScanPage />);
      const input = screen.getByTestId("scanner-input") as HTMLInputElement;
      // AI off: the scan counts as an unidentified provisional row with an open review (no decode).
      await user.type(input, `${CODE9B}{Enter}`);
      const row = useScanStore.getState().scanFeed.find((e) => e.cleanCode === CODE9B)!;
      expect(row.suggestion, "no guess to show").toBeUndefined();

      await user.click(screen.getByTestId(`identify-row-${row.id}`));
      expect(input, "identify never steals scanner focus").toHaveFocus();
      const nameInput = screen.getByTestId(`identity-name-${row.id}`) as HTMLInputElement;
      expect(nameInput.value, "no guess to prefill - a placeholder label is not an identity").toBe("");
      await user.type(nameInput, "Buffalo Wing Sauce 12oz");
      await user.click(screen.getByTestId(`identity-save-${row.id}`));

      const st = useScanStore.getState();
      const alias = st.aliases.find((a) => a.cleanCode === CODE9B);
      expect(alias?.approved).toBe(true);
      expect(st.products.find((p) => p.id === alias?.productId)?.name).toBe("Buffalo Wing Sauce 12oz");
    } finally {
      useScanStore.getState().clearLocalCache();
    }
  });

  it("Reassign is a two-tap confirm that names the blast radius: the first tap moves nothing, the second moves every counted unit of the product", async () => {
    const user = userEvent.setup();
    // markWrong is PRODUCT-scoped: it moves EVERY counted unit of the product, not just this row's.
    // Seed 3 units across 2 feed rows of the same product so the confirm copy has to say so.
    const rowA = {
      id: "rowA", rawCode: "078742051451", cleanCode: "078742051451", matchedProductId: "p1", matchType: "barcode",
      status: "known", quantityAfterScan: 2, decodeStatus: "verified", reason: "", syncStatus: "synced", createdAt: Date.now(),
    } as unknown as ScanEvent;
    const rowB = { ...rowA, id: "rowB", quantityAfterScan: 3 } as ScanEvent;
    useScanStore.setState({
      scanFeed: [rowB, rowA],
      needsReviewQueue: [],
      products: [{ id: "p1", name: "Purified Water 500ml", brand: "Member's Mark", primarySku: "", verified: true, provisional: false, primaryBarcode: "078742051451" } as unknown as Product],
      finalCounts: [{ id: "c1", businessId: "b", sessionId: "s", productId: "p1", quantity: 3, scanEventIds: [rowA.id, rowB.id], aliasesSeen: [rowA.cleanCode] } as never],
    });
    render(<LiveScanFeed />);

    const arm = screen.getByTestId(`reassign-${rowA.id}`);
    expect(arm.getAttribute("tabindex"), "scanner safety").toBe("-1");
    await user.click(arm);

    // FIRST TAP MOVES NOTHING - it only arms a confirm that states the real blast radius.
    expect(useScanStore.getState().finalCounts.find((c) => c.productId === "p1")?.quantity).toBe(3);
    const confirm = screen.getByTestId(`reassign-confirm-${rowA.id}`);
    expect(confirm.textContent).toContain("Move 3 units?");
    expect(confirm.getAttribute("tabindex"), "scanner safety").toBe("-1");

    await user.click(confirm);
    await vi.waitFor(() => {
      expect(useScanStore.getState().finalCounts.some((c) => c.productId === "p1")).toBe(false);
    });
    const st = useScanStore.getState();
    // All 3 units moved (the documented product-scoped semantic), none were deleted, and both scan
    // events survive.
    expect(st.finalCounts.reduce((n, c) => n + c.quantity, 0)).toBe(3);
    expect(st.scanFeed.some((e) => e.id === rowA.id)).toBe(true);
    expect(st.scanFeed.some((e) => e.id === rowB.id)).toBe(true);
  });

  it("the armed Reassign confirm is cancelled by Escape, and never steals the scanner's focus", async () => {
    useScanStore.getState().clearLocalCache();
    const user = userEvent.setup();
    try {
      render(<ScanPage />);
      const input = screen.getByTestId("scanner-input") as HTMLInputElement;
      // AI off: the scan counts one unit onto its own provisional row.
      await user.type(input, `${CODE9B}{Enter}`);
      const row = useScanStore.getState().scanFeed.find((e) => e.cleanCode === CODE9B)!;

      expect(input).toHaveFocus();
      await user.click(screen.getByTestId(`reassign-${row.id}`));
      expect(input, "arming never moves focus off the scanner").toHaveFocus();
      expect(screen.getByTestId(`reassign-confirm-${row.id}`).textContent).toContain("Move 1 unit?");

      await user.keyboard("{Escape}");
      expect(screen.queryByTestId(`reassign-confirm-${row.id}`), "Escape disarms").toBeNull();
      expect(useScanStore.getState().finalCounts.reduce((n, c) => n + c.quantity, 0)).toBe(1);
    } finally {
      useScanStore.getState().clearLocalCache();
    }
  });

  it("a counted-nothing row offers no Reassign at all (there is no quantity to move)", () => {
    const event = seedRow({ decodeStatus: "verified" }, { verified: true, provisional: false });
    useScanStore.setState({ finalCounts: [] });
    render(<LiveScanFeed />);
    expect(screen.queryByTestId(`reassign-${event.id}`)).toBeNull();
  });
});
