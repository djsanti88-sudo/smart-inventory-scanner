import type { AggregateImportEvent } from "@/services/identity/types";
import { replayInventoryEvents } from "@/services/inventory.replay";
import type { InventoryCount } from "@/types";
import type { AtomicLocalStorage, AtomicTransaction } from "./atomicLocalStorage";

const projectionKey = "inventory-count-projection";

export type AggregateLedgerProjectionEntry = { event: AggregateImportEvent };

function scopeKey(businessId: string, sessionId: string): string {
  return JSON.stringify([businessId, sessionId]);
}

/** Materializes the count projection from durable aggregate events inside the caller's transaction. */
export async function writeLocalInventoryProjection(
  transaction: AtomicTransaction,
  entries: Readonly<Record<string, AggregateLedgerProjectionEntry>>,
  businessId: string,
  sessionId: string,
): Promise<InventoryCount[]> {
  const events = Object.values(entries)
    .map((entry) => entry.event)
    .filter((event) => event.businessId === businessId && event.sessionId === sessionId);
  const counts = replayInventoryEvents(events, sessionId);
  const projections = (await transaction.get<Record<string, InventoryCount[]>>(projectionKey)) ?? {};
  await transaction.set(projectionKey, { ...projections, [scopeKey(businessId, sessionId)]: counts });
  return counts;
}

export async function readLocalInventoryProjection(
  storage: AtomicLocalStorage,
  businessId: string,
  sessionId: string,
): Promise<InventoryCount[]> {
  const read = storage.read ? storage.read.bind(storage) : storage.transaction.bind(storage);
  return read(async (transaction) => {
    const projections = await transaction.get<Record<string, InventoryCount[]>>(projectionKey);
    return projections?.[scopeKey(businessId, sessionId)] ?? [];
  });
}
