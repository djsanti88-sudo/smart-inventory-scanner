// QA finding #16 (critical) - CONTAINED MITIGATION for the /scan-page brick.
//
// scanStore.ts previously persisted through a plain createJSONStorage(() => localStorage). Two problems
// compounded into a hard brick as a scan session grew:
//   1. NO quota guard. Near the ~5MB localStorage quota, setItem throws QuotaExceededError SYNCHRONOUSLY
//      out of zustand's set() - and set() is called inside processScan - so the scan threw, and every
//      subsequent scan re-threw (a fresh tab stayed broken until localStorage was cleared).
//   2. WRITE AMPLIFICATION. Each processScan fires ~6 set() calls, each serializing the whole state and
//      writing it, so bytes written per scan grew linearly with session size.
//
// This wrapper is the fix seam (pure + unit-testable, no store/Firebase imports):
//   (a) FAIL-SOFT: setItem never throws; a quota/unavailable error is logged (console.warn) and dropped,
//       mirroring reconcileStore.ts. A persist failure must NEVER propagate out of processScan and must
//       NEVER roll back the optimistic in-memory scan (TOP-LEVEL LAW).
//   (b) COALESCE: the ~6 writes per scan are collapsed to at most ONE real backing write per tick - we
//       keep only the LATEST serialized value and schedule a single flush (cancel + reschedule on each
//       new write).
//   (c) FLUSH ON HIDE: the pending coalesced write is flushed SYNCHRONOUSLY on pagehide and on
//       visibilitychange(hidden), so a scan-then-close never loses the last write (data loss = LAW break).
//
// NOTE: this is the contained mitigation only. The unbounded-growth root cause (serializing the entire
// scan state to a single localStorage key on every write) still argues for the IndexedDB migration - that
// remains the recommended architectural follow-up and is intentionally OUT OF SCOPE here.
//
// Defect #37 layer 3 (fresh-device restore freeze, 2026-08-06): the wrapper above only coalesces the
// BACKING localStorage.setItem call. When it is composed under zustand's `createJSONStorage`, that
// helper's own `setItem(name, value)` still calls `JSON.stringify(value)` SYNCHRONOUSLY on every single
// `set()` - BEFORE handing the string to this wrapper - because zustand's persist middleware calls
// `storage.setItem` unconditionally from its overridden `api.setState` on every state change
// (node_modules/zustand/esm/middleware.mjs: `setItem = () => storage.setItem(name, {state, version})`,
// invoked from every `set(...)`/`api.setState(...)` call, not just ones the app intends to persist).
// So the coalescing above only reduces REAL DISK WRITES, not JSON.stringify CALLS - and at restore-time
// state size (~1,800 products + ~4,500 scanFeed rows + ~4,499 finalCounts, ~5MB), a handful of back-to-
// back set() calls in the restore chain (persist.rehydrate -> setHasHydrated -> setBusinessContext's
// synchronous branch -> its async loader's merge) each re-stringify the FULL state, blocking the main
// thread long enough (repeatedly) to starve the Firestore SDK's webchannel keepalive - which reconnects,
// re-delivers, and re-triggers a merge + another stringify, observed live as ~30s freeze "waves".
// `createCoalescedFailSoftPersistStorage` fixes this at the actual expensive step: it implements
// zustand's `PersistStorage<S>` directly (bypassing `createJSONStorage`) so `setItem` receives the RAW
// state object and defers `JSON.stringify` itself into the SAME coalesced flush as the backing write -
// collapsing N back-to-back set() calls in one tick to at most ONE stringify + ONE backing write, exactly
// like the byte-write coalescing above already does for the string case.

import type { PersistStorage, StateStorage, StorageValue } from "zustand/middleware";

/** The wrapper adds a synchronous force-flush so tests are deterministic and hide-events can drain. */
export interface CoalescedFailSoftStorage extends StateStorage {
  flush: () => void;
}

// Backing storage may or may not be present (SSR / disabled). Kept minimal on purpose.
type Backing = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * Wrap a backing storage (default: window.localStorage) with coalesced, fail-soft writes.
 * `getBackingStorage` is a thunk so we resolve localStorage lazily (matches createJSONStorage usage) and
 * so a test can inject a fake backing store.
 */
