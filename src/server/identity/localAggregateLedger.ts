import { canonicalSha256 } from "@/services/identity/canonical";
import type { AggregateImportEvent, AggregateLedgerPort, AggregateLedgerResult } from "@/services/identity/types";
import type { AtomicLocalStorage } from "./atomicLocalStorage";

const ledgerKey = "aggregate-ledger";
type StoredResult = { event: AggregateImportEvent; idempotencyKey: string; eventFingerprint: string; operationFingerprint: string };
function entryKey(businessId: string, idempotencyKey: string): string { return JSON.stringify([businessId, idempotencyKey]); }

export function createLocalAggregateLedger(storage: AtomicLocalStorage): AggregateLedgerPort {
  return {
    async apply(event, idempotencyKey, operationFingerprint): Promise<AggregateLedgerResult> {
      const eventFingerprint = await canonicalSha256(event);
      return storage.transaction(async (transaction) => {
        const entries = (await transaction.get<Record<string, StoredResult>>(ledgerKey)) ?? {};
        const key = entryKey(event.businessId, idempotencyKey), existing = entries[key];
        if (existing) return existing.eventFingerprint === eventFingerprint && existing.operationFingerprint === operationFingerprint && existing.event.businessId === event.businessId ? { event: existing.event, idempotencyKey } : { kind: "idempotency_conflict", idempotencyKey };
        entries[key] = { event, idempotencyKey, eventFingerprint, operationFingerprint };
        await transaction.set(ledgerKey, entries);
        return { event, idempotencyKey };
      });
    },
    async get(input) { return storage.transaction(async (transaction) => { const entries = await transaction.get<Record<string, StoredResult>>(ledgerKey); const item = entries?.[entryKey(input.businessId, input.idempotencyKey)]; return item && item.event.businessId === input.businessId && item.eventFingerprint === input.eventFingerprint && item.operationFingerprint === input.operationFingerprint ? { event: item.event, idempotencyKey: item.idempotencyKey } : undefined; }); },
  };
}
