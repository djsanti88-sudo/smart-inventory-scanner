import type { InventoryCount, ScanEvent } from "@/types";
import type { InventoryCountDelta } from "@/services/identity/importLedger";

// Deterministic inventory math. AI is NEVER responsible for counts.
// The dedupe guarantee lives here: an InventoryCount records every scanEvent id it has applied,
// so applying the same event again (e.g. a sync retry) is a no-op. This is what makes retry safe.

export function createInventoryCount(params: {
  id: string;
  businessId: string;
  sessionId: string;
  productId: string;
  createdAt: string;
}): InventoryCount {
  return {
    id: params.id,
    businessId: params.businessId,
    sessionId: params.sessionId,
    productId: params.productId,
    quantity: 0,
    lastScannedAt: params.createdAt,
    aliasesSeen: [],
    scanEventIds: [],
    createdAt: params.createdAt,
    updatedAt: params.createdAt,
    syncStatus: "pending",
    syncError: null,
    appliedIdempotencyKeys: [],
  };
}

/** Creates a count originated solely by an aggregate physical-count import, not a scanner read. */
export function createAggregateInventoryCount(params: {
  id: string;
  businessId: string;
  sessionId: string;
  productId: string;
  createdAt: string;
}): InventoryCount {
  return {
    id: params.id,
    businessId: params.businessId,
    sessionId: params.sessionId,
    productId: params.productId,
    quantity: 0,
    aliasesSeen: [],
    scanEventIds: [],
    createdAt: params.createdAt,
    updatedAt: params.createdAt,
    syncStatus: "pending",
    syncError: null,
    appliedIdempotencyKeys: [],
  };
}

/**
 * Apply a scan event to a count EXACTLY ONCE. If the event id was already applied, returns the
 * count unchanged with applied=false. This is the core no-double-count invariant; it must hold
 * no matter how many times a retry replays the same event.
 */
export function applyScanEventOnce(
  count: InventoryCount,
  event: ScanEvent,
): { count: InventoryCount; applied: boolean } {
  if (count.scanEventIds.includes(event.id)) {
    return { count, applied: false };
  }

  const delta = event.quantityDelta ?? 1;
  const updated: InventoryCount = {
    ...count,
    quantity: count.quantity + delta,
    lastScannedAt: event.createdAt || count.lastScannedAt,
    aliasesSeen: count.aliasesSeen.includes(event.cleanCode)
      ? count.aliasesSeen
      : [...count.aliasesSeen, event.cleanCode],
    scanEventIds: [...count.scanEventIds, event.id],
    appliedIdempotencyKeys:
      event.idempotencyKey && !count.appliedIdempotencyKeys.includes(event.idempotencyKey)
        ? [...count.appliedIdempotencyKeys, event.idempotencyKey]
        : count.appliedIdempotencyKeys,
    updatedAt: event.createdAt || count.updatedAt,
  };
  return { count: updated, applied: true };
}

/**
 * Applies a neutral count delta exactly once. Aggregate imports use this boundary so their
 * source quantities participate in replay without pretending to be scanner reads or aliases.
 */
export function applyInventoryCountDeltaOnce(
  count: InventoryCount,
  delta: InventoryCountDelta,
): { count: InventoryCount; applied: boolean } {
  if (
    count.businessId !== delta.businessId ||
    count.sessionId !== delta.sessionId ||
    count.productId !== delta.productId
  ) {
    throw new Error("aggregate delta does not match the inventory count scope");
  }
  if (count.scanEventIds.includes(delta.eventId) || count.appliedIdempotencyKeys.includes(delta.idempotencyKey)) {
    return { count, applied: false };
  }

  return {
    count: {
      ...count,
      quantity: count.quantity + delta.quantityDelta,
      scanEventIds: [...count.scanEventIds, delta.eventId],
      appliedIdempotencyKeys: [...count.appliedIdempotencyKeys, delta.idempotencyKey],
      lastImportedAt: delta.createdAt,
      updatedAt: delta.createdAt > count.updatedAt ? delta.createdAt : count.updatedAt,
    },
    applied: true,
  };
}

/**
 * Find-or-create the count for a matched product in a session and apply the event once.
 * Pure: returns a new counts array; never mutates the input.
 */
export function incrementInventoryCount(
  counts: InventoryCount[],
  event: ScanEvent,
  makeId: () => string,
): { counts: InventoryCount[]; count: InventoryCount; applied: boolean } {
  if (!event.matchedProductId) {
    throw new Error("incrementInventoryCount requires a matched product");
  }

  const idx = counts.findIndex(
    (c) => c.productId === event.matchedProductId && c.sessionId === event.sessionId,
  );
  const base =
    idx >= 0
      ? counts[idx]
      : createInventoryCount({
          id: makeId(),
          businessId: event.businessId,
          sessionId: event.sessionId,
          productId: event.matchedProductId,
          createdAt: event.createdAt,
        });

  const { count, applied } = applyScanEventOnce(base, event);
  const next = counts.slice();
  if (idx >= 0) next[idx] = count;
  else next.push(count);

  return { counts: next, count, applied };
}
