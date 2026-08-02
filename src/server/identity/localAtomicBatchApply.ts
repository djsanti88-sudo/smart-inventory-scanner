import type { AggregateImportEvent, IdentityReview } from "@/services/identity/types";
import type { AtomicLocalStorage, AtomicTransaction } from "./atomicLocalStorage";

type StoredOperation = { businessId: string; importId: string; rowId: string; idempotencyKey: string; payloadFingerprint: string; state: "applied" | "pending" | "failed_retryable" | "failed_terminal"; result?: unknown };
type StoredLedger = { event: AggregateImportEvent; idempotencyKey: string; fingerprint: string; operationFingerprint?: string };
type ProjectionWriter = (transaction: AtomicTransaction, entries: Readonly<Record<string, StoredLedger>>, businessId: string, sessionId: string) => Promise<unknown>;
const defaultProjection: ProjectionWriter = async (transaction, entries, businessId, sessionId) => (await import("./localInventoryProjection")).writeLocalInventoryProjection(transaction, entries, businessId, sessionId);
const operationKey = (businessId: string, importId: string, rowId: string) => JSON.stringify([businessId, importId, rowId]);
const ledgerKey = (businessId: string, idempotencyKey: string) => JSON.stringify([businessId, idempotencyKey]);

async function completedBatch(
  transaction: AtomicTransaction,
  input: LocalAtomicBatchInput,
): Promise<unknown[] | undefined> {
  const operations = (await transaction.get<Record<string, StoredOperation>>("identity-operations")) ?? {};
  const ledger = (await transaction.get<Record<string, StoredLedger>>("aggregate-ledger")) ?? {};
  const results: unknown[] = [];
  for (const row of input.rows) {
    const operation = operations[operationKey(input.businessId, input.importId, row.rowId)];
    if (!operation || operation.state !== "applied" || operation.idempotencyKey !== `identity-apply:${row.rowId}`
      || operation.payloadFingerprint !== row.payloadFingerprint || operation.result === undefined) return undefined;
    if (row.count) {
      const stored = ledger[ledgerKey(input.businessId, row.count.event.idempotencyKey)];
      if (!stored || stored.idempotencyKey !== row.count.event.idempotencyKey
        || stored.event.idempotencyKey !== row.count.event.idempotencyKey
        || stored.event.businessId !== row.count.event.businessId
        || stored.event.importId !== row.count.event.importId
        || stored.event.rowId !== row.count.event.rowId
        || stored.fingerprint !== row.count.event.fingerprint
        || stored.event.fingerprint !== row.count.event.fingerprint
        || stored.operationFingerprint !== row.count.operationFingerprint) return undefined;
    }
    results.push(operation.result);
  }
  return results;
}

export type LocalAtomicBatchRow = {
  rowId: string;
  payloadFingerprint: string;
  result: unknown;
  validation?: unknown;
  count?: { event: AggregateImportEvent; operationFingerprint: string };
  review?: IdentityReview;
};
export type LocalAtomicBatchInput = { businessId: string; importId: string; rows: readonly LocalAtomicBatchRow[] };
export type LocalAtomicBatchResult = { completed: number; results: unknown[]; stop?: { rowId: string; kind: "stale" | "in_progress" | "idempotency_conflict" } };

/**
 * Local-only batch commit primitive.  It deliberately returns a stop marker instead of throwing:
 * that lets the enclosing transaction retain the already successful ordered prefix.
 */
