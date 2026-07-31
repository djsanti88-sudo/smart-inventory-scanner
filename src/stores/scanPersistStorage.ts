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

import type { StateStorage } from "zustand/middleware";

/** The wrapper adds a synchronous force-flush so tests are deterministic and hide-events can drain. */
export interface CoalescedFailSoftStorage extends StateStorage {
  flush: () => void;
}

// Backing storage may or may not be present (SSR / disabled). Kept minimal on purpose.
type Backing = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Observable persistence health. Degraded means scans still work in memory, but durable writes failed. */
export type PersistenceStatus = "available" | "degraded";

/** Small async seam so migration behavior is testable without a third-party IndexedDB shim. */
export interface AsyncKeyValueDatabase {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string) => Promise<void>;
  remove: (key: string) => Promise<void>;
}

type AsyncDurableStorageOptions = {
  database: AsyncKeyValueDatabase | null;
  getLegacyStorage: () => Backing | null;
  onStatusChange?: (status: PersistenceStatus) => void;
};

const PERSIST_POINTER_KEY = "__scanPersistPointer";

function isDurablePointer(value: string | null): boolean {
  if (!value) return false;
  try {
    return (JSON.parse(value) as Record<string, unknown>)[PERSIST_POINTER_KEY] === 1;
  } catch {
    return false;
  }
}

function isUidNamespace(name: string): boolean {
  return name.startsWith("sis-scan-") && name !== "sis-scan-v1";
}

/**
 * Async, fail-soft bridge from Zustand to durable storage. Existing localStorage values are read once
 * into IndexedDB without altering their bytes. Once a uid namespace is durable, a tiny local marker
 * preserves the existing shared-browser adoption gate without duplicating the growing scan blob.
 */
export function createAsyncDurableStorage(options: AsyncDurableStorageOptions): StateStorage {
  const reportDegraded = () => options.onStatusChange?.("degraded");
  const reportAvailable = () => options.onStatusChange?.("available");
  const queuedByKey = new Map<string, Promise<void>>();
  const enqueue = <T>(name: string, task: () => Promise<T>): Promise<T> => {
    const prior = queuedByKey.get(name);
    // Start the first operation immediately. This preserves the fail-soft guarantee at Zustand's
    // synchronous set boundary while later same-key operations remain strictly ordered.
    const next = prior ? prior.catch(() => undefined).then(task) : task();
    queuedByKey.set(name, next.then(() => undefined, () => undefined));
    return next;
  };

  const legacyGet = (name: string): string | null => {
    try {
      return options.getLegacyStorage()?.getItem(name) ?? null;
    } catch {
      reportDegraded();
      return null;
    }
  };

  const legacySet = (name: string, value: string) => {
    try {
      options.getLegacyStorage()?.setItem(name, value);
    } catch {
      reportDegraded();
      // Kept as a diagnostic supplement only. The store/UI status is the user-visible failure path.
      console.warn(`[scanStore] Could not persist '${name}' to local fallback storage.`);
    }
  };

  const legacyRemove = (name: string) => {
    try {
      options.getLegacyStorage()?.removeItem(name);
    } catch {
      reportDegraded();
    }
  };

  return {
    getItem: (name) => enqueue(name, async () => {
      if (options.database) {
        try {
          const durable = await options.database.get(name);
          if (durable !== null) {
            reportAvailable();
            return durable;
          }
          const legacy = legacyGet(name);
          if (legacy !== null && !isDurablePointer(legacy)) {
            await options.database.set(name, legacy);
            reportAvailable();
            return legacy;
          }
          reportAvailable();
          return null;
        } catch {
          reportDegraded();
        }
      } else {
        reportDegraded();
      }
      const legacy = legacyGet(name);
      return isDurablePointer(legacy) ? null : legacy;
    }),
    setItem: (name, value) => enqueue(name, async () => {
      let durableWritten = false;
      if (options.database) {
        try {
          await options.database.set(name, value);
          durableWritten = true;
          reportAvailable();
        } catch {
          reportDegraded();
        }
      } else {
        reportDegraded();
      }

      // The anonymous legacy namespace remains a real handoff blob until the owner explicitly adopts
      // it. UID namespaces use a marker after durable success, so the existing gate recognizes prior
      // ownership without reintroducing localStorage's unbounded quota pressure.
      if (!durableWritten || name === "sis-scan-v1") {
        legacySet(name, value);
      } else if (isUidNamespace(name)) {
        legacySet(name, JSON.stringify({ [PERSIST_POINTER_KEY]: 1 }));
      }
    }),
    removeItem: (name) => enqueue(name, async () => {
      if (options.database) {
        try {
          await options.database.remove(name);
          reportAvailable();
        } catch {
          reportDegraded();
        }
      } else {
        reportDegraded();
      }
      legacyRemove(name);
    }),
  };
}

function createNativeIndexedDbDatabase(): AsyncKeyValueDatabase | null {
  if (typeof window === "undefined") return null;
  let indexedDb: IDBFactory;
  try {
    if (!window.indexedDB) return null;
    indexedDb = window.indexedDB;
  } catch {
    return null;
  }
  const open = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
    const request = indexedDb.open("scanbin-persist-v1", 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("scan-state")) request.result.createObjectStore("scan-state");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });
  const run = <T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
    open().then((db) => new Promise<T>((resolve, reject) => {
      const transaction = db.transaction("scan-state", mode);
      const request = action(transaction.objectStore("scan-state"));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
      transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    }));
  return {
    get: async (key) => {
      const value = await run("readonly", (store) => store.get(key));
      return typeof value === "string" ? value : null;
    },
    set: async (key, value) => { await run("readwrite", (store) => store.put(value, key)); },
    remove: async (key) => { await run("readwrite", (store) => store.delete(key)); },
  };
}

/** Browser-facing factory. SSR, tests, and private mode fall back to localStorage without throwing. */
export function createIndexedDbScanPersistStorage(onStatusChange?: (status: PersistenceStatus) => void): StateStorage {
  return createAsyncDurableStorage({
    database: createNativeIndexedDbDatabase(),
    getLegacyStorage: () => {
      if (typeof window === "undefined") return null;
      try {
        return window.localStorage;
      } catch {
        return null;
      }
    },
    onStatusChange,
  });
}

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
