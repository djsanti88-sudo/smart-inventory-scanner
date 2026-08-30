import { describe, it, expect, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import type { SyncTarget } from "@/sync-database/syncTarget";
import type { SyncResult } from "@/sync-database/mock/mockDb";
import type { PendingSyncItem } from "@/types";

// Bug #2 proof: "Clear local cache" must NOT call db.reset() in CLOUD mode (FirebaseSyncTarget.reset()
// throws a destructive-cloud guard) and must clear only browser-local state. In mock mode it still resets
// the local MockDb. No destructive cloud reset is ever attempted.

class CloudLikeTarget implements SyncTarget {
  resetCalls = 0;
  async apply(_item: PendingSyncItem): Promise<SyncResult> {
    await Promise.resolve();
    return { ok: true, alreadyApplied: false };
  }
  setFailure() {}
  // Mirrors FirebaseSyncTarget.reset(): destructive cloud reset is disabled and THROWS if ever called.
  reset() {
    this.resetCalls += 1;
    throw new Error("FirebaseSyncTarget.reset() is disabled against the real Firebase cloud (no destructive reset).");
  }
}

describe("clearLocalCache", () => {
  it("CLOUD mode: does NOT call db.reset() and does not throw", () => {
    const target = new CloudLikeTarget();
    const store = createTestScanStore({ db: target, cloudBackend: true, loadBusinessData: async () => ({ products: [], aliases: [], sessions: [], counts: [] }) });
    // seed some local state
    store.setState({ scanFeed: [{ id: "x" } as never], products: [{ id: "p" } as never], aliases: [{ id: "a" } as never] });

    expect(() => store.getState().clearLocalCache()).not.toThrow();
    expect(target.resetCalls).toBe(0); // never attempted a destructive cloud reset
    // local state cleared; cloud data re-loads on reload, so products/aliases are emptied locally
    expect(store.getState().scanFeed).toEqual([]);
    expect(store.getState().products).toEqual([]);
    expect(store.getState().aliases).toEqual([]);
    expect(store.getState().pendingSyncQueue).toEqual([]);
  });

  it("MOCK mode: DOES reset the local MockDb and reloads seed", () => {
    const target = { apply: vi.fn(async () => ({ ok: true, alreadyApplied: false })), setFailure: vi.fn(), reset: vi.fn() } as unknown as SyncTarget & { reset: ReturnType<typeof vi.fn> };
    const store = createTestScanStore({ db: target, cloudBackend: false });
    store.getState().clearLocalCache();
    expect((target.reset as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1); // local mock reset is safe
    expect(store.getState().products.length).toBeGreaterThan(0); // reseeded
  });
});
