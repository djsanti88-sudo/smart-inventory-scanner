import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

function makeStore() {
  const db = new MockDb();
  const store = createTestScanStore({ db });
  // AI off so the unknown never dispatches a live decode; the scan still counts synchronously.
  store.getState().updateSettings({ aiLookupEnabled: false });
  return { db, store };
}

// The mock/local backend drains the sync queue SYNCHRONOUSLY with a REAL ack (documented in
// sessionPersistence.store.test.ts: "SAVE_SESSION drained synchronously"). To observe the D1
// pending state (ops enqueued, row not yet acked) we force sync failure first - the established
// pattern from scanStore.test.ts ("keeps scans locally as pending when sync fails").
function pendingStore() {
  const { db, store } = makeStore();
  store.getState().setSimulateSyncFailure(true);
  return { db, store };
}

describe("D1: every unknown scan enqueues its ledger writes and is never fake-synced", () => {
  it("an unknown scan enqueues SAVE_PRODUCT, SAVE_SCAN_EVENT and INCREMENT_COUNT", () => {
    const { store } = pendingStore();
    store.getState().processScan("888888888882");
    const ops = store.getState().pendingSyncQueue.map((q) => q.operation);
    expect(ops).toContain("SAVE_PRODUCT");
    expect(ops).toContain("SAVE_SCAN_EVENT");
    expect(ops).toContain("INCREMENT_COUNT");
  });

  it("the counted unknown feed row is NOT stamped synced before an ack and carries the same-fact quantityDelta 1", () => {
    const { store } = pendingStore();
    store.getState().processScan("888888888882");
    const row = store.getState().scanFeed.find((e) => e.cleanCode === "888888888882")!;
    expect(row.status).toBe("known"); // counted against a provisional
    // No ack has happened (sync is failing) - the OLD code fake-stamped "synced" here regardless.
    expect(row.syncStatus).not.toBe("synced");
    expect(row.quantityDelta, "the stored event and the counted delta are the same fact").toBe(1);
  });

  it("the enqueued INCREMENT_COUNT idempotency key matches the counted event's key (no re-key)", () => {
    const { store } = pendingStore();
    store.getState().processScan("888888888882");
    const row = store.getState().scanFeed.find((e) => e.cleanCode === "888888888882")!;
    const inc = store.getState().pendingSyncQueue.find((q) => q.operation === "INCREMENT_COUNT" && q.scanEventId === row.id);
    expect(inc, "an INCREMENT_COUNT is enqueued for this scan event").toBeDefined();
    expect(inc!.idempotencyKey).toBe(row.idempotencyKey);
  });

  it("re-scanning the same unknown increments the count and enqueues a second INCREMENT_COUNT, still no double product row", () => {
    const { store } = pendingStore();
    store.getState().processScan("888888888882");
    store.getState().processScan("888888888882");
    expect(store.getState().finalCounts.reduce((n, c) => n + c.quantity, 0)).toBe(2);
    expect(store.getState().finalCounts.length).toBe(1);
    const incs = store.getState().pendingSyncQueue.filter((q) => q.operation === "INCREMENT_COUNT");
    expect(incs.length).toBe(2);
  });

  it("clearing the failure and retrying drains the queue, acks the row for REAL, and applies the count exactly once", () => {
    const { db, store } = pendingStore();
    store.getState().processScan("888888888882");
    const row = store.getState().scanFeed.find((e) => e.cleanCode === "888888888882")!;
    const productId = row.matchedProductId!;
    expect(productId).toBeTruthy();

    store.getState().setSimulateSyncFailure(false);
    store.getState().retrySync();

    // Queue drained; the row now reads synced because a REAL ack happened (db.apply succeeded),
    // not because anything stamped it optimistically.
    expect(store.getState().pendingSyncQueue).toHaveLength(0);
    const acked = store.getState().scanFeed.find((e) => e.cleanCode === "888888888882")!;
    expect(acked.syncStatus).toBe("synced");

    // Server-side truth: the provisional product, its scan event, and the count applied exactly once.
    expect(db.snapshot().products[productId], "SAVE_PRODUCT reached the backend").toBeDefined();
    expect(db.getScanEvent(row.id), "SAVE_SCAN_EVENT reached the backend").toBeDefined();
    expect(db.getServerCount("session-1", productId)?.quantity).toBe(1);

    // Idempotency: retrying again must never double-apply.
    store.getState().retrySync();
    store.getState().retrySync();
    expect(db.getServerCount("session-1", productId)?.quantity).toBe(1);
  });

  it("the minted provisional product carries provenanceTier 'provisional' from birth", () => {
    const { store } = makeStore();
    store.getState().processScan("777777777775");
    const prod = store.getState().products.find((p) => p.primaryBarcode === "777777777775")!;
    expect(prod.provisional).toBe(true);
    expect(prod.provenanceTier).toBe("provisional");
  });
});
