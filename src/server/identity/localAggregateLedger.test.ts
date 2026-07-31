import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAggregateImportEvent } from "@/services/identity/importLedger";
import { createFileAtomicLocalStorage, createMemoryAtomicLocalStorage } from "./atomicLocalStorage";
import type { AtomicLocalStorage } from "./atomicLocalStorage";
import { createLocalAggregateLedger } from "./localAggregateLedger";

const storageBase = path.resolve(process.cwd(), ".tmp", "identity-import");
const ownedRoots: string[] = [];

function testRoot(): string {
  const root = path.resolve(storageBase, `ledger-${randomUUID()}`);
  ownedRoots.push(root);
  return root;
}

async function event(overrides: Record<string, unknown> = {}) {
  return createAggregateImportEvent({
    businessId: "shop-a", importId: "import-1", rowId: "row-1", sessionId: "session-1", quantity: 0,
    sourceFileOrdinal: 0, sheetName: "Inventory", sourceRowNumber: 2, createdAt: "2026-07-31T00:00:00.000Z",
    mode: "physical_count", decision: { kind: "automatic", targetProductId: "product-1" }, ...overrides,
  });
}

afterEach(async () => {
  await Promise.all(ownedRoots.splice(0).map(async (root) => {
    if (path.dirname(root) !== storageBase) throw new Error("refusing to remove a non-test identity root");
    await rm(root, { recursive: true, force: true });
  }));
});

describe("local aggregate ledger", () => {
  it("preserves legacy operation fingerprints independently from aggregate fingerprints", async () => {
    const ledger = createLocalAggregateLedger(createMemoryAtomicLocalStorage());
    const aggregate = await event();
    await expect(ledger.apply(aggregate, aggregate.idempotencyKey, "operation-1")).resolves.toEqual({
      event: aggregate, idempotencyKey: aggregate.idempotencyKey,
    });
    await expect(ledger.apply(aggregate, aggregate.idempotencyKey, "operation-1")).resolves.toEqual({
      event: aggregate, idempotencyKey: aggregate.idempotencyKey,
    });
    await expect(ledger.apply(aggregate, aggregate.idempotencyKey, "operation-2")).resolves.toEqual({
      kind: "idempotency_conflict", idempotencyKey: aggregate.idempotencyKey,
    });
    await expect(ledger.get({
      businessId: aggregate.businessId, idempotencyKey: aggregate.idempotencyKey,
      eventFingerprint: aggregate.fingerprint, operationFingerprint: "operation-1",
    })).resolves.toEqual({ event: aggregate, idempotencyKey: aggregate.idempotencyKey });
  });

  it("refuses corrupted stored event payloads or sidecar fingerprints on recovery", async () => {
    const values = new Map<string, unknown>();
    const storage: AtomicLocalStorage = {
      async transaction(fn) {
        return fn({
          async get(key) { return values.get(key) as never; },
          async set(key, value) { values.set(key, value); },
          async delete(key) { values.delete(key); },
        });
      },
    };
    const ledger = createLocalAggregateLedger(storage);
    const aggregate = await event();
    await ledger.applyOnce(aggregate, aggregate.idempotencyKey);
    const records = values.get("aggregate-ledger") as Record<string, { event: typeof aggregate; fingerprint: string }>;
    const record = Object.values(records)[0];
    record.event.quantity = 1;
    await expect(ledger.findByIdempotencyKey({
      businessId: aggregate.businessId, idempotencyKey: aggregate.idempotencyKey, expectedFingerprint: aggregate.fingerprint,
    })).resolves.toBeNull();
    record.event.quantity = 0;
    record.fingerprint = "corrupt-sidecar";
    await expect(ledger.findByIdempotencyKey({
      businessId: aggregate.businessId, idempotencyKey: aggregate.idempotencyKey, expectedFingerprint: aggregate.fingerprint,
    })).resolves.toBeNull();
  });
  it("applies a canonical event once and recovers it after a restart by tenant and expected fingerprint", async () => {
    const root = testRoot();
    const aggregate = await event();
    const first = createLocalAggregateLedger(createFileAtomicLocalStorage({ root }));
    const applied = await first.applyOnce(aggregate, aggregate.idempotencyKey);
    await expect(first.applyOnce(aggregate, aggregate.idempotencyKey)).resolves.toEqual(applied);

    const recovered = createLocalAggregateLedger(createFileAtomicLocalStorage({ root }));
    await expect(recovered.findByIdempotencyKey({
      businessId: aggregate.businessId, idempotencyKey: aggregate.idempotencyKey, expectedFingerprint: aggregate.fingerprint,
    })).resolves.toEqual(applied);
    await expect(recovered.findByIdempotencyKey({
      businessId: "shop-b", idempotencyKey: aggregate.idempotencyKey, expectedFingerprint: aggregate.fingerprint,
    })).resolves.toBeNull();
  });

  it("rejects a stale canonical identity after a tenant or payload change", async () => {
    const ledger = createLocalAggregateLedger(createMemoryAtomicLocalStorage());
    const aggregate = await event();
    await expect(ledger.applyOnce({ ...aggregate, businessId: "shop-b" }, aggregate.idempotencyKey)).resolves.toEqual({
      kind: "idempotency_conflict", idempotencyKey: aggregate.idempotencyKey,
    });
    await expect(ledger.applyOnce({ ...aggregate, quantity: 1 }, aggregate.idempotencyKey)).resolves.toEqual({
      kind: "idempotency_conflict", idempotencyKey: aggregate.idempotencyKey,
    });
  });

  it("isolates equivalent row identities across tenants after each is canonically constructed", async () => {
    const ledger = createLocalAggregateLedger(createMemoryAtomicLocalStorage());
    const shopA = await event();
    const shopB = await event({ businessId: "shop-b" });
    await expect(ledger.applyOnce(shopA, shopA.idempotencyKey)).resolves.toEqual({ event: shopA, idempotencyKey: shopA.idempotencyKey });
    await expect(ledger.applyOnce(shopB, shopB.idempotencyKey)).resolves.toEqual({ event: shopB, idempotencyKey: shopB.idempotencyKey });
  });
});
