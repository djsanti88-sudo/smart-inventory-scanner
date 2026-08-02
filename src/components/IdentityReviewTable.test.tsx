import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IdentityReviewTable } from "./IdentityReviewTable";

const review = { reviewId: "review-1", rowId: "row-1", decision: { kind: "review", candidates: [{ productId: "tire-a", rank: 1, evidence: ["exact vendor SKU"], missingFields: [], contradictions: [] }] } };
const previewDecisions = [review, { reviewId: "preview-auto", rowId: "row-auto", decision: { kind: "automatic", candidates: [] } }, { reviewId: "preview-abstain", rowId: "row-abstain", decision: { kind: "abstain", candidates: [] } }, { reviewId: "preview-non-product", rowId: "row-non-product", decision: { kind: "non_product", candidates: [] } }, { reviewId: "preview-invalid", rowId: "row-invalid", decision: { kind: "invalid", candidates: [] } }];
const approvedLink = { sourceSystem: "vendor-feed", sourceSignature: "feed-v1", vendorId: "vendor-a", identifierType: "vendor_sku", namespace: "vendor", normalizedValue: "SKU-1", targetProductId: "tire-a", version: 3, predecessorFingerprint: "approved-link-fingerprint", predecessorSource: "configured" as const };
beforeEach(() => { global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ reviews: [review] }) }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("IdentityReviewTable", () => {
  it("renders at most one server page for 100 reviews and 500 approved links", async () => {
    const reviews = Array.from({ length: 25 }, (_, index) => ({ ...review, reviewId: `review-${index}`, rowId: `row-${index}` }));
    const links = Array.from({ length: 25 }, (_, index) => ({ ...approvedLink, normalizedValue: `SKU-${index}`, predecessorFingerprint: `link-${index}` }));
    vi.mocked(global.fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ reviews, total: 100, page: 1, pageSize: 25, currentApprovedLinks: links, linkTotal: 500, linkPage: 1, bucketTotals: { review: 100, automatic: 0, abstain: 0, non_product: 0, invalid: 0 } }) } as Response);
    render(<IdentityReviewTable businessId="shop-a" actorRole="admin" />);
    await screen.findByText("row-24");
    expect(screen.getAllByRole("row")).toHaveLength(52); // two headers plus 25 review and 25 link rows
    expect(screen.getByRole("table", { name: /current approved links/i }).querySelectorAll("tbody tr")).toHaveLength(25);
    expect(screen.queryByText("row-25")).not.toBeInTheDocument();
  });
  it("uses a semantic table, status region, and keyboard-focusable pagination", async () => {
    render(<IdentityReviewTable businessId="shop-a" actorRole="admin" />);
    await waitFor(() => expect(screen.getByRole("table", { name: /identity review queue/i })).toBeTruthy());
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByRole("button", { name: /next reviews/i })).toBeTruthy();
  });

  it("advances review and link cursors independently while retaining the other surface cursor", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ reviews: [{ ...review, rowId: "review-root" }], currentApprovedLinks: [{ ...approvedLink, normalizedValue: "LINK-ROOT" }], nextReviewCursor: "review-1", nextLinkCursor: "link-1" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ reviews: [{ ...review, rowId: "review-next" }], currentApprovedLinks: [{ ...approvedLink, normalizedValue: "LINK-ROOT" }], nextReviewCursor: null, nextLinkCursor: "link-1" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ reviews: [{ ...review, rowId: "review-next" }], currentApprovedLinks: [{ ...approvedLink, normalizedValue: "LINK-NEXT" }], nextReviewCursor: null, nextLinkCursor: null }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ reviews: [{ ...review, rowId: "review-root" }], currentApprovedLinks: [{ ...approvedLink, normalizedValue: "LINK-NEXT" }], nextReviewCursor: "review-1", nextLinkCursor: null }) });

    render(<IdentityReviewTable businessId="shop-a" actorRole="admin" />);
    await screen.findByText("review-root");
    fireEvent.click(screen.getByRole("button", { name: /next reviews/i }));
    await screen.findByText("review-next");
    expect(screen.queryByRole("alert")).toBeNull();
    const reviewNext = new URL(fetchMock.mock.calls[1]![0] as string, "http://local");
    expect(reviewNext.searchParams.get("afterReview")).toBe("review-1");
    expect(reviewNext.searchParams.get("afterLink")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /next approved links/i }));
    await screen.findByRole("button", { name: /revoke approved link link-next/i });
    expect(screen.queryByRole("alert")).toBeNull();
    const linkNext = new URL(fetchMock.mock.calls[2]![0] as string, "http://local");
    expect(linkNext.searchParams.get("afterReview")).toBe("review-1");
    expect(linkNext.searchParams.get("afterLink")).toBe("link-1");
    expect(screen.getByRole("status")).toHaveTextContent(/Review page 2\. Link page 2\./i);

    fireEvent.click(screen.getByRole("button", { name: /previous review page/i }));
    await screen.findByText("review-root");
    const reviewPrevious = new URL(fetchMock.mock.calls[3]![0] as string, "http://local");
    expect(reviewPrevious.searchParams.get("afterReview")).toBeNull();
    expect(reviewPrevious.searchParams.get("afterLink")).toBe("link-1");
    expect(screen.getByRole("status")).toHaveTextContent(/Review page 1\. Link page 2\./i);
  });

  it("uses cursor availability rather than conflicting totals and does not duplicate a rapid next request", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    let resolveNext: (value: unknown) => void = () => undefined;
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ reviews: [review], currentApprovedLinks: [], total: 0, linkTotal: 999, nextReviewCursor: "review-1", nextLinkCursor: null }) })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveNext = resolve; }));

    render(<IdentityReviewTable businessId="shop-a" actorRole="admin" />);
    await screen.findByText("row-1");
    const next = screen.getByRole("button", { name: /next reviews/i });
    expect(next).toBeEnabled();
    fireEvent.click(next);
    fireEvent.click(next);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    resolveNext({ ok: true, json: async () => ({ reviews: [], currentApprovedLinks: [], total: 100, linkTotal: 0, nextReviewCursor: null, nextLinkCursor: "unexpected-link" }) });
    await waitFor(() => expect(screen.getByRole("button", { name: /next reviews/i })).toBeDisabled());
    expect(screen.getByRole("button", { name: /next approved links/i })).toBeEnabled();
  });

  it("rolls back a rejected review Next and retries the same cursor exactly once", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ reviews: [{ ...review, rowId: "review-root" }], currentApprovedLinks: [{ ...approvedLink, normalizedValue: "LINK-ROOT" }], nextReviewCursor: "review-1", nextLinkCursor: "link-1" }) })
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: "Review page failed." }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ reviews: [{ ...review, rowId: "review-next" }], currentApprovedLinks: [{ ...approvedLink, normalizedValue: "LINK-ROOT" }], nextReviewCursor: null, nextLinkCursor: "link-1" }) });

    render(<IdentityReviewTable businessId="shop-a" actorRole="admin" />);
    await screen.findByText("review-root");
    fireEvent.click(screen.getByRole("button", { name: /next reviews/i }));
    await screen.findByRole("alert");
    expect(screen.getByText("review-root")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/Review page 1\. Link page 1\./i);
    expect(screen.getByRole("button", { name: /next reviews/i })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: /next reviews/i }));
    await screen.findByText("review-next");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(new URL(fetchMock.mock.calls[1]![0] as string, "http://local").searchParams.getAll("afterReview")).toEqual(["review-1"]);
    expect(new URL(fetchMock.mock.calls[2]![0] as string, "http://local").searchParams.getAll("afterReview")).toEqual(["review-1"]);
    expect(screen.getByRole("status")).toHaveTextContent(/Review page 2\. Link page 1\./i);
  });

  it("rolls back only a rejected link Next while preserving the advanced review page", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ reviews: [{ ...review, rowId: "review-root" }], currentApprovedLinks: [{ ...approvedLink, normalizedValue: "LINK-ROOT" }], nextReviewCursor: "review-1", nextLinkCursor: "link-1" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ reviews: [{ ...review, rowId: "review-next" }], currentApprovedLinks: [{ ...approvedLink, normalizedValue: "LINK-ROOT" }], nextReviewCursor: null, nextLinkCursor: "link-1" }) })
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: "Link page failed." }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ reviews: [{ ...review, rowId: "review-next" }], currentApprovedLinks: [{ ...approvedLink, normalizedValue: "LINK-NEXT" }], nextReviewCursor: null, nextLinkCursor: null }) });

    render(<IdentityReviewTable businessId="shop-a" actorRole="admin" />);
    await screen.findByText("review-root");
    fireEvent.click(screen.getByRole("button", { name: /next reviews/i }));
    await screen.findByText("review-next");
    fireEvent.click(screen.getByRole("button", { name: /next approved links/i }));
    await screen.findByRole("alert");
    expect(screen.getByText("review-next")).toBeInTheDocument();
    expect(screen.getAllByText(/LINK-ROOT/).length).toBeGreaterThan(0);
    expect(screen.getByRole("status")).toHaveTextContent(/Review page 2\. Link page 1\./i);

    fireEvent.click(screen.getByRole("button", { name: /next approved links/i }));
    await screen.findByRole("button", { name: /revoke approved link link-next/i });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const call of [2, 3]) {
      const query = new URL(fetchMock.mock.calls[call]![0] as string, "http://local").searchParams;
      expect(query.getAll("afterReview")).toEqual(["review-1"]);
      expect(query.getAll("afterLink")).toEqual(["link-1"]);
    }
    expect(screen.getByRole("status")).toHaveTextContent(/Review page 2\. Link page 2\./i);
  });

  it("keeps a non-root link cursor when revocation refreshes the combined page", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    const secondLink = { ...approvedLink, normalizedValue: "SKU-2", predecessorFingerprint: "link-2" };
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ reviews: [review], currentApprovedLinks: [approvedLink], nextReviewCursor: null, nextLinkCursor: "link-1" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ reviews: [review], currentApprovedLinks: [secondLink], nextReviewCursor: null, nextLinkCursor: null }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ link: { ...secondLink, status: "revoked" } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ reviews: [review], currentApprovedLinks: [], nextReviewCursor: null, nextLinkCursor: null }) });

    render(<IdentityReviewTable businessId="shop-a" actorRole="admin" />);
    await screen.findByRole("button", { name: /next approved links/i });
    fireEvent.click(screen.getByRole("button", { name: /next approved links/i }));
    const revoke = await screen.findByRole("button", { name: /revoke approved link sku-2/i });
    fireEvent.click(revoke);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(new URL(fetchMock.mock.calls[3]![0] as string, "http://local").searchParams.get("afterLink")).toBe("link-1");
  });

  it("keeps the non-root link page visible when a review mutation refreshes", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    const secondLink = { ...approvedLink, normalizedValue: "SKU-2", predecessorFingerprint: "link-2" };
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ reviews: [review], currentApprovedLinks: [approvedLink], nextReviewCursor: null, nextLinkCursor: "link-1" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ reviews: [review], currentApprovedLinks: [secondLink], nextReviewCursor: null, nextLinkCursor: null }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ review: { ...review, resolution: "confirmed" } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ reviews: [], currentApprovedLinks: [secondLink], nextReviewCursor: null, nextLinkCursor: null }) });

    render(<IdentityReviewTable businessId="shop-a" actorRole="admin" />);
    await screen.findByText("row-1");
    fireEvent.click(screen.getByRole("button", { name: /next approved links/i }));
    await screen.findByRole("button", { name: /revoke approved link sku-2/i });
    fireEvent.click(screen.getByRole("button", { name: /confirm tire-a/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    const refresh = new URL(fetchMock.mock.calls[3]![0] as string, "http://local");
    expect(refresh.searchParams.get("afterReview")).toBeNull();
    expect(refresh.searchParams.get("afterLink")).toBe("link-1");
    expect(screen.getByRole("status")).toHaveTextContent(/Review page 1\. Link page 2\./i);
    expect(screen.getByRole("button", { name: /revoke approved link sku-2/i })).toBeInTheDocument();
  });

  it("resets only the review head on a bucket switch from non-root combined cursors", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ reviews: [review], currentApprovedLinks: [approvedLink], nextReviewCursor: "review-1", nextLinkCursor: "link-1" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ reviews: [review], currentApprovedLinks: [approvedLink], nextReviewCursor: null, nextLinkCursor: "link-1" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ reviews: [review], currentApprovedLinks: [approvedLink], nextReviewCursor: null, nextLinkCursor: null }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ reviews: [], currentApprovedLinks: [approvedLink], nextReviewCursor: null, nextLinkCursor: null }) });

    render(<IdentityReviewTable businessId="shop-a" actorRole="admin" />);
    await screen.findByText("row-1");
    fireEvent.click(screen.getByRole("button", { name: /next reviews/i }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/Review page 2\. Link page 1\./i));
    fireEvent.click(screen.getByRole("button", { name: /next approved links/i }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/Review page 2\. Link page 2\./i));
    fireEvent.click(screen.getByRole("button", { name: /automatic/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    const switched = new URL(fetchMock.mock.calls[3]![0] as string, "http://local");
    expect(switched.searchParams.get("afterReview")).toBeNull();
    expect(switched.searchParams.get("afterLink")).toBe("link-1");
    expect(screen.getByRole("status")).toHaveTextContent(/Review page 1\. Link page 2\./i);
  });

  it("latches navigation before a bucket reset can accept a stale Next click", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    let resolveBucket: (value: unknown) => void = () => undefined;
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ reviews: [review], currentApprovedLinks: [], nextReviewCursor: "review-1", nextLinkCursor: null }) })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveBucket = resolve; }));

    render(<IdentityReviewTable businessId="shop-a" actorRole="admin" />);
    await screen.findByText("row-1");
    const next = screen.getByRole("button", { name: /next reviews/i });
    fireEvent.click(screen.getByRole("button", { name: /automatic/i }));
    fireEvent.click(next);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    resolveBucket({ ok: true, json: async () => ({ reviews: [], currentApprovedLinks: [], nextReviewCursor: null, nextLinkCursor: null }) });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/Review page 1\. Link page 1\./i));
  });

  it("aborts and ignores a stale combined-head response after a bucket switch", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    let resolveStale: (value: unknown) => void = () => undefined;
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ reviews: [review], currentApprovedLinks: [approvedLink], nextReviewCursor: "review-1", nextLinkCursor: "link-1" }) })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveStale = resolve; }))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ reviews: [], currentApprovedLinks: [approvedLink], nextReviewCursor: null, nextLinkCursor: "link-1" }) });

    render(<IdentityReviewTable businessId="shop-a" actorRole="admin" />);
    await screen.findByText("row-1");
    fireEvent.click(screen.getByRole("button", { name: /next reviews/i }));
    fireEvent.click(screen.getByRole("button", { name: /automatic/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect((fetchMock.mock.calls[1]![1] as RequestInit).signal).toHaveProperty("aborted", true);
    resolveStale({ ok: true, json: async () => ({ reviews: [{ ...review, rowId: "stale-review" }], currentApprovedLinks: [{ ...approvedLink, normalizedValue: "STALE-LINK" }], nextReviewCursor: null, nextLinkCursor: null }) });
    await waitFor(() => expect(screen.queryByText("stale-review")).toBeNull());
    expect(screen.queryByText(/STALE-LINK/)).toBeNull();
    expect(screen.getByRole("button", { name: /automatic/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("status")).toHaveTextContent(/Review page 1\. Link page 1\./i);
  });

  it("renders the signed candidate display with product id secondary and never renders unallowlisted fields", async () => {
    const displayed = { ...review, cost: "999.00", quantity: 44, notes: "secret note", decision: { ...review.decision, candidates: [{ ...review.decision.candidates[0]!, display: { label: "Roadmaster RM234", category: "Tire", attributes: { size: "225/65R17", season: "All Season", cost: "999.00", quantity: "44", notes: "secret note", unknown: "private" } } }] } };
    vi.mocked(global.fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ reviews: [displayed] }) } as Response);

    render(<IdentityReviewTable businessId="shop-a" actorRole="admin" />);

    expect(await screen.findByText("Roadmaster RM234")).toBeInTheDocument();
    expect(screen.getByText("Tire")).toBeInTheDocument();
    expect(screen.getByText(/size: 225\/65R17/i)).toBeInTheDocument();
    expect(screen.getByText(/season: All Season/i)).toBeInTheDocument();
    expect(screen.getByText("tire-a")).toBeInTheDocument();
    expect(screen.queryByText(/999\.00|secret note|private|quantity: 44/i)).toBeNull();
  });

  it("lets an admin confirm the selected candidate and reports completion", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ reviews: [review] }) }).mockResolvedValueOnce({ ok: true, json: async () => ({ review: { ...review, resolution: "confirmed" } }) });
    render(<IdentityReviewTable businessId="shop-a" actorRole="admin" />);
    await waitFor(() => expect(screen.getByRole("button", { name: /confirm tire-a/i })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /confirm tire-a/i }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/confirmed/i));
    expect(JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string)).toMatchObject({ action: "confirm_candidate", targetProductId: "tire-a" });
  });

  it("shows counters the queue but no mutation controls", async () => {
    render(<IdentityReviewTable businessId="shop-a" actorRole="counter" />);
    await waitFor(() => expect(screen.getByText("row-1")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /confirm|reject|create product|revoke/i })).toBeNull();
  });

  it("rejects unauthoritative preview rows and defaults to the server Review queue", async () => {
    render(<IdentityReviewTable businessId="shop-a" actorRole="admin" previewDecisions={previewDecisions} />);
    await waitFor(() => expect(screen.getByText("row-1")).toBeTruthy());
    expect(screen.getByText("row-1")).toBeTruthy();
    expect(screen.queryByText("row-auto")).toBeNull();
    expect(screen.getByRole("button", { name: /automatic \(0\)/i })).toBeTruthy();
    expect(screen.queryByText("row-auto")).toBeNull();
  });

  it("uses the top-ranked candidate, exposes evidence, and prevents duplicate submission", async () => {
    const ranked = { ...review, decision: { ...review.decision, candidates: [{ productId: "lower-ranked", rank: 2, evidence: ["weak"], missingFields: ["size"], contradictions: ["brand"] }, { productId: "best-ranked", rank: 1, evidence: ["exact code"], missingFields: [], contradictions: [] }] } };
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    let resolveAction: (value: unknown) => void = () => undefined;
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ reviews: [ranked] }) }).mockImplementationOnce(() => new Promise((resolve) => { resolveAction = resolve; }));
    render(<IdentityReviewTable businessId="shop-a" actorRole="admin" />);
    const confirm = await screen.findByRole("button", { name: /confirm best-ranked/i });
    expect(screen.getByText(/exact code/i)).toBeTruthy();
    fireEvent.click(confirm);
    expect(confirm).toBeDisabled();
    expect(confirm.closest("tr")).toHaveAttribute("aria-busy", "true");
    fireEvent.click(confirm);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    resolveAction({ ok: true, json: async () => ({ review: { ...ranked, resolution: "confirmed" } }) });
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/confirmed/i));
  });

  it("lets a manager select any ranked candidate and submits that exact selection with its evidence", async () => {
    const ranked = { ...review, decision: { ...review.decision, candidates: [{ productId: "first", rank: 1, evidence: ["first evidence"], missingFields: [], contradictions: [] }, { productId: "second", rank: 2, evidence: ["second evidence"], missingFields: ["size"], contradictions: ["brand"] }] } };
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ reviews: [ranked], total: 1, bucketTotals: { automatic: 0, review: 1, abstain: 0, non_product: 0, invalid: 0 } }) }).mockResolvedValueOnce({ ok: true, json: async () => ({ review: { ...ranked, resolution: "confirmed" } }) }).mockResolvedValueOnce({ ok: true, json: async () => ({ reviews: [], total: 0, bucketTotals: { automatic: 0, review: 0, abstain: 0, non_product: 0, invalid: 0 } }) });
    render(<IdentityReviewTable businessId="shop-a" actorRole="admin" />);
    const second = await screen.findByRole("radio", { name: /second/i });
    fireEvent.click(second);
    expect(screen.getByText("second evidence")).toBeTruthy();
    expect(screen.getByText("Missing: size")).toBeTruthy();
    expect(screen.getByText("Contradiction: brand")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /confirm second/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string)).toMatchObject({ action: "confirm_candidate", targetProductId: "second" });
  });

  it("ignores a stale business response", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    let resolveOld: (value: unknown) => void = () => undefined;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; })).mockResolvedValueOnce({ ok: true, json: async () => ({ reviews: [{ ...review, reviewId: "new", rowId: "new-row" }] }) });
    const view = render(<IdentityReviewTable businessId="old-shop" actorRole="admin" />);
    view.rerender(<IdentityReviewTable businessId="new-shop" actorRole="admin" />);
    await screen.findByText("new-row");
    resolveOld({ ok: true, json: async () => ({ reviews: [review] }) });
    await waitFor(() => expect(screen.queryByText("row-1")).toBeNull());
  });

  it("uses server bucket totals, rejects unknown preview rows, and refetches after a resolution", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ reviews: [review], page: 1, pageSize: 25, total: 1, bucketTotals: { automatic: 4, review: 1, abstain: 0, non_product: 0, invalid: 0 } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ review: { ...review, resolution: "confirmed" } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ reviews: [], page: 1, pageSize: 25, total: 0, bucketTotals: { automatic: 4, review: 0, abstain: 0, non_product: 0, invalid: 0 } }) });
    render(<IdentityReviewTable businessId="shop-a" actorRole="admin" previewDecisions={[{ ...review, reviewId: "unknown-preview", rowId: "unknown-preview" }]} />);
    await screen.findByText("row-1");
    expect(screen.queryByText("unknown-preview")).toBeNull();
    expect(screen.getByRole("button", { name: /automatic \(4\)/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /confirm tire-a/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect((fetchMock.mock.calls[2]![0] as string)).toContain("bucket=review");
  });

  it("renders configured current approved links separately and revokes with the exact predecessor selector", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ reviews: [review], total: 1, bucketTotals: { automatic: 0, review: 1, abstain: 0, non_product: 0, invalid: 0 }, currentApprovedLinks: [approvedLink] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ link: { ...approvedLink, status: "revoked" } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ reviews: [review], total: 1, bucketTotals: { automatic: 0, review: 1, abstain: 0, non_product: 0, invalid: 0 }, currentApprovedLinks: [] }) });
    render(<IdentityReviewTable businessId="shop-a" actorRole="admin" />);
    expect(await screen.findByRole("table", { name: /current approved links/i })).toBeTruthy();
    expect(screen.getAllByText(/SKU-1/).length).toBeGreaterThan(0);
    expect(screen.getByText(/vendor-feed/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /revoke approved link sku-1/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string)).toEqual({ businessId: "shop-a", action: "revoke_link", link: approvedLink });
    await waitFor(() => expect(screen.queryByText("SKU-1")).toBeNull());
    expect(screen.getByRole("status").textContent).toMatch(/revoked/i);
  });

  it("keeps standalone current links read-only for non-managers", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ reviews: [review], currentApprovedLinks: [approvedLink] }) });
    render(<IdentityReviewTable businessId="shop-a" actorRole="viewer" />);
    await screen.findByRole("table", { name: /current approved links/i });
    expect(screen.queryByRole("button", { name: /revoke approved link/i })).toBeNull();
  });

  it("moves focus to the next current-link action after revocation", async () => {
    const nextLink = { ...approvedLink, normalizedValue: "SKU-2", predecessorFingerprint: "next-link-fingerprint" };
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ reviews: [], currentApprovedLinks: [approvedLink, nextLink] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ link: { ...approvedLink, status: "revoked" } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ reviews: [], currentApprovedLinks: [nextLink] }) });
    render(<IdentityReviewTable businessId="shop-a" actorRole="admin" />);
    fireEvent.click(await screen.findByRole("button", { name: /revoke approved link sku-1/i }));
    const nextAction = await screen.findByRole("button", { name: /revoke approved link sku-2/i });
    await waitFor(() => expect(document.activeElement).toBe(nextAction));
  });

  it("keeps revocation focus inside its own table when multiple review tables are mounted", async () => {
    const first = { ...approvedLink, normalizedValue: "SHOP-A-1", predecessorFingerprint: "shop-a-one" };
    const next = { ...approvedLink, normalizedValue: "SHOP-A-2", predecessorFingerprint: "shop-a-two" };
    const other = { ...approvedLink, normalizedValue: "SHOP-B-1", predecessorFingerprint: "shop-b-one" };
    let shopAGets = 0;
    global.fetch = vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return Promise.resolve({ ok: true, json: async () => ({ link: { ...first, status: "revoked" } }) });
      const url = new URL(input.toString(), "http://local");
      const isShopA = url.searchParams.get("businessId") === "shop-a";
      return Promise.resolve({ ok: true, json: async () => ({ reviews: [], currentApprovedLinks: isShopA ? (shopAGets++ === 0 ? [first, next] : [next]) : [other] }) });
    }) as typeof fetch;
    render(<><IdentityReviewTable businessId="shop-b" actorRole="admin" /><IdentityReviewTable businessId="shop-a" actorRole="admin" /></>);
    const firstAction = await screen.findByRole("button", { name: /revoke approved link shop-a-1/i });
    fireEvent.click(firstAction);
    const nextAction = await screen.findByRole("button", { name: /revoke approved link shop-a-2/i });
    await waitFor(() => expect(document.activeElement).toBe(nextAction));
  });
});
