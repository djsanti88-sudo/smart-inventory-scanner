import { describe, expect, it, vi } from "vitest";
import { createIdentityReviewRoute } from "./route";

const review = {
  reviewId: "review-1", businessId: "shop-a", importId: "import-1", rowId: "row-1",
  decision: { kind: "review", candidates: [{ productId: "tire-a", rank: 1, evidence: [], missingFields: [], contradictions: [] }], decisionBasis: [], normalizedKeys: [{ type: "vendor_sku", namespace: "vendor", value: "SKU-1" }], constraintOutcomes: [], candidateSnapshotHash: "snapshot", engineVersion: "engine", pluginVersion: "tire", sourceRecordFingerprint: "source", decisionFingerprint: "decision" }, scope: { sourceSystem: "demo", sourceSignature: "demo-v1", vendorId: "vendor-a" },
};

function route(overrides: Partial<Parameters<typeof createIdentityReviewRoute>[0]> = {}) {
  const repository = {
    listIdentityReviews: vi.fn().mockResolvedValue([review]), resolveIdentityReview: vi.fn().mockResolvedValue({ ...review, resolution: "confirmed" }),
    saveIdentityLink: vi.fn().mockResolvedValue(undefined), createTenantProduct: vi.fn().mockResolvedValue({ productId: "tenant-product-1" }),
  };
  const handler = createIdentityReviewRoute({ enabled: () => true, authorize: vi.fn().mockResolvedValue({ actorId: "manager", businessId: "shop-a", role: "admin" }), repository, currentVersions: vi.fn().mockResolvedValue({ catalogVersion: "catalog-v1", linkVersion: "links-v1" }), ...overrides });
  return { handler, repository };
}

