import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import type { SyncTarget } from "@/services/db/syncTarget";
import type { SyncResult } from "@/services/mockDb";
import type { PendingSyncItem } from "@/types";

// Loop 2 proof (store logic, no emulator needed): with the Firebase (cloud) backend, sync uses the ASYNC
// drain and REQUIRES a real business context. Without businessId+userId it PAUSES with a visible error
// and writes nothing; setBusinessContext() then drains the queue. The real Firestore writes/idempotency
// are proven separately by firebaseSyncTarget.rules.test.ts (emulator).

class FakeAsyncTarget implements SyncTarget {
  applied: PendingSyncItem[] = [];
  async apply(item: PendingSyncItem): Promise<SyncResult> {
    await Promise.resolve();
    this.applied.push(item);
    return { ok: true, alreadyApplied: false };
  }
  setFailure() {}
  reset() {}
}

const flush = async () => {
  // let the async drain microtasks settle
  await new Promise((r) => setTimeout(r, 0));
};

describe("scanStore Firebase backend wiring (Loop 2)", () => {
  it("cloud backend starts WITHOUT business context ready", () => {
    const store = createTestScanStore({ db: new FakeAsyncTarget(), cloudBackend: true });
    expect(store.getState().businessContextReady).toBe(false);
    expect(store.getState().userId).toBeNull();
  });

  it("pauses sync with a visible error and writes NOTHING when no business context", async () => {
    const target = new FakeAsyncTarget();
    const store = createTestScanStore({ db: target, cloudBackend: true });
    store.getState().processScan("999999999999"); // unknown -> enqueues a sync item
    await flush();
    expect(target.applied).toHaveLength(0); // no fake/default-business writes
    expect(store.getState().lastSyncError).toMatch(/business/i);
    expect(store.getState().pendingSyncQueue.length).toBeGreaterThan(0);
  });

  it("setBusinessContext drains the queue to the cloud target (async)", async () => {
    const target = new FakeAsyncTarget();
    const store = createTestScanStore({ db: target, cloudBackend: true });
    store.getState().processScan("999999999999");
    await flush();
    expect(target.applied).toHaveLength(0);

    store.getState().setBusinessContext("biz-real", "user-real");
    await flush();
    expect(store.getState().businessContextReady).toBe(true);
    expect(store.getState().userId).toBe("user-real");
    expect(store.getState().businessId).toBe("biz-real");
    expect(target.applied.length).toBeGreaterThan(0); // queued items drained
    expect(store.getState().lastSyncError).toBeNull();
    expect(store.getState().pendingSyncQueue).toHaveLength(0);
  });

  it("the mock/local path is unchanged: synchronous drain, no business context required", () => {
    const store = createTestScanStore(); // default mock, cloudBackend false
    expect(store.getState().businessContextReady).toBe(true);
    store.getState().processScan("999999999999");
    // mock path drains synchronously within processScan -> queue already empty, no await needed
    expect(store.getState().pendingSyncQueue).toHaveLength(0);
  });
});