export function createCoalescedFailSoftStorage(
  getBackingStorage: () => Backing,
): CoalescedFailSoftStorage {
  // The single pending write. `hasPending` distinguishes "no write scheduled" from "write of empty string".
  let pendingName: string | null = null;
  let pendingValue = "";
  let hasPending = false;
  let scheduled = false;

  const doWrite = (name: string, value: string) => {
    try {
      getBackingStorage().setItem(name, value);
    } catch (err) {
      // Fail soft: quota exceeded, storage disabled, or private-mode restriction. Never throw - a persist
      // failure must not brick scanning; the in-memory session keeps working. (Mirrors reconcileStore.ts.)
      console.warn(
        `[scanStore] Could not persist '${name}' (storage quota or unavailable); this write was dropped. ` +
          `Scanning continues in memory; consider clearing local cache. (finding #16 fail-soft)`,
        err,
      );
    }
  };

  const flush = () => {
    scheduled = false;
    if (!hasPending || pendingName === null) return;
    const name = pendingName;
    const value = pendingValue;
    hasPending = false;
    pendingName = null;
    pendingValue = "";
    doWrite(name, value);
  };

  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    // A short timer coalesces the burst of writes in one processScan tick. rAF/microtask would also work;
    // a 0ms timer is deterministic under fake timers and available in every environment (jsdom + browser).
    if (typeof setTimeout === "function") {
      setTimeout(flush, 0);
    } else {
      // Extremely defensive fallback: no scheduler -> flush immediately so a write is never lost.
      flush();
    }
  };

  // Flush synchronously when the page is being hidden/unloaded, or the last coalesced write is lost.
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    const flushNow = () => flush();
    window.addEventListener("pagehide", flushNow);
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") flush();
      });
    }
  }

  return {
    getItem: (name: string) => getBackingStorage().getItem(name),
    removeItem: (name: string) => {
      // A removal must be authoritative and immediate: drop any queued write for this key first so a
      // stale coalesced value can't resurrect it, then remove (fail-soft).
      if (pendingName === name) {
        hasPending = false;
        pendingName = null;
        pendingValue = "";
      }
      try {
        getBackingStorage().removeItem(name);
      } catch (err) {
        console.warn(`[scanStore] Could not remove '${name}' from storage (unavailable).`, err);
      }
    },
    setItem: (name: string, value: string) => {
      // Coalesce: remember only the latest value; a single scheduled flush writes it once.
      pendingName = name;
      pendingValue = value;
      hasPending = true;
      schedule();
    },
    flush,
  };
}

/** Same coalesce/fail-soft/flush-on-hide contract as `CoalescedFailSoftStorage`, but for a zustand
 *  `PersistStorage<S>` used directly (no `createJSONStorage` wrapper) so `JSON.stringify` itself is
 *  deferred into the coalesced flush - see the defect #37 layer-3 note above. */
export interface CoalescedFailSoftPersistStorage<S> extends PersistStorage<S> {
  flush: () => void;
}

/**
 * Wrap a backing storage (default: window.localStorage) as a zustand `PersistStorage<S>` whose
 * `setItem` defers BOTH serialization and the disk write to a single coalesced flush per tick, instead
 * of stringifying the full state synchronously on every `set()` call (zustand's persist middleware calls
 * `storage.setItem` from every state change, not only ones the app intends to persist - see file header).
 */
export function createCoalescedFailSoftPersistStorage<S>(
  getBackingStorage: () => Backing,
): CoalescedFailSoftPersistStorage<S> {
  let pendingName: string | null = null;
  let pendingValue: StorageValue<S> | null = null;
  let hasPending = false;
  let scheduled = false;

  const doWrite = (name: string, value: StorageValue<S>) => {
    let serialized: string;
    try {
      // The expensive step this wrapper exists to bound: one stringify per coalesced flush, not one
      // per set() call.
      serialized = JSON.stringify(value);
    } catch (err) {
      console.warn(
        `[scanStore] Could not serialize '${name}' for persistence; this write was dropped. ` +
          `Scanning continues in memory. (finding #16 / defect #37 fail-soft)`,
        err,
      );
      return;
    }
    try {
      getBackingStorage().setItem(name, serialized);
    } catch (err) {
      // Fail soft: quota exceeded, storage disabled, or private-mode restriction. Never throw - a persist
      // failure must not brick scanning; the in-memory session keeps working. (Mirrors reconcileStore.ts.)
      console.warn(
        `[scanStore] Could not persist '${name}' (storage quota or unavailable); this write was dropped. ` +
          `Scanning continues in memory; consider clearing local cache. (finding #16 fail-soft)`,
        err,
      );
    }
  };

  const flush = () => {
    scheduled = false;
    if (!hasPending || pendingName === null || pendingValue === null) return;
    const name = pendingName;
    const value = pendingValue;
    hasPending = false;
    pendingName = null;
    pendingValue = null;
    doWrite(name, value);
  };

  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    if (typeof setTimeout === "function") {
      setTimeout(flush, 0);
    } else {
      flush();
    }
  };

  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    const flushNow = () => flush();
    window.addEventListener("pagehide", flushNow);
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") flush();
      });
    }
  }

  return {
    getItem: (name: string) => {
      let raw: string | null;
      try {
        raw = getBackingStorage().getItem(name);
      } catch (err) {
        console.warn(`[scanStore] Could not read '${name}' from storage (unavailable).`, err);
        return null;
      }
      if (raw === null || raw === undefined) return null;
      try {
        return JSON.parse(raw) as StorageValue<S>;
      } catch (err) {
        console.warn(`[scanStore] Could not parse persisted '${name}'; treating as absent.`, err);
        return null;
      }
    },
    removeItem: (name: string) => {
      if (pendingName === name) {
        hasPending = false;
        pendingName = null;
        pendingValue = null;
      }
      try {
        getBackingStorage().removeItem(name);
      } catch (err) {
        console.warn(`[scanStore] Could not remove '${name}' from storage (unavailable).`, err);
      }
    },
    setItem: (name: string, value: StorageValue<S>) => {
      // Coalesce: remember only the latest RAW value; stringify happens once, at flush time.
      pendingName = name;
      pendingValue = value;
      hasPending = true;
      schedule();
    },
    flush,
  };
}
