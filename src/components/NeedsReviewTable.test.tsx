import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
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

describe("NeedsReviewTable - product linking", () => {
  it("links the exact 855724007602 Coca-Cola review through the current accessible picker", () => {
    const resolveUnknown = vi.fn();
    useScanStore.setState({
      needsReviewQueue: [review({ id: "coke-855", cleanCode: "855724007602", status: "open", syncStatus: "pending" })],
      products: [{ id: "prod-coke", name: "Coca-Cola 12 pack 12 oz cans" }] as unknown as import("@/types").Product[],
      resolveUnknown,
    });
    render(<NeedsReviewTable />);

    fireEvent.click(screen.getByTestId("choose-product-coke-855"));
    const search = screen.getByRole("combobox", { name: "Search products" });
    fireEvent.change(search, { target: { value: "coca" } });
    fireEvent.click(screen.getByRole("option", { name: "Coca-Cola 12 pack 12 oz cans" }));
    fireEvent.click(screen.getByTestId("link-existing"));

    expect(resolveUnknown).toHaveBeenCalledWith("coke-855", "link_existing", {
      productId: "prod-coke",
      applyToCount: true,
      selectedAliasCodes: [],
    });
  });

  it("shows a searchable, prettified product picker only after the operator chooses to link", () => {
    useScanStore.setState({
      needsReviewQueue: [review({ id: "pd1", cleanCode: "086699998600", status: "open", syncStatus: "pending" })],
      products: [{ id: "prod-slug", name: "wrangler_workhorse_at" } as unknown as import("@/types").Product],
    });
    render(<NeedsReviewTable />);
    expect(screen.queryByRole("option", { name: "Wrangler Workhorse AT" })).toBeNull();
    fireEvent.click(screen.getByTestId("choose-product-pd1"));
    expect(screen.getByRole("combobox", { name: "Search products" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Wrangler Workhorse AT" })).toBeInTheDocument();
  });

  it("filters product choices, links the selected product through the existing resolution payload, and can cancel", () => {
    const resolveUnknown = vi.fn();
    useScanStore.setState({
      needsReviewQueue: [review({ id: "link-1", cleanCode: "LINK-1" })],
      products: [
        { id: "prod-wrangler", name: "wrangler_workhorse_at" },
        { id: "prod-other", name: "all_weather_grip" },
      ] as unknown as import("@/types").Product[],
      resolveUnknown,
    });
    render(<NeedsReviewTable />);

    fireEvent.click(screen.getByTestId("choose-product-link-1"));
    const search = screen.getByRole("combobox", { name: "Search products" });
    fireEvent.change(search, { target: { value: "wrangler" } });
    expect(screen.getByRole("option", { name: "Wrangler Workhorse AT" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "All Weather Grip" })).toBeNull();

    fireEvent.click(screen.getByRole("option", { name: "Wrangler Workhorse AT" }));
    fireEvent.click(screen.getByTestId("link-existing"));
    expect(resolveUnknown).toHaveBeenCalledWith("link-1", "link_existing", {
      productId: "prod-wrangler",
      applyToCount: true,
      selectedAliasCodes: [],
    });

    fireEvent.click(screen.getByTestId("choose-product-link-1"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel product selection" }));
    expect(screen.queryByTestId("product-picker")).toBeNull();
  });

  it("supports Arrow keys, Enter, and Escape with accurate active-descendant state", () => {
    useScanStore.setState({
      needsReviewQueue: [review({ id: "keys-1", cleanCode: "KEYS-1" })],
      products: [
        { id: "prod-one", name: "first_product" },
        { id: "prod-two", name: "second_product" },
      ] as unknown as import("@/types").Product[],
    });
    render(<NeedsReviewTable />);

    fireEvent.click(screen.getByTestId("choose-product-keys-1"));
    const search = screen.getByRole("combobox", { name: "Search products" });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    const firstOption = screen.getByRole("option", { name: "First Product" });
    expect(search).toHaveAttribute("aria-activedescendant", firstOption.id);
    expect(firstOption).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(search).toHaveAttribute("aria-activedescendant", screen.getByRole("option", { name: "Second Product" }).id);
    fireEvent.keyDown(search, { key: "Enter" });
    expect(screen.queryByTestId("product-picker")).toBeNull();

    fireEvent.click(screen.getByTestId("choose-product-keys-1"));
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search products" }), { key: "Escape" });
    expect(screen.queryByTestId("product-picker")).toBeNull();
  });

  it("gives concurrently open pickers unique listbox and active-option IDs", () => {
    useScanStore.setState({
      needsReviewQueue: [
        review({ id: "picker-a", cleanCode: "PICKER-A" }),
        review({ id: "picker-b", cleanCode: "PICKER-B" }),
      ],
      products: [
        { id: "shared-product", name: "shared_product" },
        { id: "other-product", name: "other_product" },
      ] as unknown as import("@/types").Product[],
    });
    render(<NeedsReviewTable />);

    fireEvent.click(screen.getByTestId("choose-product-picker-a"));
    fireEvent.click(screen.getByTestId("choose-product-picker-b"));
    const [firstPicker, secondPicker] = screen.getAllByRole("combobox", { name: "Search products" });
    const firstListId = firstPicker.getAttribute("aria-controls");
    const secondListId = secondPicker.getAttribute("aria-controls");

    expect(firstListId).toBeTruthy();
    expect(secondListId).toBeTruthy();
    expect(firstListId).not.toBe(secondListId);
    expect(document.getElementById(firstListId!)).toHaveAttribute("role", "listbox");
    expect(document.getElementById(secondListId!)).toHaveAttribute("role", "listbox");

    fireEvent.keyDown(firstPicker, { key: "ArrowDown" });
    fireEvent.keyDown(secondPicker, { key: "ArrowDown" });
    const firstActiveId = firstPicker.getAttribute("aria-activedescendant");
    const secondActiveId = secondPicker.getAttribute("aria-activedescendant");
    expect(firstActiveId).toBeTruthy();
    expect(secondActiveId).toBeTruthy();
    expect(firstActiveId).not.toBe(secondActiveId);
    expect(document.getElementById(firstActiveId!)).toHaveAttribute("aria-selected", "true");
    expect(document.getElementById(secondActiveId!)).toHaveAttribute("aria-selected", "true");
  });
});

describe("NeedsReviewTable - review queue scaling", () => {
  it("bounds initial rendering, does not multiply catalog options by review rows, and reaches every open review", () => {
    const reviews = Array.from({ length: 100 }, (_, index) =>
      review({ id: `scale-${index + 1}`, cleanCode: `SCALE-${index + 1}` }),
    );
    const products = Array.from({ length: 12 }, (_, index) => ({
      id: `product-${index + 1}`,
      name: `catalog_product_${index + 1}`,
    })) as unknown as import("@/types").Product[];
    useScanStore.setState({ needsReviewQueue: reviews, products });

    render(<NeedsReviewTable />);

    expect(screen.getAllByTestId(/review-row-SCALE-/)).toHaveLength(25);
    expect(screen.queryAllByRole("option")).toHaveLength(0);

    for (let page = 1; page < 4; page += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Next reviews" }));
    }

    expect(screen.getByTestId("review-row-SCALE-100")).toBeInTheDocument();
    expect(screen.getByText("100 reviews")).toBeInTheDocument();
  });

  it("normalizes the stored page after the queue shrinks so one Previous click reaches the first page", async () => {
    const reviews = Array.from({ length: 100 }, (_, index) =>
      review({ id: `shrink-${index + 1}`, cleanCode: `SHRINK-${index + 1}` }),
    );
    useScanStore.setState({ needsReviewQueue: reviews });
    render(<NeedsReviewTable />);

    for (let page = 1; page < 4; page += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Next reviews" }));
    }
    await act(async () => {
      useScanStore.setState({ needsReviewQueue: reviews.slice(0, 26) });
    });

    expect(screen.getByTestId("review-row-SHRINK-26")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Previous reviews" }));
    expect(screen.getByTestId("review-row-SHRINK-1")).toBeInTheDocument();
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

describe("NeedsReviewTable - hide solved (owner rule: resolved never lingers in review)", () => {
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

  // Regression: "if it is resolved, it does not go to review." Sync state is irrelevant to whether a
  // SOLVED item still shows in Needs Review - a resolved row awaiting sync must not linger either.
  it("hides a resolved item even when its cloud backup has not synced yet (owner rule 2026-07-22: resolved = gone; sync retries invisibly in the background)", () => {
    useScanStore.setState({
      needsReviewQueue: [
        review({ id: "pend1", cleanCode: "3000000000003", status: "resolved", syncStatus: "pending", resolutionAction: "create_new" }),
      ],
    });
    render(<NeedsReviewTable />);
    expect(screen.queryByTestId("review-row-3000000000003")).toBeNull(); // resolved -> gone, regardless of sync
    expect(screen.queryByText("create_new")).toBeNull(); // raw enum never reaches the UI
  });
});

// Task 9b fix (reviewer finding): a review PARKED at status "suggested" (pending inline suggestion,
// owner-ratified 2026-07-14) must NOT render in the Needs Review queue - it belongs to the feed
// row's inline controls + the SuggestedApprovalPanel surface. The reviewer's exact hole: at
// creation a review has syncStatus "pending", so the visible-rows filter's second clause
// (`syncStatus !== "synced"`) let a parked suggested review leak onto the All tab whenever the
// ASYNC cloud sync had not drained yet (local mock sync is synchronous, which hid it).
describe("NeedsReviewTable - parked 'suggested' reviews never render (Task 9b)", () => {
  it("does NOT render a status 'suggested' review even while its sync is still pending", () => {
    useScanStore.setState({
      needsReviewQueue: [
        review({ id: "sg1", cleanCode: "4000000000004", status: "suggested", hasSuggestion: true, suggestedProductName: "Parked Widget", syncStatus: "pending" }),
      ],
    });
    render(<NeedsReviewTable />);
    expect(screen.queryByTestId("review-row-4000000000004")).toBeNull(); // parked -> never in the queue
    expect(screen.getByText(/Nothing to review/i)).not.toBeNull(); // table honestly empty
  });

  it("still renders an OPEN review alongside a hidden 'suggested' one (filter is status-scoped, not blanket)", () => {
    useScanStore.setState({
      needsReviewQueue: [
        review({ id: "sg2", cleanCode: "5000000000005", status: "suggested", hasSuggestion: true, suggestedProductName: "Parked Widget 2", syncStatus: "pending" }),
        review({ id: "op2", cleanCode: "6000000000006", status: "open", syncStatus: "pending" }),
      ],
    });
    render(<NeedsReviewTable />);
    expect(screen.queryByTestId("review-row-5000000000005")).toBeNull();
    expect(screen.queryByTestId("review-row-6000000000006")).not.toBeNull();
  });
});

// Phase 4 Task 10 C4 (plan-review-mandated): Phase 4 must make ZERO /api/ai-lookup calls. An
// import-origin review (importQuantity !== undefined, set by applyUniversalImport) must never
// expose liveDecode / correctionRecheck - both POST the code to that route.
describe("NeedsReviewTable - import-origin reviews hide live-decode/correction-recheck (Task 10 C4)", () => {
  it("does NOT render 'Look up with AI' or 'Deep lookup' for an import-origin review, even for platformOwner", () => {
    process.env.NEXT_PUBLIC_E2E_PLATFORM_OWNER = "1";
    useScanStore.setState({
      needsReviewQueue: [
        review({ id: "imp1", cleanCode: "IMPORT-CODE-1", status: "open", syncStatus: "pending", importQuantity: 4 }),
      ],
      settings: { ...useScanStore.getState().settings, aiLookupEnabled: true },
    });
    render(<NeedsReviewTable />);
    expect(screen.queryByTestId("live-decode")).toBeNull();
    expect(screen.queryByTestId("stronger-redecode")).toBeNull();
  });

  it("STILL renders 'Look up with AI' and 'Deep lookup' for a normal (non-import) review as platformOwner", () => {
    process.env.NEXT_PUBLIC_E2E_PLATFORM_OWNER = "1";
    useScanStore.setState({
      needsReviewQueue: [
        review({ id: "scan1", cleanCode: "SCAN-CODE-1", status: "open", syncStatus: "pending" }),
      ],
      settings: { ...useScanStore.getState().settings, aiLookupEnabled: true },
    });
    render(<NeedsReviewTable />);
    expect(screen.queryByTestId("live-decode")).not.toBeNull();
    expect(screen.queryByTestId("stronger-redecode")).not.toBeNull();
  });
});
