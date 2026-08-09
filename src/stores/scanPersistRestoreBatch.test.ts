import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { createCoalescedFailSoftPersistStorage } from "@/stores/scanPersistStorage";

// Defect #37 layer 3 (fresh-device restore freeze, live-reproduced 2026-08-06): a 4,500-scanEvent /
// 4,499-inventoryCount / ~1,800-product business restoring onto a fresh device froze the renderer in
// ~30s+ waves EVEN on /history (which mounts only 9 session rows) - the earlier per-row lookup fix
// (LiveScanFeed/FinalCountTable Map+memo) did not close it, so the cost is upstream of rendering.
//
// Root cause: zustand's persist middleware calls `storage.setItem` SYNCHRONOUSLY from every single
// `set()`/`api.setState()` call (node_modules/zustand/esm/middleware.mjs - `api.setState` and the
// wrapped `set` both call a local `setItem()` that runs `options.partialize({ ...get() })` then
// `storage.setItem(name, {state, version})`), not only calls the app intends to persist. When `storage`
// is `createJSONStorage(() => coalescedWrapper)`, `createJSONStorage`'s own `setItem` runs
// `JSON.stringify(value)` BEFORE handing the string to the byte-write coalescing wrapper - so the
// coalescing only bounded REAL DISK WRITES, never the JSON.stringify CPU cost. The restore chain fires
// several back-to-back set() calls (persist.rehydrate -> setHasHydrated -> setBusinessContext's
// synchronous branch -> its async loader's merge), each re-stringifying the full ~5MB state, which
// blocks the main thread long enough (repeatedly) to starve the Firestore SDK's webchannel keepalive -
// it reconnects, re-delivers, and re-triggers a merge + another stringify: the observed ~30s "waves".
//
// This test pins the algorithmic shape at the persist-storage seam (not wall-clock): a burst of set()
// calls with a restore-sized payload must cost AT MOST ONE JSON.stringify + ONE backing write per
// coalesced tick, never one per set() call.

interface FakeRestoreState {
  bigPayload: unknown[];
  bump: () => void;
}

/** Synthetic stand-in for a restore-sized scanFeed slice (shape/size only - not the real ScanEvent type). */
function makeBigPayload(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `scan-${i}`,
    cleanCode: `0${i}`.padStart(12, "0"),
    rawCode: `raw-${i}`,
    matchedProductId: `p-${i % 50}`,
    createdAt: new Date(i).toISOString(),
    notes: "synthetic scan event payload for restore-batch perf test".repeat(3),
  }));
}

function makeBacking() {
  const map = new Map<string, string>();
  return {
    getItem: vi.fn((name: string) => (map.has(name) ? map.get(name)! : null)),
    setItem: vi.fn((name: string, value: string) => {
      map.set(name, value);
    }),
    removeItem: vi.fn((name: string) => {
      map.delete(name);
    }),
  };
}

// The OLD composition this file documents as the bug was `createJSONStorage(() => byteCoalescer)`,
// where `byteCoalescer` was `createCoalescedFailSoftStorage` - a StateStorage that coalesced only the
// already-serialized BYTES. That export was deleted in review round 2 (zero production callers; the
// store uses the PersistStorage variants). Its shape is reproduced inline here so this test keeps
// documenting the real historical composition and its exact costs.
function makeByteCoalescedStorage(backing: ReturnType<typeof makeBacking>) {
  let pendingName: string | null = null;
  let pendingValue = "";
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    if (pendingName === null) return;
    const [name, value] = [pendingName, pendingValue];
    pendingName = null;
    pendingValue = "";
    backing.setItem(name, value);
  };
  return {
    getItem: (name: string) => backing.getItem(name),
    removeItem: (name: string) => backing.removeItem(name),
    setItem: (name: string, value: string) => {
      pendingName = name;
      pendingValue = value;
      if (scheduled) return;
      scheduled = true;
      setTimeout(flush, 0);
    },
  };
}

// Fires the exact shape of the restore chain: N back-to-back set() calls with NO await/timer between
// them (persist.rehydrate, setHasHydrated, setBusinessContext's sync branch, and its async loader's
// single merge all land inside the same microtask/tick in the real restore path).
function fireRestoreChain(bump: () => void, calls: number) {
  for (let i = 0; i < calls; i++) bump();
}

