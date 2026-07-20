import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";
import { buildPersistedScanState, type PersistableScanState } from "@/stores/scanPersist";

// P6 C2: firstScanAt is a set-once ISO timestamp of this business's FIRST counted scan (any path),
// used to drive the /scan first-run banner (scanFeed.length === 0 && firstScanAt === null). Written
// AFTER the count is applied (TOP-LEVEL LAW: counting is never gated on this flag).

// `now()` is called multiple times per processScan (createdAt, event stamps, etc.), so we cannot pin
// an exact tick index to the firstScanAt write. Assert shape (valid ISO string) and set-once behavior
// (unchanged across later scans) instead - the store-level default fixed clock is used elsewhere.
function makeClockingStore() {
  return createTestScanStore({ db: new MockDb() });
}

describe("firstScanAt set-once", () => {
  it("is null before any scan", () => {
    const store = createTestScanStore({ db: new MockDb() });
    expect(store.getState().firstScanAt).toBeNull();
  });

  it("is set to an ISO timestamp on the first counted scan (known product)", () => {
    const store = makeClockingStore();
    expect(store.getState().firstScanAt).toBeNull();
    // "111111111116" is not in the seed - unknown scan, still counts via ensureProvisionalCount
    // (owner rule "scan N = count N").
    store.getState().processScan("111111111116");
    const stamp = store.getState().firstScanAt;
    expect(stamp).not.toBeNull();
    expect(new Date(stamp as string).toISOString()).toBe(stamp);
  });

  it("is NOT updated on a second scan (set-once, never overwritten)", () => {
    const store = makeClockingStore();
    store.getState().processScan("111111111116");
    const first = store.getState().firstScanAt;
    expect(first).not.toBeNull();
    store.getState().processScan("222222222229");
    expect(store.getState().firstScanAt).toBe(first);
  });

  it("stays null when a scan is blocked before counting (locked session)", () => {
    const store = createTestScanStore({ db: new MockDb() });
    // Lock a session with no PIN set is not directly testable here without setup; instead assert the
    // documented ordering indirectly: a completed session guard blocks processScan entirely (returns
    // null), and firstScanAt must remain untouched.
    store.getState().startSession("s1", "Main");
    store.getState().finishSession();
    const result = store.getState().processScan("333333333332");
    expect(result).toBeNull();
    expect(store.getState().firstScanAt).toBeNull();
  });

  it("repeated ensureProvisionalCount calls for the same code do not move the timestamp", () => {
    const store = makeClockingStore();
    store.getState().processScan("444444444445"); // counts + sets firstScanAt via ensureProvisionalCount
    const first = store.getState().firstScanAt;
    store.getState().ensureProvisionalCount("444444444445", "test"); // idempotent no-op (already counted)
    expect(store.getState().firstScanAt).toBe(first);
  });

  it("is included in the persisted (partialize) state for both platform and business access levels", () => {
    const store = makeClockingStore();
    store.getState().processScan("555555555558");
    const s = store.getState();
    const persistable: PersistableScanState = {
      userId: s.userId,
      businessId: s.businessId,
      sessionId: s.sessionId,
      currentSession: s.currentSession,
      location: s.location,
      recentLocations: s.recentLocations,
      settings: s.settings,
      pendingSyncQueue: s.pendingSyncQueue,
      syncedScanEventIds: s.syncedScanEventIds,
      simulateSyncFailure: s.simulateSyncFailure,
      products: s.products as unknown as Array<Record<string, unknown>>,
      aliases: s.aliases,
      scanFeed: s.scanFeed,
      finalCounts: s.finalCounts as unknown as Array<Record<string, unknown>>,
      needsReviewQueue: s.needsReviewQueue,
      lastCleanupBackup: s.lastCleanupBackup,
      catalog: s.catalog,
      shopOverrides: s.shopOverrides,
      feedbackEvents: s.feedbackEvents,
      countSnapshots: s.countSnapshots,
      firstScanAt: s.firstScanAt,
    };
    const platformBlob = buildPersistedScanState(persistable, "platform");
    const businessBlob = buildPersistedScanState(persistable, "business");
    expect(platformBlob.firstScanAt).toBe(s.firstScanAt);
    expect(businessBlob.firstScanAt).toBe(s.firstScanAt);
    expect(s.firstScanAt).not.toBeNull();
  });
});
