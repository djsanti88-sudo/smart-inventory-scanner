import { describe, it, expect } from "vitest";
import { MockDb, type IncrementPayload, type TrustedExactSettlementPayload } from "@/services/mockDb";
import { buildIdempotencyKey } from "@/services/idempotency";
import type { Alias, PendingSyncItem, Product, ScanEvent, UnknownCodeReview } from "@/types";

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

  it("persists an optional physical scan and product snapshot with its increment", () => {
    const db = new MockDb();
    const item = incrementItem("e-snapshot");
    const event = { id: "e-snapshot", businessId: "biz", sessionId: "sess", createdAt: "2026-08-04T00:00:00.000Z" } as ScanEvent;
    const product = { id: "prod-nokian", businessId: "biz", name: "Nokian", verified: true } as Product;
    (item.payload as IncrementPayload).scanEvent = event;
    (item.payload as IncrementPayload).product = product;

    expect(db.apply(item).ok).toBe(true);
    expect(db.getScanEvent("e-snapshot")).toMatchObject({ id: "e-snapshot", createdAt: "2026-08-04T00:00:00.000Z" });
    expect(db.snapshot().products["prod-nokian"]).toMatchObject({ id: "prod-nokian", name: "Nokian" });
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

describe("MockDb trusted exact settlement", () => {
  it("atomically persists the canonical product, terminal event and review while transferring a count once", () => {
    const db = new MockDb();
    db.apply({ ...incrementItem("event-before-settlement"), payload: { ...incrementItem("event-before-settlement").payload as IncrementPayload, productId: "provisional-1" } });
    const product = { id: "canonical-1", businessId: "biz", name: "Known tire", verified: true } as Product;
    const review = { id: "review-1", businessId: "biz", sessionId: "sess", status: "resolved", resolutionAction: "trusted_exact" } as UnknownCodeReview;
    const terminalEvent: ScanEvent = { ...ev("event-before-settlement", "biz", "sess", "2026-08-04T00:00:00.000Z"), matchedProductId: "canonical-1", status: "known", decodeStatus: "verified" };
    const payload: TrustedExactSettlementPayload = {
      businessId: "biz", product, review, terminalEvents: [terminalEvent],
      archivedProduct: { id: "provisional-1", businessId: "biz", name: "Provisional", status: "archived" } as Product,
      countTransfers: [{ sessionId: "sess", fromProductId: "provisional-1", toProductId: "canonical-1", quantity: 1 }],
    };
    const item: PendingSyncItem = {
      id: "settlement-1", businessId: "biz", sessionId: "sess", entityType: "UnknownCodeReview", entityId: review.id,
      operation: "SETTLE_TRUSTED_EXACT", payload, status: "pending", retryCount: 0, lastError: null,
      createdAt: "2026-08-04T00:00:00.000Z", updatedAt: "2026-08-04T00:00:00.000Z", idempotencyKey: "settlement-key", scanEventId: null,
    };

    expect(db.apply(item)).toMatchObject({ ok: true, alreadyApplied: false });
    expect(db.apply(item)).toMatchObject({ ok: true, alreadyApplied: true });
    expect(db.getServerCount("sess", "provisional-1")?.quantity).toBe(0);
    expect(db.getServerCount("sess", "canonical-1")?.quantity).toBe(1);
    expect(db.snapshot()).toMatchObject({
      products: { "canonical-1": { verified: true }, "provisional-1": { status: "archived" } },
      reviews: { "review-1": { resolutionAction: "trusted_exact" } },
      scanEvents: { "event-before-settlement": { matchedProductId: "canonical-1", decodeStatus: "verified" } },
    });
  });
});

function ev(id: string, businessId: string, sessionId: string, createdAt: string): ScanEvent {
  return {
    id, businessId, sessionId, rawCode: "123", cleanCode: "123", normalizedCandidates: ["123"],
    matchedProductId: null, matchType: "unknown", status: "unknown", resolverStatus: "needs_review",
    codeType: "numeric_sku", reason: "test", quantityDelta: 1, quantityAfterScan: 1, createdAt,
    source: "scan", notes: "", syncStatus: "synced", syncError: null, idempotencyKey: `k-${id}`,
  };
}

describe("MockDb.getScanEventsBySession", () => {
  it("returns only events for the given business + session, sorted oldest first", () => {
    const db = new MockDb();
    db.upsertScanEvent(ev("e1", "biz1", "s1", "2026-07-19T16:00:00.000Z"));
    db.upsertScanEvent(ev("e2", "biz1", "s1", "2026-07-19T16:05:00.000Z"));
    db.upsertScanEvent(ev("e3", "biz1", "s2", "2026-07-19T16:01:00.000Z")); // different session
    db.upsertScanEvent(ev("e4", "biz2", "s1", "2026-07-19T16:02:00.000Z")); // different business, same session id
    const result = db.getScanEventsBySession("biz1", "s1");
    expect(result.map((e) => e.id)).toEqual(["e1", "e2"]);
  });

  it("returns an empty array for a session with no events", () => {
    const db = new MockDb();
    expect(db.getScanEventsBySession("biz1", "nope")).toEqual([]);
  });
});
