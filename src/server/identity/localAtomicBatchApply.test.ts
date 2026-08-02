import { describe, expect, it } from "vitest";
import { createMemoryAtomicLocalStorage } from "./atomicLocalStorage";
import { createLocalAtomicBatchApply } from "./localAtomicBatchApply";

async function seedApplyingRun(storage: ReturnType<typeof createMemoryAtomicLocalStorage>): Promise<void> {
  await storage.transaction((tx) => tx.set("identity-runs", [{ businessId: "shop-a", importId: "import-a", state: "applying" }]));
}

describe("local atomic batch apply", () => {
  it.each([undefined, "invalidated", "completed"])('rejects %s import run inside the batch lock', async (state) => {
    const storage = createMemoryAtomicLocalStorage();
    if (state) await storage.transaction((tx) => tx.set("identity-runs", [{ businessId: "shop-a", importId: "import-a", state }]));
    const apply = createLocalAtomicBatchApply(storage, async () => true);
    await expect(apply({ businessId: "shop-a", importId: "import-a", rows: [{ rowId: "row-1", payloadFingerprint: "payload", result: { rowId: "row-1" } }] })).rejects.toThrow("matching import run is not applying");
  });

  it("rejects a completed counted row when its stored aggregate event no longer matches", async () => {
    const storage = createMemoryAtomicLocalStorage();
    await seedApplyingRun(storage);
    const row = {
      rowId: "row-1", payloadFingerprint: "payload-1", result: { rowId: "row-1" },
      count: { event: { businessId: "shop-a", importId: "import-a", rowId: "row-1", idempotencyKey: "event-1", fingerprint: "event-fingerprint", sessionId: "session", productId: "tire", quantity: 1 } as never, operationFingerprint: "operation-fingerprint" },
    };
    const apply = createLocalAtomicBatchApply(storage, async () => true);
    await expect(apply({ businessId: "shop-a", importId: "import-a", rows: [row] })).resolves.toMatchObject({ completed: 1 });
    await storage.transaction(async (tx) => {
      const ledger = await tx.get<Record<string, { fingerprint: string }>>("aggregate-ledger") ?? {};
      ledger[JSON.stringify(["shop-a", "event-1"])]!.fingerprint = "tampered";
      await tx.set("aggregate-ledger", ledger);
    });
    await expect(apply({ businessId: "shop-a", importId: "import-a", rows: [row] })).resolves.toMatchObject({ completed: 0, stop: { rowId: "row-1", kind: "idempotency_conflict" } });
  });

  it("recovers an operation from an exact prior event without revalidation or projection", async () => {
    const storage = createMemoryAtomicLocalStorage();
    await seedApplyingRun(storage);
    const row = {
      rowId: "row-1", payloadFingerprint: "payload-1", result: { rowId: "row-1" }, validation: { target: "tire" },
      count: { event: { businessId: "shop-a", importId: "import-a", rowId: "row-1", idempotencyKey: "event-1", fingerprint: "event-fingerprint", sessionId: "session", productId: "tire", quantity: 1 } as never, operationFingerprint: "operation-fingerprint" },
    };
    await storage.transaction(async (tx) => {
      await tx.set("aggregate-ledger", { [JSON.stringify(["shop-a", "event-1"])]: { event: row.count.event, idempotencyKey: "event-1", fingerprint: "event-fingerprint", operationFingerprint: "operation-fingerprint" } });
    });
    let revalidations = 0, projections = 0;
    const apply = createLocalAtomicBatchApply(storage, async () => { revalidations += 1; return false; }, { writeProjection: async () => { projections += 1; } });
    await expect(apply({ businessId: "shop-a", importId: "import-a", rows: [row] })).resolves.toMatchObject({ completed: 1 });
    expect(revalidations).toBe(0);
    expect(projections).toBe(0);
  });

  it("returns an all-completed batch through read-only storage without a transaction", async () => {
    const backing = createMemoryAtomicLocalStorage();
    await seedApplyingRun(backing);
    let transactions = 0, reads = 0;
    const storage = {
      transaction: async <T>(fn: Parameters<typeof backing.transaction<T>>[0]) => { transactions += 1; return backing.transaction(fn); },
      read: async <T>(fn: Parameters<NonNullable<typeof backing.read<T>>>[0]) => { reads += 1; return backing.read!(fn); },
    };
    const row = { rowId: "row-1", payloadFingerprint: "payload-1", result: { rowId: "row-1" } };
    const apply = createLocalAtomicBatchApply(storage, async () => true);
    await apply({ businessId: "shop-a", importId: "import-a", rows: [row] });
    transactions = 0;
    await expect(apply({ businessId: "shop-a", importId: "import-a", rows: [row] })).resolves.toMatchObject({ completed: 1, results: [row.result] });
    expect(reads).toBeGreaterThan(0);
    expect(transactions).toBe(0);
  });

  it("commits 300 ordered counted rows as three max-100 transactions and projections", async () => {
    const backing = createMemoryAtomicLocalStorage();
    await seedApplyingRun(backing);
    let transactions = 0, projections = 0;
    const storage = {
      transaction: async <T>(fn: Parameters<typeof backing.transaction<T>>[0]) => { transactions += 1; return backing.transaction(fn); },
      read: backing.read,
    };
    const apply = createLocalAtomicBatchApply(storage, async () => true, { writeProjection: async () => { projections += 1; } });
    const rows = Array.from({ length: 300 }, (_, index) => ({
      rowId: `row-${index}`, payloadFingerprint: `payload-${index}`, result: { rowId: `row-${index}` },
      count: { event: { businessId: "shop-a", importId: "import-a", rowId: `row-${index}`, idempotencyKey: `event-${index}`, fingerprint: `fingerprint-${index}`, sessionId: "session", productId: "tire", quantity: 1 } as never, operationFingerprint: "operation-fingerprint" },
    }));
    const outputs: unknown[] = [];
    for (let offset = 0; offset < rows.length; offset += 100) {
      const result = await apply({ businessId: "shop-a", importId: "import-a", rows: rows.slice(offset, offset + 100) });
      expect(result.stop).toBeUndefined();
      outputs.push(...result.results);
    }
    expect(outputs).toEqual(rows.map((row) => row.result));
    expect(transactions).toBe(3);
    expect(projections).toBe(3);
  });

  it("commits a successful ordered prefix and leaves the suffix untouched", async () => {
    const storage = createMemoryAtomicLocalStorage();
    await seedApplyingRun(storage);
    const apply = createLocalAtomicBatchApply(storage, async (row) => row.rowId !== "row-5");
    const result = await apply({ businessId: "shop-a", importId: "import-a", rows: Array.from({ length: 6 }, (_, index) => ({ rowId: `row-${index + 1}`, payloadFingerprint: `p-${index + 1}`, result: { rowId: `row-${index + 1}` }, validation: {}, count: { event: { businessId: "shop-a", importId: "import-a", rowId: `row-${index + 1}`, idempotencyKey: `event-${index + 1}`, fingerprint: `f-${index + 1}`, sessionId: "session", productId: "tire", quantity: 1 } as never, operationFingerprint: "op" } })) });
    expect(result).toMatchObject({ completed: 4, stop: { rowId: "row-5", kind: "stale" } });
    await storage.read!(async (tx) => {
      expect(Object.keys((await tx.get<Record<string, unknown>>("identity-operations")) ?? {})).toHaveLength(4);
      expect(Object.keys((await tx.get<Record<string, unknown>>("aggregate-ledger")) ?? {})).toHaveLength(4);
    });
  });

  it("persists only a preceding unresolved review when row five is stale", async () => {
    const storage = createMemoryAtomicLocalStorage();
    await seedApplyingRun(storage);
    const apply = createLocalAtomicBatchApply(storage, async (row) => row.rowId !== "row-5");
    const rows = Array.from({ length: 6 }, (_, index) => ({
      rowId: `row-${index + 1}`, payloadFingerprint: `payload-${index + 1}`, result: { rowId: `row-${index + 1}` }, validation: {},
      ...(index === 0 ? { review: { reviewId: "review-1", businessId: "shop-a", importId: "import-a", rowId: "row-1" } as never } : {}),
      ...(index !== 0 ? { count: { event: { businessId: "shop-a", importId: "import-a", rowId: `row-${index + 1}`, idempotencyKey: `event-${index + 1}`, fingerprint: `fingerprint-${index + 1}`, sessionId: "session", productId: "tire", quantity: 1 } as never, operationFingerprint: "operation-fingerprint" } } : {}),
    }));
    await expect(apply({ businessId: "shop-a", importId: "import-a", rows })).resolves.toMatchObject({ completed: 4, stop: { rowId: "row-5", kind: "stale" } });
    await storage.read!(async (tx) => {
      expect(await tx.get<unknown[]>("identity-reviews")).toHaveLength(1);
      expect(Object.keys(await tx.get<Record<string, unknown>>("identity-operations") ?? {})).toHaveLength(4);
      expect(Object.keys(await tx.get<Record<string, unknown>>("aggregate-ledger") ?? {})).toHaveLength(3);
    });
    await expect(apply({ businessId: "shop-a", importId: "import-a", rows })).resolves.toMatchObject({ completed: 4, stop: { rowId: "row-5", kind: "stale" } });
    await storage.read!(async (tx) => {
      expect(await tx.get<unknown[]>("identity-reviews")).toHaveLength(1);
      expect(Object.keys(await tx.get<Record<string, unknown>>("identity-operations") ?? {})).toHaveLength(4);
      expect(Object.keys(await tx.get<Record<string, unknown>>("aggregate-ledger") ?? {})).toHaveLength(3);
    });
  });

  it("keeps signed mixed quantities attached to their ordered outcomes", async () => {
    const storage = createMemoryAtomicLocalStorage();
    await seedApplyingRun(storage);
    const apply = createLocalAtomicBatchApply(storage, async () => true);
    const counted = (rowId: string, quantity: number) => ({ event: { businessId: "shop-a", importId: "import-a", rowId, idempotencyKey: `event-${rowId}`, fingerprint: `fingerprint-${rowId}`, sessionId: "session", productId: "tire", quantity } as never, operationFingerprint: "operation-fingerprint" });
    const result = await apply({ businessId: "shop-a", importId: "import-a", rows: [
      { rowId: "automatic", payloadFingerprint: "automatic", result: { rowId: "automatic", quantity: 2 }, count: counted("automatic", 2) },
      { rowId: "review", payloadFingerprint: "review", result: { rowId: "review", quantity: 5 }, review: { reviewId: "review-1", businessId: "shop-a", importId: "import-a", rowId: "review" } as never },
      { rowId: "corrected", payloadFingerprint: "corrected", result: { rowId: "corrected", quantity: 3 }, count: counted("corrected", 3) },
    ] });
    expect(result.results).toEqual([{ rowId: "automatic", quantity: 2 }, { rowId: "review", quantity: 5 }, { rowId: "corrected", quantity: 3 }]);
    await storage.read!(async (tx) => {
      const events = Object.values(await tx.get<Record<string, { event: { quantity: number } }>>("aggregate-ledger") ?? {});
      expect(events.map(({ event }) => event.quantity)).toEqual([2, 3]);
      expect(await tx.get<unknown[]>("identity-reviews")).toHaveLength(1);
    });
  });
});
