import type { SessionCountRow } from "@/components/SessionCountsTable";
import type { Product, ScanEvent } from "@/types";

// Derives a session's product-count rows from its scan timeline: each product/code's session
// total is its chronologically LAST known event's quantityAfterScan (the ledger's running count),
// not a sum of deltas. When matchedProductId resolves through the store's getProduct, the row
// carries the full product for spreadsheet columns; otherwise it falls back to the event code.
export function countsFromTimeline(
  events: ScanEvent[],
  getProduct: (id: string | null) => Product | undefined,
): SessionCountRow[] {
  const byKey = new Map<string, ScanEvent>();
  for (const event of events) {
    if (event.status !== "known" && event.status !== "resolved") continue;
    const key = event.matchedProductId ?? event.cleanCode;
    const prior = byKey.get(key);
    if (!prior || new Date(event.createdAt).getTime() >= new Date(prior.createdAt).getTime()) {
      byKey.set(key, event);
    }
  }
  return [...byKey.entries()].map(([key, event]) => ({
    id: key,
    code: event.cleanCode,
    quantity: event.quantityAfterScan,
    product: getProduct(event.matchedProductId),
    location: event.location,
    lastScannedAt: event.createdAt,
  }));
}