export function createLocalAtomicBatchApply(
  storage: AtomicLocalStorage,
  revalidate: (row: LocalAtomicBatchRow, transaction: AtomicTransaction) => Promise<boolean>,
  { writeProjection = defaultProjection }: { writeProjection?: ProjectionWriter } = {},
): (input: LocalAtomicBatchInput) => Promise<LocalAtomicBatchResult> {
  return async (input) => {
    if (input.rows.length > 100) throw new Error("identity_batch_too_large");
    if (storage.read) {
      const results = await storage.read((transaction) => completedBatch(transaction, input));
      if (results) return { completed: results.length, results };
    }
    return storage.transaction(async (transaction) => {
    if (input.rows.length > 100) throw new Error("identity_batch_too_large");
    const runs = (await transaction.get<Array<{ businessId: string; importId: string; state: string }>>("identity-runs")) ?? [];
    if (!runs.some((run) => run.businessId === input.businessId && run.importId === input.importId && run.state === "applying")) {
      throw new Error("matching import run is not applying");
    }
    const operations = (await transaction.get<Record<string, StoredOperation>>("identity-operations")) ?? {};
    const ledger = (await transaction.get<Record<string, StoredLedger>>("aggregate-ledger")) ?? {};
    const reviews = (await transaction.get<IdentityReview[]>("identity-reviews")) ?? [];
    const results: unknown[] = [];
    let addedEvent: AggregateImportEvent | undefined;
    let changedOperations = false, changedReviews = false;
    const finish = async (stop?: LocalAtomicBatchResult["stop"]): Promise<LocalAtomicBatchResult> => {
      if (changedOperations) await transaction.set("identity-operations", operations);
      if (addedEvent) { await transaction.set("aggregate-ledger", ledger); await writeProjection(transaction, ledger, addedEvent.businessId, addedEvent.sessionId); }
      if (changedReviews) await transaction.set("identity-reviews", reviews);
      return { completed: results.length, results, ...(stop ? { stop } : {}) };
    };
    for (const row of input.rows) {
      const key = operationKey(input.businessId, input.importId, row.rowId);
      const existing = operations[key];
      if (existing) {
        if (existing.idempotencyKey !== `identity-apply:${row.rowId}` || existing.payloadFingerprint !== row.payloadFingerprint || existing.state === "failed_terminal") return finish({ rowId: row.rowId, kind: "idempotency_conflict" });
        if (existing.state === "pending") return finish({ rowId: row.rowId, kind: "in_progress" });
        if (existing.result === undefined) return finish({ rowId: row.rowId, kind: "idempotency_conflict" });
        if (row.count) {
          const stored = ledger[ledgerKey(input.businessId, row.count.event.idempotencyKey)];
          if (!stored || stored.idempotencyKey !== row.count.event.idempotencyKey
            || stored.event.idempotencyKey !== row.count.event.idempotencyKey
            || stored.event.businessId !== row.count.event.businessId
            || stored.event.importId !== row.count.event.importId
            || stored.event.rowId !== row.count.event.rowId
            || stored.fingerprint !== row.count.event.fingerprint
            || stored.event.fingerprint !== row.count.event.fingerprint
            || stored.operationFingerprint !== row.count.operationFingerprint) {
            return finish({ rowId: row.rowId, kind: "idempotency_conflict" });
          }
        }
        results.push(existing.result); continue;
      }
      const priorEvent = row.count ? ledger[ledgerKey(input.businessId, row.count.event.idempotencyKey)] : undefined;
      if (row.count) {
        const previous = priorEvent;
        if (previous && (previous.fingerprint !== row.count.event.fingerprint || previous.operationFingerprint !== row.count.operationFingerprint)) return finish({ rowId: row.rowId, kind: "idempotency_conflict" });
        if (!previous) {
          if (row.validation !== undefined && !await revalidate(row, transaction)) return finish({ rowId: row.rowId, kind: "stale" });
          const entryKey = ledgerKey(input.businessId, row.count.event.idempotencyKey);
          ledger[entryKey] = { event: row.count.event, idempotencyKey: row.count.event.idempotencyKey, fingerprint: row.count.event.fingerprint, operationFingerprint: row.count.operationFingerprint };
          addedEvent = row.count.event;
        }
      } else if (row.validation !== undefined && !await revalidate(row, transaction)) {
        return finish({ rowId: row.rowId, kind: "stale" });
      }
      if (row.review && !reviews.some((review) => review.reviewId === row.review!.reviewId && review.businessId === row.review!.businessId)) { reviews.push(row.review); changedReviews = true; }
      operations[key] = { businessId: input.businessId, importId: input.importId, rowId: row.rowId, idempotencyKey: `identity-apply:${row.rowId}`, payloadFingerprint: row.payloadFingerprint, state: "applied", result: row.result };
      changedOperations = true; results.push(row.result);
    }
    return finish();
    });
  };
}
