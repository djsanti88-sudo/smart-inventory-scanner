import type { AtomicLocalStorage, AtomicTransaction } from "./atomicLocalStorage";
import type { AggregateImportEvent, IdentityLink, IdentityReview, ReviewAction, TenantIdentityProduct } from "@/services/identity/types";
import { canonicalSha256 } from "@/services/identity/canonical";
import { validateAggregateImportEvent } from "@/services/identity/importLedger";

const reviewsKey = "identity-reviews";
const productsKey = "identity-tenant-products";
const linksKey = "identity-links";
const operationsKey = "identity-operations";
const ledgerKey = "aggregate-ledger";

type StoredLedger = { event: AggregateImportEvent; idempotencyKey: string; fingerprint: string; operationFingerprint?: string };
type StoredOperation = { businessId: string; importId: string; rowId: string; idempotencyKey: string; payloadFingerprint: string; operationFingerprint: string; eventFingerprint: string; state: "applied"; result: unknown };
type CountPlan = { event: AggregateImportEvent; operationFingerprint: string; result: unknown; operationIdempotencyKey: string };
type ConfiguredCurrentLink = Pick<IdentityLink, "businessId" | "sourceSystem" | "vendorId" | "sourceSignature" | "identifierType" | "namespace" | "normalizedValue" | "targetProductId" | "status" | "version">;
export type LocalAtomicReviewCountedApplyInput = {
  businessId: string; reviewId: string; actionId: string; payloadFingerprint: string;
  action: ReviewAction["action"]; resolution: NonNullable<IdentityReview["resolution"]>; resolvedBy: string;
  targetProductId?: string; link?: IdentityLink; product?: TenantIdentityProduct; count?: CountPlan; configuredCurrentLink?: ConfiguredCurrentLink;
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
async function sameResult(left: unknown, right: unknown): Promise<boolean> { return await canonicalSha256(left) === await canonicalSha256(right); }

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
      const count = current.reviewAction.countResult;
      const context = current.signedRowContext;
      const expectsCount = context?.mode === "physical_count" && ["confirm_candidate", "create_tenant_product"].includes(current.reviewAction.action);
      if (Boolean(count) !== expectsCount) return { kind: "idempotency_conflict" };
      if (count) {
        if (!count.eventFingerprint || !count.operationFingerprint || !count.eventIdempotencyKey || !count.operationIdempotencyKey) return { kind: "idempotency_conflict" };
        const entries = (await transaction.get<Record<string, StoredLedger>>(ledgerKey)) ?? {};
        const stored = entries[eventKey(current.businessId, count.eventIdempotencyKey)];
        const operations = (await transaction.get<Record<string, StoredOperation>>(operationsKey)) ?? {};
        const operation = operations[operationKey({ businessId: current.businessId, importId: current.importId, rowId: `review-count:${current.reviewId}` })];
        const expectedOperationFingerprint = await canonicalSha256({ reviewId: current.reviewId, payloadFingerprint: current.reviewAction.payloadFingerprint, eventFingerprint: stored?.event.fingerprint });
        if (!stored || stored.idempotencyKey !== count.eventIdempotencyKey || stored.event.idempotencyKey !== count.eventIdempotencyKey
          || !context || !await validateAggregateImportEvent(stored.event)
          || stored.event.eventId !== count.eventId || stored.event.quantity !== count.quantity || stored.event.productId !== current.reviewAction.targetProductId
          || stored.event.businessId !== current.businessId || stored.event.importId !== current.importId || stored.event.rowId !== `review-count:${current.reviewId}`
          || stored.event.sessionId !== context.sessionId || stored.event.quantity !== context.quantity || stored.event.unitOfMeasure !== context.unitOfMeasure
          || stored.event.sourceFileOrdinal !== context.sourceFileOrdinal || stored.event.sheetName !== context.sheetName
          || stored.event.sourceRowNumber !== context.sourceRowNumber || stored.event.createdAt !== context.eventCreatedAt
          || stored.event.fingerprint !== count.eventFingerprint || stored.fingerprint !== count.eventFingerprint
          || count.operationFingerprint !== expectedOperationFingerprint || stored.operationFingerprint !== count.operationFingerprint || operation?.state !== "applied" || operation.idempotencyKey !== count.operationIdempotencyKey
          || operation.businessId !== current.businessId || operation.importId !== current.importId || operation.rowId !== `review-count:${current.reviewId}`
          || operation.payloadFingerprint !== current.reviewAction.payloadFingerprint || operation.operationFingerprint !== count.operationFingerprint
          || operation.eventFingerprint !== count.eventFingerprint || !await sameResult(operation.result, count.result)) return { kind: "idempotency_conflict" };
      }
      return { kind: "replayed", review: current, action: current.reviewAction, ...(current.reviewAction.link ? { link: current.reviewAction.link } : {}), ...(current.reviewAction.product ? { product: current.reviewAction.product } : {}) };
    }
    if (current.resolution) return { kind: "idempotency_conflict" };
    if (input.revalidate && !await input.revalidate(transaction, current)) return { kind: "stale" };

    // Every caller-supplied mutation is bound to this tenant review before any write.
    const expectsCount = current.signedRowContext?.mode === "physical_count" && ["confirm_candidate", "create_tenant_product"].includes(input.action);
    if (Boolean(input.count) !== expectsCount) return { kind: "idempotency_conflict" };
    if ((input.targetProductId && input.link && input.link.targetProductId !== input.targetProductId)
      || (input.product && (input.product.businessId !== input.businessId || input.targetProductId !== input.product.productId))
      || (input.link && (input.link.businessId !== input.businessId || input.link.targetProductId !== input.targetProductId))
      || (input.action === "create_tenant_product" && (!input.product || !input.link || input.targetProductId !== input.product.productId))
      || (input.action === "confirm_candidate" && (!input.targetProductId || !input.link))
      || (input.action === "reject" && (input.targetProductId || input.link || input.product))) return { kind: "idempotency_conflict" };
    if (input.count) {
      const context = current.signedRowContext;
      const event = input.count.event;
      if (!context || context.mode !== "physical_count" || !input.targetProductId || !["confirm_candidate", "create_tenant_product"].includes(input.action)
        || event.businessId !== input.businessId || event.importId !== current.importId || event.rowId !== `review-count:${current.reviewId}`
        || event.sessionId !== context.sessionId || event.productId !== input.targetProductId || event.quantity !== context.quantity
        || event.unitOfMeasure !== context.unitOfMeasure || event.sourceFileOrdinal !== context.sourceFileOrdinal || event.sheetName !== context.sheetName
        || event.sourceRowNumber !== context.sourceRowNumber || event.createdAt !== context.eventCreatedAt
        || input.count.operationIdempotencyKey !== `identity-review-count:${current.reviewId}`) return { kind: "idempotency_conflict" };
    }

    let product = input.product;
    let productsToWrite: TenantIdentityProduct[] | undefined;
    if (product) {
      const products = (await transaction.get<TenantIdentityProduct[]>(productsKey)) ?? [];
      const stored = products.find((item) => item.businessId === product!.businessId && item.productId === product!.productId);
      if (!stored) { products.push(product); productsToWrite = products; } else product = stored;
    }
    let link = input.link;
    let linksToWrite: IdentityLink[] | undefined;
    let previousTargetProductId: string | undefined;
    if (link) {
      const links = (await transaction.get<IdentityLink[]>(linksKey)) ?? [];
      const family = links.filter((item) => item.businessId === link!.businessId && item.sourceSystem === link!.sourceSystem && item.vendorId === link!.vendorId && item.sourceSignature === link!.sourceSignature && item.identifierType === link!.identifierType && item.namespace === link!.namespace && item.normalizedValue === link!.normalizedValue);
      const durable = latest(family);
      const configured = input.configuredCurrentLink && input.configuredCurrentLink.businessId === input.businessId
        && input.configuredCurrentLink.sourceSystem === link.sourceSystem && input.configuredCurrentLink.vendorId === link.vendorId
        && input.configuredCurrentLink.sourceSignature === link.sourceSignature && input.configuredCurrentLink.identifierType === link.identifierType
        && input.configuredCurrentLink.namespace === link.namespace && input.configuredCurrentLink.normalizedValue === link.normalizedValue
        ? input.configuredCurrentLink : undefined;
      // A durable tombstone or approval is authoritative for its family; otherwise the immutable configured predecessor applies.
      const old = durable ?? configured;
      previousTargetProductId = old?.status === "approved" ? old.targetProductId : undefined;
      if ((input.action === "revoke_link" && (!old || old.status !== "approved" || old.targetProductId !== link.targetProductId)) || (input.action !== "revoke_link" && old?.status === "approved" && old.targetProductId !== link.targetProductId)) return { kind: "stale" };
      link = { ...link, version: (old?.version ?? 0) + 1, status: input.action === "revoke_link" ? "revoked" : "approved" };
      links.push(link); linksToWrite = links;
    }
    let countResult: ReviewAction["countResult"];
    let entriesToWrite: Record<string, StoredLedger> | undefined;
    let operationsToWrite: Record<string, StoredOperation> | undefined;
    let countSession: { businessId: string; sessionId: string } | undefined;
    if (input.count) {
      const entries = (await transaction.get<Record<string, StoredLedger>>(ledgerKey)) ?? {};
      const key = eventKey(input.count.event.businessId, input.count.event.idempotencyKey), stored = entries[key];
      if (stored && (stored.fingerprint !== input.count.event.fingerprint || stored.operationFingerprint !== input.count.operationFingerprint)) return { kind: "idempotency_conflict" };
      const event = stored?.event ?? input.count.event;
      if (!stored) entries[key] = { event, idempotencyKey: event.idempotencyKey, fingerprint: event.fingerprint, operationFingerprint: input.count.operationFingerprint };
      const operations = (await transaction.get<Record<string, StoredOperation>>(operationsKey)) ?? {};
      const operation: StoredOperation = { businessId: event.businessId, importId: event.importId, rowId: event.rowId, idempotencyKey: input.count.operationIdempotencyKey, payloadFingerprint: input.payloadFingerprint, operationFingerprint: input.count.operationFingerprint, eventFingerprint: event.fingerprint, state: "applied", result: input.count.result };
      const existing = operations[operationKey(operation)];
      if (existing && (existing.idempotencyKey !== operation.idempotencyKey || existing.payloadFingerprint !== operation.payloadFingerprint || existing.operationFingerprint !== operation.operationFingerprint || existing.eventFingerprint !== operation.eventFingerprint || !await sameResult(existing.result, operation.result))) return { kind: "idempotency_conflict" };
      operations[operationKey(operation)] = existing ?? operation;
      entriesToWrite = entries;
      operationsToWrite = operations;
      countSession = { businessId: event.businessId, sessionId: event.sessionId };
      countResult = { kind: stored ? "completed" : "applied", eventId: event.eventId, quantity: event.quantity, result: existing?.result ?? input.count.result, eventFingerprint: event.fingerprint, operationFingerprint: input.count.operationFingerprint, eventIdempotencyKey: event.idempotencyKey, operationIdempotencyKey: input.count.operationIdempotencyKey };
    }
    const resolvedAt = new Date(now()).toISOString();
    const outcome: ReviewAction["outcome"] = input.action === "confirm_candidate" ? "confirmed" : input.action === "create_tenant_product" ? "create_product" : input.action === "revoke_link" ? "revoked" : "rejected";
    const action: ReviewAction = { actionId: input.actionId, payloadFingerprint: input.payloadFingerprint, action: input.action, ...(input.targetProductId ? { targetProductId: input.targetProductId } : {}), ...(link ? { link } : {}), ...(product ? { productId: product.productId, product } : {}), ...(previousTargetProductId ? { previousTargetProductId } : {}), outcome, resolvedBy: input.resolvedBy, resolvedAt, ...(countResult ? { countResult } : {}) };
    const review: IdentityReview = { ...current, resolution: input.resolution, resolvedBy: input.resolvedBy, resolvedAt, reviewAction: action };
    if (productsToWrite) await transaction.set(productsKey, productsToWrite);
    if (linksToWrite) await transaction.set(linksKey, linksToWrite);
    if (entriesToWrite && operationsToWrite && countSession) {
      await transaction.set(ledgerKey, entriesToWrite);
      await transaction.set(operationsKey, operationsToWrite);
      await writeProjection(transaction, entriesToWrite, countSession.businessId, countSession.sessionId);
    }
    reviews[index] = review; await transaction.set(reviewsKey, reviews);
    return { kind: "applied", review, action, ...(link ? { link } : {}), ...(product ? { product } : {}) };
  });
}
