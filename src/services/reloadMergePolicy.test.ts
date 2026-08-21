import { describe, expect, it } from "vitest";
import { mergeReloadedProductsAndAliases, mergeReloadedReviews } from "@/services/reloadMergePolicy";
import type { Alias, PendingSyncItem, Product, UnknownCodeReview } from "@/types";

const BUSINESS_ID = "business-reload";

function product(id: string, name: string, status: Product["status"] = "active"): Product {
  return { id, businessId: BUSINESS_ID, name, status } as Product;
}

function alias(id: string, cleanCode: string): Alias {
  return { id, businessId: BUSINESS_ID, cleanCode } as Alias;
}

function review(id: string, reason: string, businessId = BUSINESS_ID): UnknownCodeReview {
  return { id, businessId, reason } as UnknownCodeReview;
}

function pending(
  id: string,
  operation: PendingSyncItem["operation"],
  entityId: string,
): PendingSyncItem {
  return {
    id,
    businessId: BUSINESS_ID,
    sessionId: "session-reload",
    entityType: operation === "SAVE_PRODUCT" ? "Product" : operation === "RESOLVE_ALIAS" ? "Alias" : "UnknownCodeReview",
    entityId,
    operation,
    payload: {},
    status: "pending",
    retryCount: 0,
    lastError: null,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    idempotencyKey: `key-${id}`,
    scanEventId: null,
  };
}

describe("reload merge policy", () => {
  it("keeps pending local identities while accepting non-pending and remote-only identities", () => {
    const result = mergeReloadedProductsAndAliases({
      businessId: BUSINESS_ID,
      localProducts: [product("pending", "local pending"), product("settled", "local settled")],
      remoteProducts: [product("pending", "remote stale"), product("settled", "remote fresh"), product("new", "remote new")],
      localAliases: [alias("pending-alias", "LOCAL"), alias("settled-alias", "OLD")],
      remoteAliases: [alias("pending-alias", "STALE"), alias("settled-alias", "FRESH")],
      pendingSyncQueue: [
        pending("product-write", "SAVE_PRODUCT", "pending"),
        pending("alias-write", "RESOLVE_ALIAS", "pending-alias"),
      ],
    });

    expect(Object.fromEntries(result.products.map((entry) => [entry.id, entry.name]))).toEqual({
      pending: "local pending",
      settled: "remote fresh",
      new: "remote new",
    });
    expect(Object.fromEntries(result.aliases.map((entry) => [entry.id, entry.cleanCode]))).toEqual({
      "pending-alias": "LOCAL",
      "settled-alias": "FRESH",
    });
  });

  it("does not resurrect a locally archived product from a stale active snapshot", () => {
    const result = mergeReloadedProductsAndAliases({
      businessId: BUSINESS_ID,
      localProducts: [product("archived", "local archive", "archived")],
      remoteProducts: [product("archived", "remote active", "active")],
      localAliases: [],
      remoteAliases: [],
      pendingSyncQueue: [],
    });

    expect(result.products).toEqual([product("archived", "local archive", "archived")]);
  });

  it("restores only same-tenant reviews and keeps an unsynced local review authoritative", () => {
    const result = mergeReloadedReviews({
      businessId: BUSINESS_ID,
      localReviews: [review("pending-review", "local")],
      remoteReviews: [
        review("pending-review", "remote stale"),
        review("remote-review", "remote current"),
        review("foreign-review", "foreign", "business-foreign"),
      ],
      pendingSyncQueue: [pending("review-write", "SAVE_UNKNOWN_SCAN", "pending-review")],
    });

    expect(result.map(({ id, reason }) => ({ id, reason }))).toEqual([
      { id: "pending-review", reason: "local" },
      { id: "remote-review", reason: "remote current" },
    ]);
  });

  it("does not resurrect a terminal local decision from a stale remote open snapshot", () => {
    const local = {
      ...review("terminal-review", "ignored here"),
      status: "ignored",
      resolvedAt: "2026-08-20T12:00:00.000Z",
      decisionUpdatedAt: "2026-08-20T12:00:00.000Z",
    } as UnknownCodeReview;
    const staleRemote = {
      ...review("terminal-review", "stale cloud open"),
      status: "open",
      createdAt: "2026-08-20T11:00:00.000Z",
      resolvedAt: null,
    } as UnknownCodeReview;

    const result = mergeReloadedReviews({
      businessId: BUSINESS_ID,
      localReviews: [local],
      remoteReviews: [staleRemote],
      pendingSyncQueue: [],
    });

    expect(result).toEqual([local]);
  });

  it("accepts a later durable reopen over an older terminal decision", () => {
    const local = {
      ...review("reopened-review", "resolved here"),
      status: "resolved",
      resolvedAt: "2026-08-20T12:00:00.000Z",
      decisionUpdatedAt: "2026-08-20T12:00:00.000Z",
    } as UnknownCodeReview;
    const remote = {
      ...review("reopened-review", "reopened elsewhere"),
      status: "open",
      resolvedAt: null,
      decisionUpdatedAt: "2026-08-20T12:05:00.000Z",
    } as UnknownCodeReview;

    expect(mergeReloadedReviews({
      businessId: BUSINESS_ID,
      localReviews: [local],
      remoteReviews: [remote],
      pendingSyncQueue: [],
    })).toEqual([remote]);
  });
});
