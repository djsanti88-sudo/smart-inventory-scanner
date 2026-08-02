import { describe, expect, it, vi } from "vitest";
import { createIdentityReviewRoute } from "@/server/identity/reviewRoute";
import { canonicalSha256 } from "@/services/identity/canonical";
import { createMemoryAtomicLocalStorage } from "@/server/identity/atomicLocalStorage";
import { createLocalAtomicReviewCountedApply } from "@/server/identity/localAtomicReviewCountedApply";

const review = {
  reviewId: "review-1", businessId: "shop-a", importId: "import-1", rowId: "row-1",
  decision: { kind: "review", candidates: [{ productId: "tire-a", rank: 1, identifierFamily: { type: "vendor_sku" as const, namespace: "vendor", value: "SKU-1" }, evidence: [], missingFields: [], contradictions: [] }], decisionBasis: [], normalizedKeys: [{ type: "vendor_sku", namespace: "vendor", value: "SKU-1" }], constraintOutcomes: [], candidateSnapshotHash: "snapshot", engineVersion: "engine", pluginVersion: "tire", sourceRecordFingerprint: "source", decisionFingerprint: "decision" }, scope: { sourceSystem: "demo", sourceSignature: "demo-v1", vendorId: "vendor-a" },
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

  it("persists the selected candidate's exact evidence family instead of the row's first normalized key", async () => {
    const selected = {
      ...review,
      decision: {
        ...review.decision,
        normalizedKeys: [
          { type: "internal_code" as const, namespace: "shop", value: "INTERNAL-1" },
          { type: "vendor_sku" as const, namespace: "vendor-a", value: "SKU-2" },
        ],
        candidates: [{ ...review.decision.candidates[0]!, identifierFamily: { type: "vendor_sku" as const, namespace: "vendor-a", value: "SKU-2" } }],
      },
    };
    const saveIdentityLink = vi.fn().mockResolvedValue(undefined);
    const { handler } = route({ repository: {
      listIdentityReviews: vi.fn().mockResolvedValue([selected]),
      saveIdentityLink,
      resolveIdentityReview: vi.fn().mockResolvedValue({ ...selected, resolution: "confirmed" }),
    } as never });

    const response = await handler(new Request("http://local/api/identity/reviews", { method: "POST", body: JSON.stringify({ businessId: "shop-a", action: "confirm_candidate", reviewId: "review-1", targetProductId: "tire-a" }) }));

    expect(response.status).toBe(200);
    expect(saveIdentityLink).toHaveBeenCalledWith(expect.objectContaining({
      identifierType: "vendor_sku", namespace: "vendor-a", normalizedValue: "SKU-2",
    }));
  });

  it("counts a later physical-count approval through atomicCountedRow with the signed source quantity", async () => {
    const countedReview = {
      ...review,
      signedRowContext: {
        mode: "physical_count" as const, quantity: 7, unitOfMeasure: "each" as const, sourceFileOrdinal: 0,
        sheetName: "Stock", sourceRowNumber: 2, sessionId: "identity-import:import-1",
        eventCreatedAt: "2026-07-31T00:01:00.000Z", identifiers: [],
      },
    };
    const applyReviewAction = vi.fn(async () => ({ review: { ...countedReview, resolution: "confirmed" }, link: { targetProductId: "tire-a" }, action: { outcome: "confirmed" } }));
    const atomicCountedRow = vi.fn(async (input) => ({ kind: "applied" as const, event: input.event, result: { row: { rowId: "row-1", status: "counted", eventId: input.event.eventId } } }));
    const { handler } = route({
      repository: { listIdentityReviews: vi.fn().mockResolvedValue([countedReview]), applyReviewAction } as never,
      atomicCountedRow,
    } as never);

    const response = await handler(new Request("http://local/api/identity/reviews", { method: "POST", headers: { "Idempotency-Key": "review:review-1:confirm" }, body: JSON.stringify({ businessId: "shop-a", action: "confirm_candidate", reviewId: "review-1", targetProductId: "tire-a" }) }));

    expect(response.status).toBe(200);
    expect(atomicCountedRow).toHaveBeenCalledTimes(1);
    expect(atomicCountedRow).toHaveBeenCalledWith(expect.objectContaining({
      event: expect.objectContaining({ kind: "aggregate_import", quantity: 7, productId: "tire-a", sessionId: "identity-import:import-1" }),
      operation: expect.objectContaining({ idempotencyKey: "identity-review-count:review-1" }),
    }));
  });

  it("uses the atomic review coordinator for a counted approval instead of split legacy mutations", async () => {
    const storage = createMemoryAtomicLocalStorage();
    const countedReview = {
      ...review,
      signedRowContext: { mode: "physical_count" as const, quantity: 7, unitOfMeasure: "each" as const, sourceFileOrdinal: 0, sheetName: "Stock", sourceRowNumber: 2, sessionId: "identity-import:import-1", eventCreatedAt: "2026-07-31T00:01:00.000Z", identifiers: [] },
    };
    await storage.transaction(async (tx) => {
      await tx.set("identity-reviews", [countedReview]);
      await tx.set("identity-runs", [{ businessId: "shop-a", importId: "import-1", state: "completed" }]);
    });
    const applyReviewAction = vi.fn();
    const atomicReviewApply = createLocalAtomicReviewCountedApply(storage, { writeProjection: async () => {} });
    const { handler } = route({
      repository: { listIdentityReviews: vi.fn().mockResolvedValue([countedReview]), applyReviewAction } as never,
      atomicReviewApply,
    } as never);

    const response = await handler(new Request("http://local/api/identity/reviews", { method: "POST", headers: { "Idempotency-Key": "atomic-confirm" }, body: JSON.stringify({ businessId: "shop-a", action: "confirm_candidate", reviewId: "review-1", targetProductId: "tire-a" }) }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ action: { actionId: "atomic-confirm", targetProductId: "tire-a" }, laterCount: { eventId: expect.any(String), quantity: 7 } });
    expect(applyReviewAction).not.toHaveBeenCalled();
  });

  it("returns an exact durable replay before calling current-model freshness", async () => {
    const payloadFingerprint = await canonicalSha256({ reviewId: "review-1", action: "confirm_candidate", targetProductId: "tire-a", name: "" });
    const stored = { ...review, resolution: "confirmed" as const, reviewAction: { actionId: "same-key", payloadFingerprint, action: "confirm_candidate" as const, targetProductId: "tire-a", outcome: "confirmed" as const, resolvedBy: "manager", resolvedAt: "2026-08-02T00:00:00.000Z", countResult: { kind: "applied" as const, eventId: "event-1", quantity: 7 } } };
    const getIdentityReview = vi.fn().mockResolvedValue(stored);
    const currentModel = vi.fn();
    const { handler } = route({ repository: { listIdentityReviews: vi.fn(), getIdentityReview } as never, currentModel } as never);
    const response = await handler(new Request("http://local/api/identity/reviews", { method: "POST", headers: { "Idempotency-Key": "same-key" }, body: JSON.stringify({ businessId: "shop-a", action: "confirm_candidate", reviewId: "review-1", targetProductId: "tire-a" }) }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ action: { actionId: "same-key" }, laterCount: { eventId: "event-1", quantity: 7 } });
    expect(currentModel).not.toHaveBeenCalled();
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

  it("bounds 500 approved links independently and requests only the selected repository page", async () => {
    const links = Array.from({ length: 500 }, (_, index) => ({ sourceSystem: "demo", sourceSignature: "v1", vendorId: "vendor", identifierType: "upc", namespace: "", normalizedValue: String(index), targetProductId: `p-${index}`, version: 1, predecessorFingerprint: `f-${index}`, predecessorSource: "configured" }));
    const pageCurrentApprovedLinks = vi.fn().mockResolvedValue({ items: links.slice(25, 50), total: 500 });
    const { handler } = route({ currentApprovedLinks: undefined, pageCurrentApprovedLinks } as never);
    const response = await handler(new Request("http://local/api/identity/reviews?businessId=shop-a&linkPage=2&pageSize=25"));
    const body = await response.json();
    expect(body.currentApprovedLinks).toHaveLength(25);
    expect(body).toMatchObject({ linkPage: 2, linkTotal: 500, pageSize: 25 });
    expect(pageCurrentApprovedLinks).toHaveBeenCalledWith("shop-a", { page: 2, pageSize: 25 });
  });

  it("bounds repository reads and responses for 100 reviews and 500 approved links", async () => {
    const reviews = Array.from({ length: 25 }, (_, index) => ({ ...review, reviewId: `review-${index}`, rowId: `row-${index}` }));
    const links = Array.from({ length: 25 }, (_, index) => ({ sourceSystem: "demo", sourceSignature: "v1", vendorId: "vendor", identifierType: "upc", namespace: "", normalizedValue: String(index), targetProductId: `p-${index}`, version: 1, predecessorFingerprint: `f-${index}`, predecessorSource: "configured" }));
    const listIdentityReviews = vi.fn().mockRejectedValue(new Error("unbounded review read"));
    const listCurrentIdentityLinks = vi.fn().mockRejectedValue(new Error("unbounded link read"));
    const pageIdentityReviews = vi.fn().mockResolvedValue({ items: reviews, total: 100, bucketTotals: { automatic: 0, review: 100, abstain: 0, non_product: 0, invalid: 0 } });
    const findCurrentIdentityLinks = vi.fn().mockResolvedValue([]);
    const pageCurrentApprovedLinks = vi.fn().mockResolvedValue({ items: links, total: 500 });
    const { handler } = route({ repository: { listIdentityReviews, listCurrentIdentityLinks, pageIdentityReviews, findCurrentIdentityLinks } as never, currentApprovedLinks: undefined, pageCurrentApprovedLinks } as never);

    const response = await handler(new Request("http://local/api/identity/reviews?businessId=shop-a&page=1&linkPage=1&pageSize=25"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.reviews).toHaveLength(25);
    expect(body.currentApprovedLinks).toHaveLength(25);
    expect(body).toMatchObject({ total: 100, linkTotal: 500, pageSize: 25 });
    expect(pageIdentityReviews).toHaveBeenCalledWith("shop-a", { page: 1, pageSize: 25 });
    expect(findCurrentIdentityLinks).toHaveBeenCalledWith("shop-a", expect.any(Array));
    expect(pageCurrentApprovedLinks).toHaveBeenCalledWith("shop-a", { page: 1, pageSize: 25 });
    expect(listIdentityReviews).not.toHaveBeenCalled();
    expect(listCurrentIdentityLinks).not.toHaveBeenCalled();
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

  it("revokes a globally scoped UPC link with an empty namespace but rejects an unscoped vendor SKU", async () => {
    const upcLink = { businessId: "shop-a", sourceSystem: "demo", vendorId: "vendor-a", sourceSignature: "demo-v1", identifierType: "upc" as const, namespace: "", normalizedValue: "012345678905", targetProductId: "tire-a", version: 1, predecessorFingerprint: "upc-fingerprint", predecessorSource: "configured" as const };
    const standaloneUpcLink = { sourceSystem: upcLink.sourceSystem, vendorId: upcLink.vendorId, sourceSignature: upcLink.sourceSignature, identifierType: upcLink.identifierType, namespace: upcLink.namespace, normalizedValue: upcLink.normalizedValue, targetProductId: upcLink.targetProductId, version: upcLink.version, predecessorFingerprint: upcLink.predecessorFingerprint, predecessorSource: upcLink.predecessorSource };
    const revokeIdentityLink = vi.fn().mockResolvedValue({ ...upcLink, status: "revoked", version: 2 });
    const { handler } = route({ currentApprovedLinks: vi.fn().mockResolvedValue([upcLink]), repository: { listIdentityReviews: vi.fn().mockResolvedValue([]), revokeIdentityLink } as never });
    const revoked = await handler(new Request("http://local/api/identity/reviews", { method: "POST", body: JSON.stringify({ businessId: "shop-a", action: "revoke_link", link: standaloneUpcLink }) }));
    expect(revoked.status).toBe(200);
    expect(revokeIdentityLink).toHaveBeenCalledWith(expect.objectContaining({ link: expect.objectContaining({ identifierType: "upc", namespace: "" }), predecessor: { source: "configured", fingerprint: "upc-fingerprint", version: 1 } }));

    const vendorSku = { ...standaloneUpcLink, identifierType: "vendor_sku", normalizedValue: "SKU-1", predecessorFingerprint: "vendor-fingerprint" };
    const rejected = await handler(new Request("http://local/api/identity/reviews", { method: "POST", body: JSON.stringify({ businessId: "shop-a", action: "revoke_link", link: vendorSku }) }));
    expect(rejected.status).toBe(400);
    expect(revokeIdentityLink).toHaveBeenCalledTimes(1);
  });

  it("maps a standalone-link revoke race to a safe conflict response", async () => {
    const link = { businessId: "shop-a", sourceSystem: "demo", vendorId: "vendor-a", sourceSignature: "demo-v1", identifierType: "upc" as const, namespace: "", normalizedValue: "012345678905", targetProductId: "tire-a", version: 1, predecessorFingerprint: "raced", predecessorSource: "durable" as const };
    const standaloneLink = { sourceSystem: link.sourceSystem, vendorId: link.vendorId, sourceSignature: link.sourceSignature, identifierType: link.identifierType, namespace: link.namespace, normalizedValue: link.normalizedValue, targetProductId: link.targetProductId, version: link.version, predecessorFingerprint: link.predecessorFingerprint, predecessorSource: link.predecessorSource };
    const { handler } = route({ currentApprovedLinks: vi.fn().mockResolvedValue([link]), repository: { listIdentityReviews: vi.fn().mockResolvedValue([]), revokeIdentityLink: vi.fn().mockRejectedValue(new Error("identity_link_revoke_conflict")) } as never });
    const response = await handler(new Request("http://local/api/identity/reviews", { method: "POST", body: JSON.stringify({ businessId: "shop-a", action: "revoke_link", link: standaloneLink }) }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "The identity review changed before this action could be applied." });
  });

  it("rejects an empty barcode namespace but accepts the same scoped barcode link", async () => {
    const barcode = { businessId: "shop-a", sourceSystem: "demo", vendorId: "vendor-a", sourceSignature: "demo-v1", identifierType: "barcode" as const, namespace: "vendor-a", normalizedValue: "BC-1", targetProductId: "tire-a", version: 1, predecessorFingerprint: "barcode-fingerprint", predecessorSource: "configured" as const };
    const standalone = { sourceSystem: barcode.sourceSystem, vendorId: barcode.vendorId, sourceSignature: barcode.sourceSignature, identifierType: barcode.identifierType, namespace: barcode.namespace, normalizedValue: barcode.normalizedValue, targetProductId: barcode.targetProductId, version: barcode.version, predecessorFingerprint: barcode.predecessorFingerprint, predecessorSource: barcode.predecessorSource };
    const revokeIdentityLink = vi.fn().mockResolvedValue({ ...barcode, status: "revoked", version: 2 });
    const { handler } = route({ currentApprovedLinks: vi.fn().mockResolvedValue([barcode]), repository: { listIdentityReviews: vi.fn().mockResolvedValue([]), revokeIdentityLink } as never });
    const rejected = await handler(new Request("http://local/api/identity/reviews", { method: "POST", body: JSON.stringify({ businessId: "shop-a", action: "revoke_link", link: { ...standalone, namespace: "" } }) }));
    expect(rejected.status).toBe(400);
    const accepted = await handler(new Request("http://local/api/identity/reviews", { method: "POST", body: JSON.stringify({ businessId: "shop-a", action: "revoke_link", link: standalone }) }));
    expect(accepted.status).toBe(200);
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
