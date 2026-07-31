import type { AggregateImportEvent as AggregateImportEventBase } from "./types";

export interface CreateAggregateImportEventInput {
  businessId: string;
  importId: string;
  rowId: string;
  productId: string;
  sessionId: string;
  quantity: number;
  sourceFileOrdinal: number;
  sheetName: string;
  sourceRowNumber: number;
  createdAt: string;
}

export interface InventoryCountDelta {
  eventId: string;
  idempotencyKey: string;
  businessId: string;
  productId: string;
  sessionId: string;
  quantityDelta: number;
  createdAt: string;
}

/** A physical-count projection adds ledger routing metadata without changing Task 7's durable base event. */
export interface AggregateImportEvent extends AggregateImportEventBase {
  idempotencyKey: string;
  productId: string;
  sessionId: string;
  createdAt: string;
}

function aggregateIdentity(input: Pick<CreateAggregateImportEventInput, "businessId" | "importId" | "rowId">): string {
  return JSON.stringify([input.businessId, input.importId, input.rowId]);
}

/**
 * Creates one immutable ledger event for a physical-count row. Reconcile callers must not invoke
 * this adapter: expected inventory is report-only and never enters the quantity ledger.
 */
export function createAggregateImportEvent(input: CreateAggregateImportEventInput): AggregateImportEvent {
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
    throw new Error("aggregate import quantity must be a finite positive number");
  }

  const identity = aggregateIdentity(input);
  return {
    kind: "aggregate_import",
    eventId: `aggregate-import:${identity}`,
    idempotencyKey: `aggregate-import:${identity}`,
    importId: input.importId,
    rowId: input.rowId,
    businessId: input.businessId,
    productId: input.productId,
    sessionId: input.sessionId,
    quantity: input.quantity,
    unitOfMeasure: "each",
    sourceFileOrdinal: input.sourceFileOrdinal,
    sheetName: input.sheetName,
    sourceRowNumber: input.sourceRowNumber,
    createdAt: input.createdAt,
  };
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
