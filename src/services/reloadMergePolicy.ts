import type { Alias, PendingSyncItem, Product, UnknownCodeReview } from "@/types";

export function mergeReloadedProductsAndAliases(params: {
  businessId: string;
  localProducts: Product[];
  remoteProducts: Product[];
  localAliases: Alias[];
  remoteAliases: Alias[];
  pendingSyncQueue: PendingSyncItem[];
}): { products: Product[]; aliases: Alias[] } {
  const tenantPendingQueue = params.pendingSyncQueue.filter((item) => item.businessId === params.businessId);
  const pendingProductIds = new Set(
    tenantPendingQueue.filter((item) => item.operation === "SAVE_PRODUCT").map((item) => item.entityId),
  );
  const pendingAliasIds = new Set(
    tenantPendingQueue.filter((item) => item.operation === "RESOLVE_ALIAS").map((item) => item.entityId),
  );

  const productsById = new Map(params.localProducts.map((product) => [product.id, product]));
  for (const remote of params.remoteProducts) {
    const local = productsById.get(remote.id);
    if (pendingProductIds.has(remote.id)) continue;
    if (local?.status === "archived" && remote.status !== "archived") continue;
    productsById.set(remote.id, remote);
  }

  const aliasesById = new Map(params.localAliases.map((alias) => [alias.id, alias]));
  for (const remote of params.remoteAliases) {
    if (pendingAliasIds.has(remote.id)) continue;
    aliasesById.set(remote.id, remote);
  }

  return {
    products: [...productsById.values()],
    aliases: [...aliasesById.values()],
  };
}

export function mergeReloadedReviews(params: {
  businessId: string;
  localReviews: UnknownCodeReview[];
  remoteReviews: UnknownCodeReview[];
  pendingSyncQueue: PendingSyncItem[];
}): UnknownCodeReview[] {
  const pendingReviewIds = new Set(
    params.pendingSyncQueue
      .filter((item) => item.businessId === params.businessId && item.operation === "SAVE_UNKNOWN_SCAN")
      .map((item) => item.entityId),
  );
  const reviewsById = new Map(
    params.localReviews.filter((review) => review.businessId === params.businessId).map((review) => [review.id, review]),
  );
  for (const remote of params.remoteReviews) {
    if (remote.businessId !== params.businessId || pendingReviewIds.has(remote.id)) continue;
    const local = reviewsById.get(remote.id);
    if (local) {
      const localDecisionAt = local.decisionUpdatedAt ??
        ((local.status === "resolved" || local.status === "ignored") ? local.resolvedAt ?? "" : "");
      const remoteDecisionAt = remote.decisionUpdatedAt ??
        ((remote.status === "resolved" || remote.status === "ignored") ? remote.resolvedAt ?? "" : "");
      // Legacy/stale open snapshots have no decision clock. They can never erase a known terminal
      // decision; a genuine later reopen carries decisionUpdatedAt and wins by normal ordering.
      if (localDecisionAt && (!remoteDecisionAt || localDecisionAt > remoteDecisionAt)) continue;
    }
    reviewsById.set(remote.id, remote);
  }
  return [...reviewsById.values()];
}
