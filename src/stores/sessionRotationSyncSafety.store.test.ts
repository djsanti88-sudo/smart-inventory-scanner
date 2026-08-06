import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import type { SyncTarget } from "@/services/db/syncTarget";
import type { SyncResult } from "@/services/mockDb";
import type { Alias, InventoryCount, InventorySession, PendingSyncItem, Product } from "@/types";

// Data-loss regression (owner 4k live campaign, 2026-08-05): startSession wiped pendingSyncQueue,
// so rotating to a new session while the previous session's sync backlog was still draining
// silently discarded every unsynced cloud write (scan events, counts, the session doc itself).
// Live damage measured on the emulator rig: session 5 lost 150/500 scan events, session 7 lost
// all 500 plus its session doc, session 8 lost 350. Rotation must PRESERVE the queue - items
// carry their own sessionId/businessId and the drain is already tenant/session-aware (same
// principle as setBusinessContext's "deliberately NOT filtered" rule).

class SlowTarget implements SyncTarget {
  applied: PendingSyncItem[] = [];
  async apply(item: PendingSyncItem): Promise<SyncResult> {
    await new Promise((r) => setTimeout(r, 5)); // real round-trip: rotation happens mid-drain
    this.applied.push(item);
    return { ok: true, alreadyApplied: false };
  }
  setFailure() {}
  reset() {}
}

const CODE = "111222333444";
const product = {
  id: "p-rot", businessId: "biz-rot", name: "Rotation Widget", brand: "", category: "", specsShort: "", specsFull: "",
  primarySku: "", primaryBarcode: CODE, gtin: "", upc: "", ean: "", vendorCodes: [], aliases: [CODE], imageUrl: "",
  productUrl: "", location: "", notes: "", status: "active", source: "manual", confidence: 1, verified: true,
  createdAt: "t", updatedAt: "t", createdBy: "human", updatedBy: "human",
} as Product;
const alias = {
  id: "a-rot", businessId: "biz-rot", productId: "p-rot", rawCodeExample: CODE, cleanCode: CODE,
  normalizedCode: CODE, aliasType: "barcode", source: "manual", confidence: 1, approved: true, createdAt: "t",
  updatedAt: "t", createdBy: "human", lastSeenAt: "t", syncStatus: "synced", idempotencyKey: "k",
} as Alias;

const loader = async () => ({ products: [product], aliases: [alias], sessions: [] as InventorySession[], counts: [] as InventoryCount[] });

describe("session rotation sync safety (data-loss regression 2026-08-05)", () => {
  it("startSession preserves the previous session's unsynced queue items and they all reach the target", async () => {
    const target = new SlowTarget();
    const store = createTestScanStore({ db: target, cloudBackend: true, loadBusinessData: loader });
    store.getState().setBusinessContext("biz-rot", "user-rot");
    await new Promise((r) => setTimeout(r, 20));

    const N = 6;
    for (let i = 0; i < N; i++) store.getState().processScan(CODE);
    const firstSessionId = store.getState().currentSession?.id;
    expect(store.getState().pendingSyncQueue.length).toBeGreaterThan(0); // backlog exists mid-drain

    // Rotate IMMEDIATELY - the previous session's backlog has not finished draining.
    store.getState().finishSession();
    store.getState().startSession("Next count", "Main");

    await new Promise((r) => setTimeout(r, 500)); // let every chained drain finish

    const incrementsForFirst = target.applied.filter(
      (i) => i.operation === "INCREMENT_COUNT" && i.sessionId === firstSessionId,
    );
    const eventsForFirst = target.applied.filter(
      (i) => i.operation === "SAVE_SCAN_EVENT" && i.sessionId === firstSessionId,
    );
    const completedSessionSaves = target.applied.filter(
      (i) => i.operation === "SAVE_SESSION" && i.entityId === firstSessionId,
    );
    expect(eventsForFirst).toHaveLength(N); // every scan event survived the rotation
    expect(incrementsForFirst).toHaveLength(N); // every count increment survived the rotation
    expect(completedSessionSaves.length).toBeGreaterThanOrEqual(1); // the finish write survived too
    expect(store.getState().pendingSyncQueue).toHaveLength(0); // and the queue fully drained
  });
});
