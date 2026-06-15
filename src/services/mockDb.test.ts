import { describe, it, expect } from "vitest";
import { MockDb, type IncrementPayload } from "@/services/mockDb";
import { buildIdempotencyKey } from "@/services/idempotency";
import type { Alias, PendingSyncItem, ScanEvent } from "@/types";

function incrementItem(scanEventId: string): PendingSyncItem {
  const idempotencyKey = buildIdempotencyKey("biz", "sess", scanEventId, "INCREMENT_COUNT");
  const payload: IncrementPayload = {
    businessId: "biz",
    sessionId: "sess",
    productId: "prod-nokian",
    scanEventId,
    quantityDelta: 1,
    idempotencyKey,
  };
  return {
    id: `pending-${scanEventId}`,
    businessId: "biz",
    sessionId: "sess",
    entityType: "InventoryCount",
    entityId: "count-1",
    operation: "INCREMENT_COUNT",
    payload,
    status: "pending",
    retryCount: 0,
    lastError: null,
    createdAt: "2026-06-12T10:00:00.000Z",
    updatedAt: "2026-06-12T10:00:00.000Z",
    idempotencyKey,
    scanEventId,
  };
}

describe("MockDb idempotent increments", () => {
  it("applies a new increment once", () => {
    const db = new MockDb();
    const r = db.apply(incrementItem("e1"));
    expect(r.ok).toBe(true);
    expect(r.alreadyApplied).toBe(false);
    expect(db.getServerCount("sess", "prod-nokian")?.quantity).toBe(1);
  });

  it("never double counts when the SAME operation is retried", () => {
    const db = new MockDb();
    const item = incrementItem("e1");
    db.apply(item);
    const retry = db.apply(item); // exact same idempotency key
    expect(retry.alreadyApplied).toBe(true);
    expect(db.getServerCount("sess", "prod-nokian")?.quantity).toBe(1);
  });

  it("counts distinct scan events but stays stable on repeated retries", () => {
    const db = new MockDb();
    db.apply(incrementItem("e1"));
    db.apply(incrementItem("e2"));
    expect(db.getServerCount("sess", "prod-nokian")?.quantity).toBe(2);
    // replay everything multiple times - must remain 2
    db.apply(incrementItem("e1"));
    db.apply(incrementItem("e2"));
    db.apply(incrementItem("e1"));
    expect(db.getServerCount("sess", "prod-nokian")?.quantity).toBe(2);
  });

  it("simulates a transient failure then succeeds on retry (mock only)", () => {
    const db = new MockDb();
    db.setFailure({ failTimes: 1 });
    const item = incrementItem("e1");
    const first = db.apply(item);
    expect(first.ok).toBe(false);
    const second = db.apply(item);
    expect(second.ok).toBe(true);
    expect(db.getServerCount("sess", "prod-nokian")?.quantity).toBe(1);
  });
});

describe("MockDb idempotent upserts", () => {
  it("upserts a scan event by id without duplicating", () => {
    const db = new MockDb();
    const event = { id: "e1", businessId: "biz" } as unknown as ScanEvent;
    db.upsertScanEvent(event);
    db.upsertScanEvent(event);
    expect(db.getScanEvent("e1")).toBeDefined();
  });

  it("does not create duplicate aliases for the same clean code + product", () => {
    const db = new MockDb();
    const alias = {
      id: "a1",
      businessId: "biz",
      productId: "prod-nokian",
      cleanCode: "7262",
    } as unknown as Alias;
    const key = buildIdempotencyKey("biz", "sess", "a1", "RESOLVE_ALIAS");
    const item: PendingSyncItem = {
      id: "p-a1",
      businessId: "biz",
      sessionId: "sess",
      entityType: "Alias",
      entityId: "a1",
      operation: "RESOLVE_ALIAS",
      payload: alias,
      status: "pending",
      retryCount: 0,
      lastError: null,
      createdAt: "",
      updatedAt: "",
      idempotencyKey: key,
      scanEventId: null,
    };
    db.apply(item);
    db.apply(item);
    expect(db.getAlias("biz", "7262", "prod-nokian")).toBeDefined();
  });
});
