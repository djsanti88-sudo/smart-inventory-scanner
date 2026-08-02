import type { AtomicLocalStorage, AtomicTransaction } from "./atomicLocalStorage";
import type { AggregateImportEvent, IdentityDecision, ScopedIdentifier } from "@/services/identity/types";

type OperationInput = {
  businessId: string;
  importId: string;
  rowId: string;
  idempotencyKey: string;
  payloadFingerprint: string;
};

type CountEvent = AggregateImportEvent;

type StoredOperation = OperationInput & {
  state: "pending" | "applied" | "failed_retryable" | "failed_terminal";
  leaseExpiresAt?: number;
  result?: unknown;
};

type StoredLedgerResult = {
  event: CountEvent;
  idempotencyKey: string;
  fingerprint: string;
  operationFingerprint?: string;
};

type ProjectionWriter = (transaction: AtomicTransaction, entries: Readonly<Record<string, StoredLedgerResult>>, businessId: string, sessionId: string) => Promise<unknown>;
const defaultProjectionWriter: ProjectionWriter = async (transaction, entries, businessId, sessionId) => {
  const { writeLocalInventoryProjection } = await import("./localInventoryProjection");
  return writeLocalInventoryProjection(transaction, entries, businessId, sessionId);
};

export type LocalAtomicCountedApplyInput = {
  validation: { businessId: string; sourceSystem: string; sourceSignature: string; vendorId: string; targetProductId: string; identifiers: ScopedIdentifier[]; row: Record<string, unknown>; decision: IdentityDecision; corrected: boolean };
  operation: OperationInput;
  event: CountEvent;
  operationFingerprint: string;
  result: unknown;
};

export type LocalAtomicCountedApplyResult =
  | { kind: "applied"; event: CountEvent; result: unknown }
  | { kind: "completed"; event: CountEvent; result: unknown }
  | { kind: "stale" }
  | { kind: "in_progress" }
  | { kind: "idempotency_conflict" };

function operationKey(input: Pick<OperationInput, "businessId" | "importId" | "rowId">): string {
  return JSON.stringify([input.businessId, input.importId, input.rowId]);
}

function ledgerKey(businessId: string, idempotencyKey: string): string {
  return JSON.stringify([businessId, idempotencyKey]);
}

/**
 * The final target check, operation claim, aggregate event, and completed result
 * share one AtomicLocalStorage commit. A link revoke uses that same file lock, so
 * either revocation wins and this returns stale without a ledger event, or this
 * count wins and a retry observes the exact completed result.
 */
export function createLocalAtomicCountedApply(
  storage: AtomicLocalStorage,
  revalidate: (input: LocalAtomicCountedApplyInput["validation"], transaction?: AtomicTransaction) => Promise<boolean>,
  { now = Date.now, allowedRunStates = ["applying"], writeProjection = defaultProjectionWriter }: { now?: () => number; allowedRunStates?: readonly string[]; writeProjection?: ProjectionWriter } = {},
): (input: LocalAtomicCountedApplyInput) => Promise<LocalAtomicCountedApplyResult> {
  return (input) => storage.transaction(async (transaction) => {
    const runs = (await transaction.get<Array<{ businessId?: string; importId?: string; state?: string }>>("identity-runs")) ?? [];
    if (!runs.some((run) => run.businessId === input.operation.businessId && run.importId === input.operation.importId && allowedRunStates.includes(run.state ?? ""))) throw new Error("matching import run is not in an allowed state");

    const operations = (await transaction.get<Record<string, StoredOperation>>("identity-operations")) ?? {};
    const key = operationKey(input.operation), existing = operations[key];
    if (existing && (existing.idempotencyKey !== input.operation.idempotencyKey || existing.payloadFingerprint !== input.operation.payloadFingerprint)) return { kind: "idempotency_conflict" };
    if (existing?.state === "applied") {
      if (existing.result === undefined) return { kind: "idempotency_conflict" };
      const entries = (await transaction.get<Record<string, StoredLedgerResult>>("aggregate-ledger")) ?? {};
      const stored = entries[ledgerKey(input.event.businessId, input.event.idempotencyKey)];
      if (!stored || stored.fingerprint !== input.event.fingerprint || stored.operationFingerprint !== input.operationFingerprint) return { kind: "idempotency_conflict" };
      await writeProjection(transaction, entries, stored.event.businessId, stored.event.sessionId);
      return { kind: "completed", event: stored.event, result: existing.result };
    }
    if (existing?.state === "failed_terminal") return { kind: "idempotency_conflict" };
    if (existing?.state === "pending" && (existing.leaseExpiresAt ?? 0) > now()) return { kind: "in_progress" };
    if (input.validation.businessId !== input.operation.businessId || input.event.businessId !== input.operation.businessId || !await revalidate(input.validation, transaction)) return { kind: "stale" };

    const entries = (await transaction.get<Record<string, StoredLedgerResult>>("aggregate-ledger")) ?? {};
    const eventKey = ledgerKey(input.event.businessId, input.event.idempotencyKey), stored = entries[eventKey];
    if (stored && (stored.idempotencyKey !== input.event.idempotencyKey || stored.fingerprint !== input.event.fingerprint || stored.operationFingerprint !== input.operationFingerprint)) return { kind: "idempotency_conflict" };
    const event = stored?.event ?? input.event;
    if (!stored) entries[eventKey] = { event, idempotencyKey: input.event.idempotencyKey, fingerprint: input.event.fingerprint, operationFingerprint: input.operationFingerprint };
    operations[key] = { ...input.operation, state: "applied", result: input.result };
    await transaction.set("aggregate-ledger", entries);
    await writeProjection(transaction, entries, event.businessId, event.sessionId);
    await transaction.set("identity-operations", operations);
    return { kind: "applied", event, result: input.result };
  });
}
