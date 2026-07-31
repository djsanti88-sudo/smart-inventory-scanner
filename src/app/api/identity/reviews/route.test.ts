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
    expect(await response.json()).toEqual({ reviews: [review] });
    expect(repository.listIdentityReviews).toHaveBeenCalledWith("shop-a");
  });
});
