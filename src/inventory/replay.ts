import type { InventoryCount, ScanEvent } from "@/types";
import { createInventoryCount, applyScanEventOnce } from "@/inventory/ledger";

// Pure ledger replay. Given the raw scan-event stream for a session, reconstruct the
// InventoryCount[] purely from event deltas, deduping by event id exactly as the live
// applyScanEventOnce does. A count's replayed quantity AND its scanEventIds set are the
// book-balancing ground truth: the live finalCounts must equal this replay on every path.
export function replayLedgerCounts(events: ScanEvent[], sessionId: string): InventoryCount[] {
  const byProduct = new Map<string, InventoryCount>();
  let seq = 0;
  for (const e of events) {
    if (e.sessionId !== sessionId) continue;
    if (!e.matchedProductId) continue; // uncounted feed rows (needs_review) carry no count
    const base =
      byProduct.get(e.matchedProductId) ??
      createInventoryCount({
        id: `replay-${seq++}`,
        businessId: e.businessId,
        sessionId: e.sessionId,
        productId: e.matchedProductId,
        createdAt: e.createdAt,
      });
    const { count } = applyScanEventOnce(base, e);
    byProduct.set(e.matchedProductId, count);
  }
  return [...byProduct.values()];
}
