import type { InventoryCount, ScanEvent } from "@/types";
import type { AggregateImportEvent } from "@/services/identity/types";
import { mapAggregateImportEventToCountDelta } from "@/services/identity/importLedger";
import { createAggregateInventoryCount, createInventoryCount, applyInventoryCountDeltaOnce, applyScanEventOnce } from "@/services/inventory";

function isAggregateImportEvent(event: ScanEvent | AggregateImportEvent): event is AggregateImportEvent {
  return "kind" in event && event.kind === "aggregate_import";
}

// Pure ledger replay. Given the raw scan-event stream for a session, reconstruct the
// InventoryCount[] purely from event deltas, deduping by event id exactly as the live
// applyScanEventOnce does. A count's replayed quantity AND its scanEventIds set are the
// book-balancing ground truth: the live finalCounts must equal this replay on every path.
export function replayInventoryEvents(
  events: Array<ScanEvent | AggregateImportEvent>,
  sessionId: string,
): InventoryCount[] {
  const byProduct = new Map<string, InventoryCount>();
  const appliedEventIdentities = new Set<string>();
  const appliedIdempotencyIdentities = new Set<string>();
  let seq = 0;
  for (const e of events) {
    if (e.sessionId !== sessionId) continue;
    const aggregate = isAggregateImportEvent(e);
    const productId = aggregate ? e.productId : e.matchedProductId;
    if (!productId) continue; // uncounted feed rows (needs_review) carry no count
    const eventId = aggregate ? e.eventId : e.id;
    const idempotencyKey = aggregate ? e.idempotencyKey : undefined;
    const tenantEventIdentity = JSON.stringify([e.businessId, eventId]);
    const countIdentity = JSON.stringify([e.businessId, e.sessionId, productId]);
    const tenantKeyIdentity = idempotencyKey && JSON.stringify([e.businessId, idempotencyKey]);
    if (
      aggregate &&
      (appliedEventIdentities.has(tenantEventIdentity) || (tenantKeyIdentity && appliedIdempotencyIdentities.has(tenantKeyIdentity)))
    ) continue;
    const base = byProduct.get(countIdentity) ?? (aggregate
      ? createAggregateInventoryCount({ id: `replay-${seq++}`, businessId: e.businessId, sessionId: e.sessionId, productId, createdAt: e.createdAt })
      : createInventoryCount({ id: `replay-${seq++}`, businessId: e.businessId, sessionId: e.sessionId, productId, createdAt: e.createdAt }));
    const result = aggregate
      ? applyInventoryCountDeltaOnce(base, mapAggregateImportEventToCountDelta(e))
      : applyScanEventOnce(base, e);
    if (!result.applied) continue;
    if (aggregate) {
      appliedEventIdentities.add(tenantEventIdentity);
      if (tenantKeyIdentity) appliedIdempotencyIdentities.add(tenantKeyIdentity);
    }
    byProduct.set(countIdentity, result.count);
  }
  return [...byProduct.values()];
}

export function replayLedgerCounts(events: ScanEvent[], sessionId: string): InventoryCount[] {
  return replayInventoryEvents(events, sessionId);
}