describe("restore-batch persist serialization (defect #37 layer 3)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("documents the bug: createJSONStorage + byte-only coalescing stringifies the FULL restore payload once PER set() call (O(restore-chain length), unbounded)", () => {
    const backing = makeBacking();
    const store = create<FakeRestoreState>()(
      persist(
        (set) => ({
          bigPayload: makeBigPayload(1000),
          bump: () => set((s) => ({ bigPayload: [...s.bigPayload] })),
        }),
        {
          name: "restore-batch-old",
          storage: createJSONStorage(() => makeByteCoalescedStorage(backing)),
        },
      ),
    );
    const stringifySpy = vi.spyOn(JSON, "stringify");
    fireRestoreChain(store.getState().bump, 4);
    // Every one of the 4 restore-chain set() calls already re-stringified the full 1,000-row payload
    // synchronously, before the coalescing wrapper (or any timer) ever runs.
    expect(stringifySpy).toHaveBeenCalledTimes(4);
    // The backing write itself IS coalesced to one (proving the byte-write layer alone was never the
    // gap - the uncoalesced cost is the stringify, which this composition cannot defer).
    vi.runAllTimers();
    expect(backing.setItem).toHaveBeenCalledTimes(1);
  });

  it("FIX: createCoalescedFailSoftPersistStorage defers stringify into the SAME coalesced flush - bounded to ONE stringify + ONE write per tick regardless of restore-chain length", () => {
    const backing = makeBacking();
    const store = create<FakeRestoreState>()(
      persist(
        (set) => ({
          bigPayload: makeBigPayload(1000),
          bump: () => set((s) => ({ bigPayload: [...s.bigPayload] })),
        }),
        {
          name: "restore-batch-new",
          storage: createCoalescedFailSoftPersistStorage(() => backing),
        },
      ),
    );
    const stringifySpy = vi.spyOn(JSON, "stringify");
    fireRestoreChain(store.getState().bump, 4);
    // Bounded: no stringify has run yet - it is deferred to the coalesced flush, not one per set().
    expect(stringifySpy).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(stringifySpy).toHaveBeenCalledTimes(1);
    expect(backing.setItem).toHaveBeenCalledTimes(1);

    // A second restore-chain burst after the first flush produces exactly one more of each (not
    // unbounded growth across ticks).
    stringifySpy.mockClear();
    backing.setItem.mockClear();
    fireRestoreChain(store.getState().bump, 6);
    vi.runAllTimers();
    expect(stringifySpy).toHaveBeenCalledTimes(1);
    expect(backing.setItem).toHaveBeenCalledTimes(1);
  });

  it("getItem/removeItem round-trip through the new PersistStorage (parses the raw StorageValue, no double-encoding)", () => {
    const backing = makeBacking();
    const storage = createCoalescedFailSoftPersistStorage<FakeRestoreState>(() => backing);
    expect(storage.getItem("missing-key")).toBeNull();

    storage.setItem("k", { state: { bigPayload: [{ id: "a" }] } as unknown as FakeRestoreState, version: 14 });
    storage.flush();
    expect(backing.setItem).toHaveBeenCalledTimes(1);

    const read = storage.getItem("k") as { state: { bigPayload: unknown[] }; version: number } | null;
    expect(read?.version).toBe(14);
    expect(read?.state.bigPayload).toEqual([{ id: "a" }]);

    storage.removeItem("k");
    expect(backing.removeItem).toHaveBeenCalledWith("k");
    expect(storage.getItem("k")).toBeNull();
  });

  it("fails soft on a stringify error (never throws out of set())", () => {
    const backing = makeBacking();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const storage = createCoalescedFailSoftPersistStorage<FakeRestoreState>(() => backing);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    storage.setItem("k", { state: circular as unknown as FakeRestoreState, version: 14 });
    expect(() => storage.flush()).not.toThrow();
    expect(warn).toHaveBeenCalled();
    expect(backing.setItem).not.toHaveBeenCalled();
  });
});
