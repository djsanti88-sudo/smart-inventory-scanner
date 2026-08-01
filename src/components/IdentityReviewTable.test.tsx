import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IdentityReviewTable } from "./IdentityReviewTable";

const review = { reviewId: "review-1", rowId: "row-1", decision: { kind: "review", candidates: [{ productId: "tire-a", rank: 1, evidence: ["exact vendor SKU"], missingFields: [], contradictions: [] }] } };
const previewDecisions = [review, { reviewId: "preview-auto", rowId: "row-auto", decision: { kind: "automatic", candidates: [] } }, { reviewId: "preview-abstain", rowId: "row-abstain", decision: { kind: "abstain", candidates: [] } }, { reviewId: "preview-non-product", rowId: "row-non-product", decision: { kind: "non_product", candidates: [] } }, { reviewId: "preview-invalid", rowId: "row-invalid", decision: { kind: "invalid", candidates: [] } }];
beforeEach(() => { global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ reviews: [review] }) }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("IdentityReviewTable", () => {
  it("uses a semantic table, status region, and keyboard-focusable pagination", async () => {
    render(<IdentityReviewTable businessId="shop-a" actorRole="admin" />);
    await waitFor(() => expect(screen.getByRole("table", { name: /identity review queue/i })).toBeTruthy());
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByRole("button", { name: /next page/i })).toBeTruthy();
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
    expect((fetchMock.mock.calls[2]![0] as string)).toContain("page=1");
  });
});