describe("identity review route", () => {
  it("confirms an in-scope candidate as an approved tenant link without a count or catalog promotion", async () => {
    const { handler, repository } = route();
    const response = await handler(new Request("http://local/api/identity/reviews", { method: "POST", body: JSON.stringify({ businessId: "shop-a", action: "confirm_candidate", reviewId: "review-1", targetProductId: "tire-a" }) }));
    expect(response.status).toBe(200);
    expect(repository.saveIdentityLink).toHaveBeenCalledWith(expect.objectContaining({ businessId: "shop-a", targetProductId: "tire-a", status: "approved", approvedBy: "manager" }));
    expect(repository.resolveIdentityReview).toHaveBeenCalledWith("shop-a", "review-1", "confirmed", "manager", expect.any(String));
  });

  it("derives authorization from the server and refuses a counter action even when the request claims admin", async () => {
    const { handler, repository } = route({ authorize: vi.fn().mockResolvedValue({ actorId: "clerk", businessId: "shop-a", role: "counter" }) });
    const response = await handler(new Request("http://local/api/identity/reviews", { method: "POST", body: JSON.stringify({ businessId: "shop-a", role: "admin", action: "create_tenant_product", reviewId: "review-1", name: "New tire" }) }));
    expect(response.status).toBe(400);
    expect(repository.createTenantProduct).not.toHaveBeenCalled();
  });

  it("does not let an admin resolve a review from a different tenant", async () => {
    const { handler, repository } = route();
    const response = await handler(new Request("http://local/api/identity/reviews", { method: "POST", body: JSON.stringify({ businessId: "shop-b", action: "reject", reviewId: "review-1" }) }));
    expect(response.status).toBe(403);
    expect(repository.resolveIdentityReview).not.toHaveBeenCalled();
  });

  it("lists only the authenticated business review queue", async () => {
    const { handler, repository } = route();
    const response = await handler(new Request("http://local/api/identity/reviews?businessId=shop-a"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ reviews: [review], page: 1, pageSize: 25, total: 1, bucketTotals: { review: 1 } });
    expect(repository.listIdentityReviews).toHaveBeenCalledWith("shop-a");
  });

  it("rejects direct counter and viewer mutations after server authorization", async () => {
    for (const role of ["counter", "viewer"] as const) {
      const { handler, repository } = route({ authorize: vi.fn().mockResolvedValue({ actorId: role, businessId: "shop-a", role }) });
      const response = await handler(new Request("http://local/api/identity/reviews", { method: "POST", body: JSON.stringify({ businessId: "shop-a", action: "reject", reviewId: "review-1" }) }));
      expect(response.status).toBe(403);
      expect(repository.resolveIdentityReview).not.toHaveBeenCalled();
    }
  });

  it("bounds GET pagination and maps repository errors without exposing internals", async () => {
    const reviews = Array.from({ length: 27 }, (_, index) => ({ ...review, reviewId: `review-${index}`, rowId: `row-${index}` }));
    const { handler } = route({ repository: { listIdentityReviews: vi.fn().mockResolvedValue(reviews) } as never });
    const paged = await handler(new Request("http://local/api/identity/reviews?businessId=shop-a&page=2&pageSize=1000"));
    expect(paged.status).toBe(200);
    expect(await paged.json()).toMatchObject({ page: 2, pageSize: 25, total: 27, reviews: [expect.objectContaining({ reviewId: "review-25" }), expect.objectContaining({ reviewId: "review-26" })] });
    const failing = route({ repository: { listIdentityReviews: vi.fn().mockRejectedValue(new Error("filesystem internals")) } as never }).handler;
    const response = await failing(new Request("http://local/api/identity/reviews?businessId=shop-a"));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Unable to load identity reviews." });
  });

  it("returns all queue bucket totals and the exact current approved link while paging a filtered bucket", async () => {
    const automatic = { ...review, reviewId: "automatic", rowId: "automatic", decision: { ...review.decision, kind: "automatic" as const } };
    const { handler } = route({ repository: {
      listIdentityReviews: vi.fn().mockResolvedValue([review, automatic]),
      listCurrentIdentityLinks: vi.fn().mockResolvedValue([{ businessId: "shop-a", sourceSystem: "demo", vendorId: "vendor-a", sourceSignature: "demo-v1", identifierType: "vendor_sku", namespace: "vendor", normalizedValue: "SKU-1", targetProductId: "tire-a", status: "approved", version: 7 }]),
    } as never });
    const response = await handler(new Request("http://local/api/identity/reviews?businessId=shop-a&bucket=review"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ total: 1, bucketTotals: { review: 1, automatic: 1, abstain: 0, non_product: 0, invalid: 0 }, reviews: [expect.objectContaining({ currentApprovedLink: { targetProductId: "tire-a", version: 7 } })] });
  });

  it("returns authoritative approved links even when no review row remains to revoke them", async () => {
    const currentApprovedLinks = vi.fn().mockResolvedValue([{ businessId: "shop-a", sourceSystem: "demo", vendorId: "vendor-a", sourceSignature: "demo-v1", identifierType: "vendor_sku", namespace: "vendor", normalizedValue: "SKU-1", targetProductId: "tire-a", version: 1, predecessorFingerprint: "configured-link" }]);
    const { handler } = route({ currentApprovedLinks } as never);
    const response = await handler(new Request("http://local/api/identity/reviews?businessId=shop-a"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ currentApprovedLinks: [{ targetProductId: "tire-a", predecessorFingerprint: "configured-link" }] });
    expect(currentApprovedLinks).toHaveBeenCalledWith("shop-a");
  });

  it("does not let a confirm action repoint a different current approved target", async () => {
    const { handler, repository } = route({ repository: {
      listIdentityReviews: vi.fn().mockResolvedValue([review]),
      listCurrentIdentityLinks: vi.fn().mockResolvedValue([{ businessId: "shop-a", sourceSystem: "demo", vendorId: "vendor-a", sourceSignature: "demo-v1", identifierType: "vendor_sku", namespace: "vendor", normalizedValue: "SKU-1", targetProductId: "other-tire", status: "approved", version: 3 }]),
    } as never });
    const response = await handler(new Request("http://local/api/identity/reviews", { method: "POST", body: JSON.stringify({ businessId: "shop-a", action: "confirm_candidate", reviewId: "review-1", targetProductId: "tire-a" }) }));
    expect(response.status).toBe(409);
    expect(repository.saveIdentityLink).not.toHaveBeenCalled();
  });

  it("maps authorization failures to a safe access response", async () => {
    const { handler } = route({ authorize: vi.fn().mockRejectedValue(new Error("membership store path")) });
    const response = await handler(new Request("http://local/api/identity/reviews?businessId=shop-a"));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Business access is required." });
  });

  it("rejects oversized action bodies before persistence", async () => {
    const { handler, repository } = route();
    const response = await handler(new Request("http://local/api/identity/reviews", { method: "POST", body: JSON.stringify({ businessId: "shop-a", action: "reject", reviewId: "review-1", name: "x".repeat(16_385) }) }));
    expect(response.status).toBe(400);
    expect(repository.resolveIdentityReview).not.toHaveBeenCalled();
  });

  it("maps action persistence failures to a safe server error", async () => {
    const { handler } = route({ repository: { listIdentityReviews: vi.fn().mockResolvedValue([review]), resolveIdentityReview: vi.fn().mockRejectedValue(new Error("storage path leaked")) } as never });
    const response = await handler(new Request("http://local/api/identity/reviews", { method: "POST", body: JSON.stringify({ businessId: "shop-a", action: "reject", reviewId: "review-1" }) }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Unable to update identity review." });
  });
});
