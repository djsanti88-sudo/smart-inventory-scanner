// Fail-soft IndexedDB persistence for the scan store. It keeps the optimistic count in memory first,
// migrates legacy localStorage safely, and coalesces durable snapshots outside the scan hot path.

import type { StateStorage } from "zustand/middleware";

// Backing storage may or may not be present (SSR / disabled). Kept minimal on purpose.
type Backing = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Observable persistence health. Degraded means scans still work in memory, but durable writes failed. */
export type PersistenceStatus = "available" | "degraded";
let browserPersistenceStatus: PersistenceStatus = "available";
const persistenceListeners = new Set<() => void>();
export function getBrowserPersistenceStatus(): PersistenceStatus { return browserPersistenceStatus; }
export function subscribeBrowserPersistenceStatus(listener: () => void): () => void { persistenceListeners.add(listener); return () => persistenceListeners.delete(listener); }
export function setBrowserPersistenceStatus(status: PersistenceStatus): void {
  if (browserPersistenceStatus === status) return;
  browserPersistenceStatus = status;
  persistenceListeners.forEach((listener) => listener());
}

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
const TOMBSTONE_SUFFIX = "::scanbin-cleared-v1";

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
  const pendingWrites = new Map<string, { value: string; resolvers: Array<() => void>; scheduled: boolean }>();
  const tombstones = new Set<string>();
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
  const tombstoneKey = (name: string) => `${name}${TOMBSTONE_SUFFIX}`;
  const hasTombstone = (name: string) => tombstones.has(name) || legacyGet(tombstoneKey(name)) === "1";
  const writeTombstone = (name: string) => { tombstones.add(name); legacySet(tombstoneKey(name), "1"); };
  const clearTombstone = (name: string) => { tombstones.delete(name); legacyRemove(tombstoneKey(name)); };

  const performWrite = async (name: string, value: string) => {
    let durableWritten = false;
    if (options.database) {
      try { await options.database.set(name, value); durableWritten = true; reportAvailable(); } catch { reportDegraded(); }
    } else reportDegraded();
    if (durableWritten) clearTombstone(name);
    if (!durableWritten || name === "sis-scan-v1") legacySet(name, value);
    else if (isUidNamespace(name)) legacySet(name, JSON.stringify({ [PERSIST_POINTER_KEY]: 1 }));
  };
  const flushWrite = (name: string) => {
    const pending = pendingWrites.get(name);
    if (!pending) return;
    pendingWrites.delete(name);
    void enqueue(name, () => performWrite(name, pending.value)).then(() => pending.resolvers.forEach((resolve) => resolve()));
  };
  if (typeof window !== "undefined") {
    const flushAll = () => [...pendingWrites.keys()].forEach(flushWrite);
    window.addEventListener("pagehide", flushAll);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushAll(); });
  }

  return {
    getItem: (name) => {
      flushWrite(name);
      return enqueue(name, async () => {
      if (hasTombstone(name)) {
        if (options.database) { try { await options.database.remove(name); } catch { reportDegraded(); } }
        return null;
      }
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
      });
    },
    setItem: (name, value) => new Promise<void>((resolve) => {
      const pending = pendingWrites.get(name) ?? { value, resolvers: [], scheduled: false };
      pending.value = value;
      pending.resolvers.push(resolve);
      pendingWrites.set(name, pending);
      if (!pending.scheduled) { pending.scheduled = true; queueMicrotask(() => flushWrite(name)); }
    }),
    removeItem: (name) => {
      const pending = pendingWrites.get(name);
      if (pending) { pendingWrites.delete(name); pending.resolvers.forEach((resolve) => resolve()); }
      writeTombstone(name);
      return enqueue(name, async () => {
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
      });
    },
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
  let database: IDBDatabase | null = null;
  let opening: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    if (database) return Promise.resolve(database);
    if (opening) return opening;
    const openPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDb.open("scanbin-persist-v1", 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("scan-state")) request.result.createObjectStore("scan-state");
    };
    request.onsuccess = () => {
      database = request.result;
      database.onversionchange = () => { database?.close(); database = null; };
      resolve(database);
    };
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    });
    opening = openPromise;
    void openPromise.finally(() => { opening = null; });
    return openPromise;
  };
  const run = <T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
    open().then((db) => new Promise<T>((resolve, reject) => {
      const transaction = db.transaction("scan-state", mode);
      const request = action(transaction.objectStore("scan-state"));
      let result: T;
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
      transaction.oncomplete = () => resolve(result);
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
    onStatusChange: onStatusChange ?? setBrowserPersistenceStatus,
  });
}
