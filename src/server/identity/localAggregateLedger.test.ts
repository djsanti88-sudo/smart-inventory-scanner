import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileAtomicLocalStorage, createMemoryAtomicLocalStorage } from "./atomicLocalStorage";
import { createLocalAggregateLedger } from "./localAggregateLedger";
import { canonicalSha256 } from "@/services/identity/canonical";

const storageBase = path.resolve(process.cwd(), ".tmp", "identity-import");
const ownedRoots: string[] = [];

function testRoot(): string {
  const root = path.resolve(storageBase, `ledger-${randomUUID()}`);
  ownedRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    ownedRoots.splice(0).map(async (root) => {
      if (path.dirname(root) !== storageBase) throw new Error("refusing to remove a non-test identity root");
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("local aggregate ledger", () => {
  it("returns the stored idempotent result after storage reconstruction", async () => {
    const root = testRoot();
    const event = {
      kind: "aggregate_import" as const,
      eventId: "event-1",
      importId: "import-1",
      rowId: "row-1",
      businessId: "shop-a",
      quantity: 4,
      unitOfMeasure: "each" as const,
      sourceFileOrdinal: 0,
      sheetName: "Inventory",
      sourceRowNumber: 2,
    };
    const first = createLocalAggregateLedger(createFileAtomicLocalStorage({ root }));
    await first.apply(event, "import-1:row-1", "operation-1");

    const second = createLocalAggregateLedger(createFileAtomicLocalStorage({ root }));
    await expect(second.get({ businessId: "shop-a", idempotencyKey: "import-1:row-1", eventFingerprint: "wrong", operationFingerprint: "operation-1" })).resolves.toBeUndefined();
    await expect(second.get({ businessId: "shop-a", idempotencyKey: "import-1:row-1", eventFingerprint: await canonicalSha256(event), operationFingerprint: "operation-1" })).resolves.toEqual({
      event,
      idempotencyKey: "import-1:row-1",
    });
  });

  it("returns idempotency_conflict for a changed payload within one tenant", async () => {
    const ledger = createLocalAggregateLedger(createMemoryAtomicLocalStorage());
    const event = { kind: "aggregate_import" as const, eventId: "event", importId: "import", rowId: "row", businessId: "shop-a", quantity: 1, unitOfMeasure: "each" as const, sourceFileOrdinal: 0, sheetName: "Inventory", sourceRowNumber: 2 };
    await ledger.apply(event, "same-key", "operation-a");
    await expect(ledger.apply({ ...event, businessId: "shop-b" }, "same-key", "operation-a")).resolves.toEqual({ event: { ...event, businessId: "shop-b" }, idempotencyKey: "same-key" });
    await expect(ledger.apply({ ...event, quantity: 2 }, "same-key", "operation-a")).resolves.toMatchObject({ kind: "idempotency_conflict" });
  });

  it("never exposes a different tenant's result through recovery lookup", async () => {
    const ledger = createLocalAggregateLedger(createMemoryAtomicLocalStorage());
    const event = { kind: "aggregate_import" as const, eventId: "event", importId: "import", rowId: "row", businessId: "shop-a", quantity: 1, unitOfMeasure: "each" as const, sourceFileOrdinal: 0, sheetName: "Inventory", sourceRowNumber: 2 };
    await ledger.apply(event, "same-key", "operation-a");
    await expect(ledger.get({ businessId: "shop-b", idempotencyKey: "same-key", eventFingerprint: await canonicalSha256(event), operationFingerprint: "operation-a" })).resolves.toBeUndefined();
  });

  it("isolates same idempotency keys by the canonical tenant tuple", async () => {
    const ledger = createLocalAggregateLedger(createMemoryAtomicLocalStorage());
    const shopA = { kind: "aggregate_import" as const, eventId: "event-a", importId: "import", rowId: "row", businessId: "shop-a", quantity: 1, unitOfMeasure: "each" as const, sourceFileOrdinal: 0, sheetName: "Inventory", sourceRowNumber: 2 };
    const shopB = { ...shopA, eventId: "event-b", businessId: "shop-b" };
    await ledger.apply(shopA, "same-key", "operation-a");
    await expect(ledger.apply(shopB, "same-key", "operation-b")).resolves.toEqual({ event: shopB, idempotencyKey: "same-key" });
    await expect(ledger.apply({ ...shopA, quantity: 2 }, "same-key", "operation-a")).resolves.toMatchObject({ kind: "idempotency_conflict" });
  });
});
