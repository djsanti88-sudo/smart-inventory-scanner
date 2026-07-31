import type { AggregateImportEvent, AggregateLedgerPort } from "@/services/identity/types";
import type { AtomicLocalStorage } from "./atomicLocalStorage";

const ledgerKey = "aggregate-ledger";
type LedgerResult = { event: AggregateImportEvent; idempotencyKey: string };

export function createLocalAggregateLedger(storage: AtomicLocalStorage): AggregateLedgerPort {
  return {
    async apply(event, idempotencyKey) {
      return storage.transaction(async (transaction) => {
        const entries = (await transaction.get<Record<string, LedgerResult>>(ledgerKey)) ?? {};
        const existing = entries[idempotencyKey];
        if (existing) return existing;
        const result = { event, idempotencyKey };
        entries[idempotencyKey] = result;
        await transaction.set(ledgerKey, entries);
        return result;
      });
    },
    async get(idempotencyKey) {
      return storage.transaction((transaction) => transaction.get<Record<string, LedgerResult>>(ledgerKey).then((entries) => entries?.[idempotencyKey]));
    },
  };
}
