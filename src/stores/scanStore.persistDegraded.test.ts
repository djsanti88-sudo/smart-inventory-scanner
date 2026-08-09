import { describe, it, expect, vi, afterEach } from "vitest";

// Task 2 (persist-failure surface, 2026-08-09): scanPersistStorage.ts's async wrapper has always
// accepted an onPersistFailure(kind, err) callback, but nothing at the wrapper's construction site in
// scanStore.ts ever passed one - a real device-storage failure (quota, blocked, lockdown) degraded
// silently to a console.warn only. This proves the wiring: when the async/IndexedDB persist path is
// active and its onPersistFailure fires, the store's persistDegraded flag latches to the first kind
// reported, and stays latched across a second, different-kind failure.
//
// jsdom has no real IndexedDB, so `typeof indexedDB !== "undefined"` is false in every other test file
// in this suite - the async branch (and therefore onPersistFailure) never actually runs there. This
// file forces that branch by stubbing a truthy `globalThis.indexedDB` and mocking createIdbBacking +
// intercepting createAsyncCoalescedFailSoftPersistStorage's opts, then re-imports scanStore fresh
// (vi.resetModules) so its module-level `scanPersistBackingStorage` singleton is built under those
// conditions. This does not touch idbBacking.ts or scanPersistStorage.ts's own contract/implementation
// (their real createAsyncCoalescedFailSoftPersistStorage is still the one that runs) - it only taps the
// opts object scanStore.ts hands it.

describe("scanStore wires onPersistFailure to persistDegraded (Task 2)", () => {
  const realIndexedDB = (globalThis as { indexedDB?: unknown }).indexedDB;

  afterEach(() => {
    vi.doUnmock("@/stores/idbBacking");
    vi.doUnmock("@/stores/scanPersistStorage");
    vi.resetModules();
    if (realIndexedDB === undefined) {
      delete (globalThis as { indexedDB?: unknown }).indexedDB;
    } else {
      (globalThis as { indexedDB?: unknown }).indexedDB = realIndexedDB;
    }
  });

  it("latches persistDegraded to the FIRST onPersistFailure kind, and default is null with no failure", async () => {
    (globalThis as { indexedDB?: unknown }).indexedDB = {}; // only feature-detected via typeof check

    let capturedOnPersistFailure: ((kind: "write" | "migrate" | "demoted", err: unknown) => void) | undefined;

    vi.doMock("@/stores/idbBacking", () => ({
      createIdbBacking: () => ({
        getItem: vi.fn().mockResolvedValue(null),
        setItem: vi.fn().mockResolvedValue(undefined),
        removeItem: vi.fn().mockResolvedValue(undefined),
      }),
      // The B5 startup probe (scanPersistStorage.ts) calls this when no probeBacking override is
      // passed and global indexedDB exists - stub it usable so the async wrapper takes the real IDB
      // path this test is exercising, instead of the probe's own localStorage-demotion branch.
      probeIdbBacking: async () => true,
    }));
    vi.doMock("@/stores/scanPersistStorage", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/stores/scanPersistStorage")>();
      return {
        ...actual,
        createAsyncCoalescedFailSoftPersistStorage: (
          getBacking: Parameters<typeof actual.createAsyncCoalescedFailSoftPersistStorage>[0],
          opts: Parameters<typeof actual.createAsyncCoalescedFailSoftPersistStorage>[1],
        ) => {
          capturedOnPersistFailure = opts?.onPersistFailure;
          return actual.createAsyncCoalescedFailSoftPersistStorage(getBacking, opts);
        },
      };
    });

    vi.resetModules();
    const { useScanStore } = await import("@/stores/scanStore");

    // Default: no failure has fired yet.
    expect(useScanStore.getState().persistDegraded).toBeNull();
    expect(typeof capturedOnPersistFailure).toBe("function");

    capturedOnPersistFailure!("write", new Error("quota"));
    expect(useScanStore.getState().persistDegraded).toEqual({ kind: "write" });

    // Latch: a second, different-kind failure must not overwrite the first.
    capturedOnPersistFailure!("migrate", new Error("blocked"));
    expect(useScanStore.getState().persistDegraded).toEqual({ kind: "write" });
  });
});

// F4 (tier-3 review round 3, 2026-08-09): "demoted" alone is not a data-loss event (blocked
// IndexedDB + a working localStorage fallback is the design), and the UI now shows calm copy for it.
// The latch therefore must not let an early "demoted" mask a REAL write/migrate failure that follows -
// otherwise the calm copy would be shown while writes are genuinely being dropped.
describe("setPersistDegraded: a real failure upgrades a 'demoted' latch (F4)", () => {
  it("upgrades demoted -> write, then stays latched on the real kind", async () => {
    vi.resetModules();
    const { useScanStore } = await import("@/stores/scanStore");
    useScanStore.setState({ persistDegraded: null });

    useScanStore.getState().setPersistDegraded("demoted");
    expect(useScanStore.getState().persistDegraded).toEqual({ kind: "demoted" });

    useScanStore.getState().setPersistDegraded("write");
    expect(useScanStore.getState().persistDegraded).toEqual({ kind: "write" });

    // Still latched: a later, different REAL kind does not overwrite the first real one.
    useScanStore.getState().setPersistDegraded("migrate");
    expect(useScanStore.getState().persistDegraded).toEqual({ kind: "write" });

    // And a later "demoted" never downgrades a real failure back to the calm copy.
    useScanStore.getState().setPersistDegraded("demoted");
    expect(useScanStore.getState().persistDegraded).toEqual({ kind: "write" });
  });
});
