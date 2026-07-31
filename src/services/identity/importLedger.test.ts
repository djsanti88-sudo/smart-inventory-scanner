import { describe, expect, it } from "vitest";

import { createMemoryAtomicLocalStorage } from "@/server/identity/atomicLocalStorage";
import { createLocalAggregateLedger } from "@/server/identity/localAggregateLedger";
import type { AggregateLedgerPort, AggregateLedgerResult } from "./types";
import {
  createAggregateImportEvent,
  mapAggregateImportEventToCountDelta,
  MAX_IMPORT_QUANTITY,
  planAggregateImportEvent,
} from "./importLedger";
import { MAX_IMPORT_QUANTITY as SHARED_MAX_IMPORT_QUANTITY } from "../importQuantity";
import { MAX_IMPORT_QUANTITY as PREVIEW_MAX_IMPORT_QUANTITY } from "../universalImportPreview";

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

function fakeAggregateLedger(): AggregateLedgerPort {
  const entries = new Map<string, { event: Awaited<ReturnType<typeof createAggregateImportEvent>>; key: string }>();
  const entryKey = (businessId: string, key: string) => JSON.stringify([businessId, key]);
  const applyOnce = async (event: Awaited<ReturnType<typeof createAggregateImportEvent>>, key: string): Promise<AggregateLedgerResult> => {
    const existing = entries.get(entryKey(event.businessId, key));
    if (!existing) {
      entries.set(entryKey(event.businessId, key), { event, key });
      return { event, idempotencyKey: key };
    }
    return existing.event.fingerprint === event.fingerprint
      ? { event: existing.event, idempotencyKey: existing.key }
      : { kind: "idempotency_conflict", idempotencyKey: key };
  };
  return {
    applyOnce,
    async findByIdempotencyKey({ businessId, idempotencyKey, expectedFingerprint }) {
      const existing = entries.get(entryKey(businessId, idempotencyKey));
      return existing?.event.fingerprint === expectedFingerprint
        ? { event: existing.event, idempotencyKey: existing.key }
        : null;
    },
    async apply(event, key, operationFingerprint) {
      return operationFingerprint === event.fingerprint ? applyOnce(event, key) : { kind: "idempotency_conflict", idempotencyKey: key };
    },
    async get({ businessId, idempotencyKey, eventFingerprint }) {
      const result = await this.findByIdempotencyKey({ businessId, idempotencyKey, expectedFingerprint: eventFingerprint });
      return result && "event" in result ? result : undefined;
    },
  };
}

describe("aggregate import ledger adapter", () => {
  it("uses the shared 100000 quantity cap for both preview and aggregate accounting", () => {
    expect(SHARED_MAX_IMPORT_QUANTITY).toBe(100_000);
    expect(MAX_IMPORT_QUANTITY).toBe(SHARED_MAX_IMPORT_QUANTITY);
    expect(PREVIEW_MAX_IMPORT_QUANTITY).toBe(SHARED_MAX_IMPORT_QUANTITY);
  });
  it.each([
    ["reconcile", "automatic", "product-1"],
    ["physical_count", "invalid", undefined],
    ["physical_count", "non_product", undefined],
    ["physical_count", "review", "product-1"],
    ["physical_count", "abstain", undefined],
  ] as const)("does not plan an aggregate event for %s / %s", async (mode, kind, targetProductId) => {
    await expect(planAggregateImportEvent({
      ...physicalRow,
      mode,
      decision: { kind, targetProductId },
    })).resolves.toBeNull();
  });

  it("plans an aggregate event only for a physical automatic or approved resolution", async () => {
    await expect(planAggregateImportEvent({
      ...physicalRow,
      mode: "physical_count",
      decision: { kind: "automatic", targetProductId: "product-1" },
    })).resolves.toMatchObject({ kind: "aggregate_import", productId: "product-1" });
    await expect(planAggregateImportEvent({
      ...physicalRow,
      mode: "physical_count",
      decision: { kind: "review", approvedProductId: "product-1" },
    })).resolves.toMatchObject({ kind: "aggregate_import", productId: "product-1" });
  });

  it("creates one neutral aggregate event and delta for a physical row quantity", async () => {
    const event = await createAggregateImportEvent({
      ...physicalRow,
      mode: "physical_count",
      decision: { kind: "automatic", targetProductId: "product-1" },
    });

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
    expect(event.fingerprint).toMatch(/^[a-f0-9]{64}$/);
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

  it("derives stable event and idempotency identities from the tenant import row", async () => {
    const first = await createAggregateImportEvent({ ...physicalRow, mode: "physical_count", decision: { kind: "automatic", targetProductId: "product-1" } });
    const sameRow = await createAggregateImportEvent({ ...physicalRow, quantity: 9, mode: "physical_count", decision: { kind: "automatic", targetProductId: "product-1" } });
    const otherTenant = await createAggregateImportEvent({ ...physicalRow, businessId: "shop-b", mode: "physical_count", decision: { kind: "automatic", targetProductId: "product-1" } });

    expect(sameRow.eventId).toBe(first.eventId);
    expect(sameRow.idempotencyKey).toBe(first.idempotencyKey);
    expect(otherTenant.eventId).not.toBe(first.eventId);
    expect(otherTenant.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, MAX_IMPORT_QUANTITY + 1])(
    "refuses invalid quantity %s before event creation",
    async (quantity) => {
      await expect(createAggregateImportEvent({ ...physicalRow, quantity, mode: "physical_count", decision: { kind: "automatic", targetProductId: "product-1" } })).rejects.toThrow("aggregate import quantity");
    },
  );

  it("retains zero as one auditable aggregate event", async () => {
    await expect(createAggregateImportEvent({ ...physicalRow, quantity: 0, mode: "physical_count", decision: { kind: "automatic", targetProductId: "product-1" } })).resolves.toMatchObject({ quantity: 0 });
  });

  it("lets an injected fake port return the existing result for a duplicate and conflict for a changed fingerprint", async () => {
    const ledger = fakeAggregateLedger();
    const event = await createAggregateImportEvent({ ...physicalRow, mode: "physical_count", decision: { kind: "automatic", targetProductId: "product-1" } });

    const first = await ledger.applyOnce(event, event.idempotencyKey);
    await expect(ledger.applyOnce(event, event.idempotencyKey)).resolves.toEqual(first);
    await expect(
      ledger.applyOnce({ ...event, quantity: 8, fingerprint: "changed-fingerprint" }, event.idempotencyKey),
    ).resolves.toEqual({ kind: "idempotency_conflict", idempotencyKey: event.idempotencyKey });
  });

  it("uses the concrete tenant-scoped ledger for retry and fingerprint conflict handling", async () => {
    const ledger = createLocalAggregateLedger(createMemoryAtomicLocalStorage());
    const event = await createAggregateImportEvent({ ...physicalRow, mode: "physical_count", decision: { kind: "automatic", targetProductId: "product-1" } });
    await expect(ledger.applyOnce(event, event.idempotencyKey)).resolves.toEqual({ event, idempotencyKey: event.idempotencyKey });
    await expect(ledger.findByIdempotencyKey({
      businessId: event.businessId, idempotencyKey: event.idempotencyKey, expectedFingerprint: event.fingerprint,
    })).resolves.toEqual({ event, idempotencyKey: event.idempotencyKey });
  });
});
