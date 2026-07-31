import { describe, expect, it } from "vitest";

import { createMemoryAtomicLocalStorage } from "@/server/identity/atomicLocalStorage";
import { createLocalAggregateLedger } from "@/server/identity/localAggregateLedger";
import {
  createAggregateImportEvent,
  mapAggregateImportEventToCountDelta,
} from "./importLedger";

const physicalRow = {
  businessId: "shop-a",
  importId: "import-1",
  rowId: "row-7",
  productId: "product-1",
  sessionId: "physical-count-1",
  quantity: 7,
  sourceFileOrdinal: 0,
  sheetName: "Inventory",
  sourceRowNumber: 8,
  createdAt: "2026-07-31T12:00:00.000Z",
};

describe("aggregate import ledger adapter", () => {
  it("creates one neutral aggregate event and delta for a physical row quantity", () => {
    const event = createAggregateImportEvent(physicalRow);

    expect(event).toMatchObject({
      kind: "aggregate_import",
      businessId: "shop-a",
      importId: "import-1",
      rowId: "row-7",
      productId: "product-1",
      sessionId: "physical-count-1",
      quantity: 7,
      unitOfMeasure: "each",
    });
    expect(event).not.toHaveProperty("rawCode");
    expect(event).not.toHaveProperty("cleanCode");
    expect(event).not.toHaveProperty("aliasesSeen");

    expect(mapAggregateImportEventToCountDelta(event)).toEqual({
      eventId: event.eventId,
      idempotencyKey: event.idempotencyKey,
      businessId: "shop-a",
      productId: "product-1",
      sessionId: "physical-count-1",
      quantityDelta: 7,
      createdAt: "2026-07-31T12:00:00.000Z",
    });
  });

  it("derives stable event and idempotency identities from the tenant import row", () => {
    const first = createAggregateImportEvent(physicalRow);
    const sameRow = createAggregateImportEvent({ ...physicalRow, quantity: 9 });
    const otherTenant = createAggregateImportEvent({ ...physicalRow, businessId: "shop-b" });

    expect(sameRow.eventId).toBe(first.eventId);
    expect(sameRow.idempotencyKey).toBe(first.idempotencyKey);
    expect(otherTenant.eventId).not.toBe(first.eventId);
    expect(otherTenant.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it("refuses an invalid physical quantity instead of creating a count event", () => {
    expect(() => createAggregateImportEvent({ ...physicalRow, quantity: 0 })).toThrow(
      "aggregate import quantity must be a finite positive number",
    );
  });

  it("uses the retained tenant-scoped ledger for retry and fingerprint conflict handling", async () => {
    const ledger = createLocalAggregateLedger(createMemoryAtomicLocalStorage());
    const event = createAggregateImportEvent(physicalRow);

    const first = await ledger.apply(event, event.idempotencyKey, "operation-1");
    await expect(ledger.apply(event, event.idempotencyKey, "operation-1")).resolves.toEqual(first);
    await expect(
      ledger.apply({ ...event, quantity: 8 }, event.idempotencyKey, "operation-1"),
    ).resolves.toEqual({ kind: "idempotency_conflict", idempotencyKey: event.idempotencyKey });
    await expect(
      ledger.apply({ ...event, businessId: "shop-b" }, event.idempotencyKey, "operation-1"),
    ).resolves.toEqual({ event: { ...event, businessId: "shop-b" }, idempotencyKey: event.idempotencyKey });
  });
});
