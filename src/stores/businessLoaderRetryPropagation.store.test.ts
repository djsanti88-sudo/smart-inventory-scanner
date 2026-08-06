// Profiler-proven defect (task-profile-report.md): a fresh-device bootstrap hung FOREVER on
// "Loading business data..." because businessDataLoader's getDocs calls had no timeout/retry, so
// setBusinessContext's internal load promise never settled and businessDataLoaded stayed false
// forever. This test wires the REAL loadBusinessData (from businessDataLoader.ts, with Firestore's
// getDocs mocked to hang like a stuck transport channel) through the real store, proving the bounded
// retry's eventual rejection propagates all the way into `businessDataLoaded`/`lastSyncError` - the
// exact flags BusinessContextGate reads to stop showing the loading banner, and that SyncStatusBar
// reads to show its error text + "Try saving again" / "Refresh" retry affordance. Without this
// propagation, a bounded-but-unsurfaced rejection would still leave the UI hung.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";

const mocks = vi.hoisted(() => ({
  getDocs: vi.fn(),
}));

vi.mock("firebase/firestore", () => ({
  getDocs: (reference: unknown) => mocks.getDocs(reference),
  collection: vi.fn((_db: unknown, ...segments: string[]) => ({ path: segments.join("/") })),
  query: vi.fn((ref: unknown, ...constraints: unknown[]) => ({ ref, constraints })),
  where: vi.fn((field: string, op: string, value: unknown) => ({ field, op, value })),
  orderBy: vi.fn((field: string, dir: string) => ({ field, dir })),
}));

import { loadBusinessData, LOAD_ATTEMPT_TIMEOUT_MS, LOAD_MAX_ATTEMPTS } from "@/services/db/firebase/businessDataLoader";
import type { Firestore } from "firebase/firestore";

const fakeDb = {} as Firestore;

afterEach(() => {
  mocks.getDocs.mockReset();
  vi.useRealTimers();
});

describe("businessDataLoader retry propagates into the store (unblocks the eternal loading banner)", () => {
  it("a permanently hung Firestore transport eventually surfaces as lastSyncError + businessDataLoaded=true, never an eternal hang", async () => {
    vi.useFakeTimers();
    mocks.getDocs.mockReturnValue(new Promise(() => {})); // stuck transport channel: never settles

    const store = createTestScanStore({
      cloudBackend: true,
      loadBusinessData: (businessId) => loadBusinessData(fakeDb, businessId),
    });

    store.getState().setBusinessContext("biz-1", "user-1");

    // Immediately after setBusinessContext: still loading, exactly matching BusinessContextGate's
    // "Loading business data..." condition (businessContextReady && !businessDataLoaded).
    expect(store.getState().businessContextReady).toBe(true);
    expect(store.getState().businessDataLoaded).toBe(false);

    const totalBoundMs = LOAD_ATTEMPT_TIMEOUT_MS * LOAD_MAX_ATTEMPTS + 15_000;
    await vi.advanceTimersByTimeAsync(totalBoundMs);

    // The bounded retry's rejection reached the store: businessDataLoaded flips true (Gate stops
    // showing "Loading business data..." forever) and lastSyncError is set (SyncStatusBar's error
    // text + Refresh/"Try saving again" retry button becomes visible instead of a silent hang).
    expect(store.getState().businessDataLoaded).toBe(true);
    expect(store.getState().lastSyncError).toMatch(/Timed out/i);
  });

  it("refreshFromCloud (the visible Retry affordance) recovers once the transport comes back", async () => {
    vi.useFakeTimers();
    mocks.getDocs.mockReturnValue(new Promise(() => {}));

    const store = createTestScanStore({
      cloudBackend: true,
      loadBusinessData: (businessId) => loadBusinessData(fakeDb, businessId),
    });

    store.getState().setBusinessContext("biz-1", "user-1");
    await vi.advanceTimersByTimeAsync(LOAD_ATTEMPT_TIMEOUT_MS * LOAD_MAX_ATTEMPTS + 15_000);
    expect(store.getState().lastSyncError).toMatch(/Timed out/i);

    // Transport recovers; user clicks Refresh (calls refreshFromCloud, which re-invokes loadBusinessData).
    mocks.getDocs.mockResolvedValue({ docs: [] });
    await store.getState().refreshFromCloud();

    expect(store.getState().lastSyncError).toBeNull();
    expect(store.getState().businessDataLoaded).toBe(true);
  });
});
