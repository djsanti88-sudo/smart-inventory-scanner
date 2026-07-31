import type { AggregateImportEvent, AggregateLedgerPort, AggregateLedgerResult } from "@/services/identity/types";
import { validateAggregateImportEvent } from "@/services/identity/importLedger";
import type { AtomicLocalStorage } from "./atomicLocalStorage";

const ledgerKey = "aggregate-ledger";
type StoredResult = {
  event: AggregateImportEvent;
  idempotencyKey: string;
  fingerprint: string;
  operationFingerprint?: string;
};

function entryKey(businessId: string, idempotencyKey: string): string {
  return JSON.stringify([businessId, idempotencyKey]);
}

export function createLocalAggregateLedger(storage: AtomicLocalStorage): AggregateLedgerPort {
  async function storedResultIsValid(item: StoredResult, expectedFingerprint: string): Promise<boolean> {
    return item.fingerprint === item.event.fingerprint &&
      item.fingerprint === expectedFingerprint &&
      await validateAggregateImportEvent(item.event);
  }

  async function store(
    event: AggregateImportEvent,
    idempotencyKey: string,
    operationFingerprint?: string,
  ): Promise<AggregateLedgerResult> {
    if (idempotencyKey !== event.idempotencyKey || !(await validateAggregateImportEvent(event))) {
      return { kind: "idempotency_conflict", idempotencyKey };
    }
    return storage.transaction(async (transaction) => {
      const entries = (await transaction.get<Record<string, StoredResult>>(ledgerKey)) ?? {};
      const key = entryKey(event.businessId, idempotencyKey);
      const existing = entries[key];
      if (existing) {
        return await storedResultIsValid(existing, event.fingerprint) &&
          (operationFingerprint === undefined || existing.operationFingerprint === operationFingerprint)
          ? { event: existing.event, idempotencyKey: existing.idempotencyKey }
          : { kind: "idempotency_conflict", idempotencyKey };
      }
      entries[key] = { event, idempotencyKey, fingerprint: event.fingerprint, operationFingerprint };
      await transaction.set(ledgerKey, entries);
      return { event, idempotencyKey };
    });
  }

  async function applyOnce(event: AggregateImportEvent, idempotencyKey: string): Promise<AggregateLedgerResult> {
    return store(event, idempotencyKey);
  }

  async function findByIdempotencyKey(input: {
    businessId: string;
    idempotencyKey: string;
    expectedFingerprint: string;
  }): Promise<AggregateLedgerResult | null> {
    return storage.transaction(async (transaction) => {
      const entries = await transaction.get<Record<string, StoredResult>>(ledgerKey);
      const item = entries?.[entryKey(input.businessId, input.idempotencyKey)];
      return item && await storedResultIsValid(item, input.expectedFingerprint)
        ? { event: item.event, idempotencyKey: item.idempotencyKey }
        : null;
    });
  }

  return {
    applyOnce,
    findByIdempotencyKey,
    async apply(event, idempotencyKey, operationFingerprint) {
      return store(event, idempotencyKey, operationFingerprint);
    },
    async get(input) {
      const result = await findByIdempotencyKey({
        businessId: input.businessId,
        idempotencyKey: input.idempotencyKey,
        expectedFingerprint: input.eventFingerprint,
      });
      if (!result || !("event" in result)) return undefined;
      return result.event.fingerprint === input.eventFingerprint &&
        (await storage.transaction(async (transaction) => {
          const entries = await transaction.get<Record<string, StoredResult>>(ledgerKey);
          return entries?.[entryKey(input.businessId, input.idempotencyKey)]?.operationFingerprint === input.operationFingerprint;
        }))
        ? result
        : undefined;
    },
  };
}
