import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IdentityReviewTable } from "./IdentityReviewTable";

const review = { reviewId: "review-1", rowId: "row-1", decision: { kind: "review", candidates: [{ productId: "tire-a", rank: 1, evidence: ["exact vendor SKU"], missingFields: [], contradictions: [] }] } };
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
});
