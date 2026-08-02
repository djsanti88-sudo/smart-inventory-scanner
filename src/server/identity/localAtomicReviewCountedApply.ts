import type { AtomicLocalStorage, AtomicTransaction } from "./atomicLocalStorage";
import type { AggregateImportEvent, IdentityLink, IdentityReview, ReviewAction, TenantIdentityProduct } from "@/services/identity/types";

const reviewsKey = "identity-reviews";
const productsKey = "identity-tenant-products";
const linksKey = "identity-links";
const operationsKey = "identity-operations";
const ledgerKey = "aggregate-ledger";

type StoredLedger = { event: AggregateImportEvent; idempotencyKey: string; fingerprint: string; operationFingerprint?: string };
type StoredOperation = { businessId: string; importId: string; rowId: string; idempotencyKey: string; payloadFingerprint: string; state: "applied"; result: unknown };
type CountPlan = { event: AggregateImportEvent; operationFingerprint: string; result: unknown };
export type LocalAtomicReviewCountedApplyInput = {
  businessId: string; reviewId: string; actionId: string; payloadFingerprint: string;
  action: ReviewAction["action"]; resolution: NonNullable<IdentityReview["resolution"]>; resolvedBy: string;
  targetProductId?: string; link?: IdentityLink; product?: TenantIdentityProduct; count?: CountPlan;
  /** Runs only for a new action while the same storage transaction owns the state. */
  revalidate?: (transaction: AtomicTransaction, review: IdentityReview) => Promise<boolean>;
};
export type LocalAtomicReviewCountedApplyResult =
  | { kind: "applied" | "replayed"; review: IdentityReview; action: ReviewAction; link?: IdentityLink; product?: TenantIdentityProduct }
  | { kind: "stale" | "idempotency_conflict" };
type ProjectionWriter = (transaction: AtomicTransaction, entries: Readonly<Record<string, StoredLedger>>, businessId: string, sessionId: string) => Promise<unknown>;
const defaultProjectionWriter: ProjectionWriter = async (transaction, entries, businessId, sessionId) => {
  const { writeLocalInventoryProjection } = await import("./localInventoryProjection");
  return writeLocalInventoryProjection(transaction, entries, businessId, sessionId);
};
function operationKey(input: Pick<StoredOperation, "businessId" | "importId" | "rowId">): string { return JSON.stringify([input.businessId, input.importId, input.rowId]); }
function eventKey(businessId: string, idempotencyKey: string): string { return JSON.stringify([businessId, idempotencyKey]); }
function sameAction(action: ReviewAction, input: LocalAtomicReviewCountedApplyInput): boolean { return action.actionId === input.actionId && action.payloadFingerprint === input.payloadFingerprint; }
function latest<T extends { version: number }>(items: readonly T[]): T | undefined { return items.reduce<T | undefined>((current, item) => !current || item.version > current.version ? item : current, undefined); }

/**
 * Owns the complete local review mutation.  Replays are classified from the stored immutable
 * action before freshness; a new action stages review, link/product, operation, ledger and
 * projection in exactly one AtomicLocalStorage transaction.
 */
