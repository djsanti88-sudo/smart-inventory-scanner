import { describe, it, expect, vi } from "vitest";
import { DEMO_BUSINESS_ID } from "@/seed/seedData";
import { createTestScanStore } from "@/stores/scanStore";
import type { PendingSyncItem } from "@/types";

describe("resetForSignOut", () => {
  it("wipes tenant state back to the anon baseline", () => {
    const store = createTestScanStore();
    store.setState({
      businessId: "biz-A",
      userId: "user-A",
      scanFeed: [{ id: "e1" } as never],
      needsReviewQueue: [{ id: "r1" } as never],
      pendingSyncQueue: [{ id: "q1" } as never],
      finalCounts: [{ productId: "p1" } as never],
    });
    store.getState().resetForSignOut();
    const s = store.getState();
    expect(s.businessId).toBe(DEMO_BUSINESS_ID);
    expect(s.userId).toBeNull();
    expect(s.scanFeed).toEqual([]);
    expect(s.needsReviewQueue).toEqual([]);
    expect(s.pendingSyncQueue).toEqual([]);
    expect(s.finalCounts).toEqual([]);
  });
});

// F1: sign-out must not silently destroy unsynced work. prepareSignOut is the UI-facing guard: it
// returns how many items STILL could not sync so the handler can warn honestly. resetForSignOut itself
// stays a full clear (asserted above); the guard lives upstream in prepareSignOut + the UI handlers.
function pendingItem(id: string): PendingSyncItem {
  return {
    id,
    businessId: "biz-A",
    sessionId: "session-1",
    entityType: "ScanEvent",
    entityId: `evt-${id}`,
    operation: "SAVE_SCAN_EVENT",
    payload: { id: `evt-${id}` },
    status: "pending",
    retryCount: 0,
    lastError: null,
    createdAt: "2026-06-12T10:00:00.000Z",
    updatedAt: "2026-06-12T10:00:00.000Z",
    idempotencyKey: `idem-${id}`,
    scanEventId: `evt-${id}`,
  };
}

describe("prepareSignOut (F1 unsynced-work guard)", () => {
  it("returns 0 for an empty queue WITHOUT invoking the drain", async () => {
    const store = createTestScanStore();
    // Empty queue is the common case: no needless drain call on a clean sign-out.
    const syncSpy = vi.fn();
    store.setState({ pendingSyncQueue: [], syncPending: syncSpy });
    const left = await store.getState().prepareSignOut();
    expect(left).toBe(0);
    expect(syncSpy).not.toHaveBeenCalled();
  });

  it("resolves with the count of items that survived a FAILED drain attempt (simulated sync failure)", async () => {
    const store = createTestScanStore();
    store.setState({ businessId: "biz-A", userId: "user-A", online: true });
    // One genuinely pending item; force every apply() to fail so the item cannot drain.
    store.getState().setSimulateSyncFailure(true);
    store.setState({ pendingSyncQueue: [pendingItem("q1")] });
    const left = await store.getState().prepareSignOut();
    // The drain ran (established retry path) but the item could not sync, so it survives and is counted.
    expect(left).toBe(1);
    expect(store.getState().pendingSyncQueue).toHaveLength(1);
  });
});
