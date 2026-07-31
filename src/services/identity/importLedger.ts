import { canonicalSha256 } from "./canonical";
import type { AggregateImportEvent, IdentityDecisionKind } from "./types";
import { MAX_IMPORT_QUANTITY } from "../importQuantity";

export { MAX_IMPORT_QUANTITY } from "../importQuantity";

type EligibleDecision =
  | { kind: "automatic"; targetProductId: string }
  | { kind: "review"; approvedProductId: string };

type IneligibleDecision = {
  kind: IdentityDecisionKind;
  targetProductId?: string;
  approvedProductId?: never;
};

export interface AggregateImportRow {
  businessId: string;
  importId: string;
  rowId: string;
  sessionId: string;
  quantity: number;
  sourceFileOrdinal: number;
  sheetName: string;
  sourceRowNumber: number;
  createdAt: string;
}

export type AggregateImportPlanInput =
  | (AggregateImportRow & { mode: "reconcile"; decision: EligibleDecision | IneligibleDecision })
  | (AggregateImportRow & { mode: "physical_count"; decision: EligibleDecision | IneligibleDecision });

export type CreateAggregateImportEventInput = AggregateImportRow & {
  mode: "physical_count";
  decision: EligibleDecision;
};

export interface InventoryCountDelta {
  eventId: string;
  idempotencyKey: string;
  businessId: string;
  productId: string;
  sessionId: string;
  quantityDelta: number;
  createdAt: string;
}

function resolvedProductId(decision: EligibleDecision | IneligibleDecision): string | null {
  if (decision.kind === "automatic") return decision.targetProductId || null;
  if (decision.kind === "review") return decision.approvedProductId || null;
  return null;
}

function assertQuantity(quantity: number): void {
  if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > MAX_IMPORT_QUANTITY) {
    throw new Error(`aggregate import quantity must be a safe integer from 0 to ${MAX_IMPORT_QUANTITY}`);
  }
}

function canonicalEventPayload(event: Omit<AggregateImportEvent, "fingerprint">): Omit<AggregateImportEvent, "fingerprint"> {
  return event;
}

export async function createAggregateImportEvent(input: CreateAggregateImportEventInput): Promise<AggregateImportEvent> {
  assertQuantity(input.quantity);
  const productId = resolvedProductId(input.decision);
  if (!productId) throw new Error("aggregate import requires an automatic or approved product resolution");

  const identity = { businessId: input.businessId, importId: input.importId, rowId: input.rowId };
  const eventId = `aggregate-import:${await canonicalSha256({ domain: "event", ...identity })}`;
  const idempotencyKey = `aggregate-import:${await canonicalSha256({ domain: "idempotency", ...identity })}`;
  const event = {
    kind: "aggregate_import" as const,
    eventId,
    idempotencyKey,
    importId: input.importId,
    rowId: input.rowId,
    businessId: input.businessId,
    productId,
    sessionId: input.sessionId,
    quantity: input.quantity,
    unitOfMeasure: "each" as const,
    sourceFileOrdinal: input.sourceFileOrdinal,
    sheetName: input.sheetName,
    sourceRowNumber: input.sourceRowNumber,
    createdAt: input.createdAt,
  };
  return { ...event, fingerprint: await canonicalSha256(canonicalEventPayload(event)) };
}

/** Returns null for reconcile, invalid, non-product, review, abstain, or unresolved rows. */
export async function planAggregateImportEvent(input: AggregateImportPlanInput): Promise<AggregateImportEvent | null> {
  if (input.mode !== "physical_count") return null;
  const productId = resolvedProductId(input.decision);
  if (!productId) return null;
  return createAggregateImportEvent({ ...input, decision: input.decision.kind === "automatic"
    ? { kind: "automatic", targetProductId: productId }
    : { kind: "review", approvedProductId: productId } });
}

/** Validates the identity-bearing fields before an aggregate event reaches durable accounting. */
export async function validateAggregateImportEvent(event: AggregateImportEvent): Promise<boolean> {
  try {
    assertQuantity(event.quantity);
    if (
      event.kind !== "aggregate_import" ||
      event.unitOfMeasure !== "each" ||
      !event.businessId.trim() ||
      !event.importId.trim() ||
      !event.rowId.trim() ||
      !event.productId.trim() ||
      !event.sessionId.trim() ||
      !Number.isSafeInteger(event.sourceFileOrdinal) || event.sourceFileOrdinal < 0 ||
      !Number.isSafeInteger(event.sourceRowNumber) || event.sourceRowNumber <= 0 ||
      !event.sheetName.trim() ||
      Number.isNaN(Date.parse(event.createdAt))
    ) return false;
    const identity = { businessId: event.businessId, importId: event.importId, rowId: event.rowId };
    const expectedEventId = `aggregate-import:${await canonicalSha256({ domain: "event", ...identity })}`;
    const expectedIdempotencyKey = `aggregate-import:${await canonicalSha256({ domain: "idempotency", ...identity })}`;
    if (event.eventId !== expectedEventId || event.idempotencyKey !== expectedIdempotencyKey) return false;
    const payload = canonicalEventPayload({
      kind: event.kind,
      eventId: event.eventId,
      idempotencyKey: event.idempotencyKey,
      importId: event.importId,
      rowId: event.rowId,
      businessId: event.businessId,
      productId: event.productId,
      sessionId: event.sessionId,
      quantity: event.quantity,
      unitOfMeasure: event.unitOfMeasure,
      sourceFileOrdinal: event.sourceFileOrdinal,
      sheetName: event.sheetName,
      sourceRowNumber: event.sourceRowNumber,
      createdAt: event.createdAt,
    });
    return event.fingerprint === await canonicalSha256(payload);
  } catch {
    return false;
  }
}

/** Maps an aggregate import into count math only; it never manufactures a scanner event. */
export function mapAggregateImportEventToCountDelta(event: AggregateImportEvent): InventoryCountDelta {
  return {
    eventId: event.eventId,
    idempotencyKey: event.idempotencyKey,
    businessId: event.businessId,
    productId: event.productId,
    sessionId: event.sessionId,
    quantityDelta: event.quantity,
    createdAt: event.createdAt,
  };
}