export function createLocalAtomicReviewCountedApply(storage: AtomicLocalStorage, { now = Date.now, writeProjection = defaultProjectionWriter }: { now?: () => number; writeProjection?: ProjectionWriter } = {}) {
  return async (input: LocalAtomicReviewCountedApplyInput): Promise<LocalAtomicReviewCountedApplyResult> => storage.transaction(async (transaction) => {
    const reviews = (await transaction.get<IdentityReview[]>(reviewsKey)) ?? [];
    const index = reviews.findIndex((review) => review.businessId === input.businessId && review.reviewId === input.reviewId);
    if (index < 0) throw new Error(`Unknown identity review ${input.reviewId}`);
    const current = reviews[index]!;
    if (current.reviewAction) {
      if (!sameAction(current.reviewAction, input)) return { kind: "idempotency_conflict" };
      return { kind: "replayed", review: current, action: current.reviewAction, ...(current.reviewAction.link ? { link: current.reviewAction.link } : {}), ...(current.reviewAction.product ? { product: current.reviewAction.product } : {}) };
    }
    if (current.resolution) return { kind: "idempotency_conflict" };
    if (input.revalidate && !await input.revalidate(transaction, current)) return { kind: "stale" };

    let product = input.product;
    if (product) {
      const products = (await transaction.get<TenantIdentityProduct[]>(productsKey)) ?? [];
      const stored = products.find((item) => item.businessId === product!.businessId && item.productId === product!.productId);
      if (!stored) { products.push(product); await transaction.set(productsKey, products); } else product = stored;
    }
    let link = input.link;
    let previousTargetProductId: string | undefined;
    if (link) {
      const links = (await transaction.get<IdentityLink[]>(linksKey)) ?? [];
      const family = links.filter((item) => item.businessId === link!.businessId && item.sourceSystem === link!.sourceSystem && item.vendorId === link!.vendorId && item.sourceSignature === link!.sourceSignature && item.identifierType === link!.identifierType && item.namespace === link!.namespace && item.normalizedValue === link!.normalizedValue);
      const old = latest(family); previousTargetProductId = old?.status === "approved" ? old.targetProductId : undefined;
      if ((input.action === "revoke_link" && (!old || old.status !== "approved" || old.targetProductId !== link.targetProductId)) || (input.action !== "revoke_link" && old?.status === "approved" && old.targetProductId !== link.targetProductId)) return { kind: "stale" };
      link = { ...link, version: (old?.version ?? 0) + 1, status: input.action === "revoke_link" ? "revoked" : "approved" };
      links.push(link); await transaction.set(linksKey, links);
    }
    let countResult: ReviewAction["countResult"];
    if (input.count) {
      const entries = (await transaction.get<Record<string, StoredLedger>>(ledgerKey)) ?? {};
      const key = eventKey(input.count.event.businessId, input.count.event.idempotencyKey), stored = entries[key];
      if (stored && (stored.fingerprint !== input.count.event.fingerprint || stored.operationFingerprint !== input.count.operationFingerprint)) return { kind: "idempotency_conflict" };
      const event = stored?.event ?? input.count.event;
      if (!stored) entries[key] = { event, idempotencyKey: event.idempotencyKey, fingerprint: event.fingerprint, operationFingerprint: input.count.operationFingerprint };
      const operations = (await transaction.get<Record<string, StoredOperation>>(operationsKey)) ?? {};
      const operation: StoredOperation = { businessId: event.businessId, importId: event.importId, rowId: event.rowId, idempotencyKey: event.idempotencyKey, payloadFingerprint: input.payloadFingerprint, state: "applied", result: input.count.result };
      const existing = operations[operationKey(operation)];
      if (existing && (existing.idempotencyKey !== operation.idempotencyKey || existing.payloadFingerprint !== operation.payloadFingerprint)) return { kind: "idempotency_conflict" };
      operations[operationKey(operation)] = existing ?? operation;
      await transaction.set(ledgerKey, entries);
      await transaction.set(operationsKey, operations);
      await writeProjection(transaction, entries, event.businessId, event.sessionId);
      countResult = { kind: stored ? "completed" : "applied", eventId: event.eventId, quantity: event.quantity };
    }
    const resolvedAt = new Date(now()).toISOString();
    const outcome: ReviewAction["outcome"] = input.action === "confirm_candidate" ? "confirmed" : input.action === "create_tenant_product" ? "create_product" : input.action === "revoke_link" ? "revoked" : "rejected";
    const action: ReviewAction = { actionId: input.actionId, payloadFingerprint: input.payloadFingerprint, action: input.action, ...(input.targetProductId ? { targetProductId: input.targetProductId } : {}), ...(link ? { link } : {}), ...(product ? { productId: product.productId, product } : {}), ...(previousTargetProductId ? { previousTargetProductId } : {}), outcome, resolvedBy: input.resolvedBy, resolvedAt, ...(countResult ? { countResult } : {}) };
    const review: IdentityReview = { ...current, resolution: input.resolution, resolvedBy: input.resolvedBy, resolvedAt, reviewAction: action };
    reviews[index] = review; await transaction.set(reviewsKey, reviews);
    return { kind: "applied", review, action, ...(link ? { link } : {}), ...(product ? { product } : {}) };
  });
}
