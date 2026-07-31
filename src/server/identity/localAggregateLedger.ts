import { canonicalSha256 } from "@/services/identity/canonical";
import type { AggregateImportEvent, AggregateLedgerPort, AggregateLedgerResult } from "@/services/identity/types";
import type { AtomicLocalStorage } from "./atomicLocalStorage";

const ledgerKey = "aggregate-ledger";
type StoredResult = { event: AggregateImportEvent; idempotencyKey: string; fingerprint: string };

export function createLocalAggregateLedger(storage: AtomicLocalStorage): AggregateLedgerPort {
  return {
    async apply(event, idempotencyKey): Promise<AggregateLedgerResult> {
      const fingerprint = await canonicalSha256({ event, idempotencyKey });
      return storage.transaction(async (transaction) => {
        const entries = (await transaction.get<Record<string, StoredResult>>(ledgerKey)) ?? {};
        const existing = entries[idempotencyKey];
        if (existing) return existing.fingerprint === fingerprint ? { event: existing.event, idempotencyKey } : { kind: "idempotency_conflict", idempotencyKey };
        entries[idempotencyKey] = { event, idempotencyKey, fingerprint };
        await transaction.set(ledgerKey, entries);
        return { event, idempotencyKey };
      });
    },
    async get(idempotencyKey) { return storage.transaction(async (transaction) => { const entries = await transaction.get<Record<string, StoredResult>>(ledgerKey); const item = entries?.[idempotencyKey]; return item ? { event: item.event, idempotencyKey: item.idempotencyKey } : undefined; }); },
  };
}
