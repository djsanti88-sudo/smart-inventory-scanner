// Fail-soft IndexedDB persistence for the scan store. It keeps the optimistic count in memory first,
// migrates legacy localStorage safely, and coalesces durable snapshots outside the scan hot path.

import type { PersistStorage, StateStorage, StorageValue } from "zustand/middleware";

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

export type PersistenceClearResult = { cleared: boolean; authority: "durable" | "local" | "none" };

type AsyncDurableStorageOptions = {
  database: AsyncKeyValueDatabase | null;
  getLegacyStorage: () => Backing | null;
  onStatusChange?: (status: PersistenceStatus) => void;
};

type AsyncDurablePersistStorageOptions = AsyncDurableStorageOptions & {
  /** Test seam; production uses JSON.stringify at the deferred flush boundary. */
  serialize?: (snapshot: unknown) => string;
};

type DeferredStringStorage = StateStorage & {
  setDeferredItem: (name: string, serialize: () => string) => Promise<void>;
};

const PERSIST_POINTER_KEY = "__scanPersistPointer";
const TOMBSTONE_SUFFIX = "::scanbin-cleared-v1";
const PERSIST_FALLBACK_KEY = "__scanPersistFallback";

function encodeAuthoritativePersistFallback(payload: string): string {
  return JSON.stringify({ [PERSIST_FALLBACK_KEY]: 1, payload });
}

/** Returns only a complete atomic fallback envelope; raw legacy snapshots and pointers are ambiguous. */
export function getAuthoritativePersistFallback(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return parsed[PERSIST_FALLBACK_KEY] === 1 && typeof parsed.payload === "string"
      ? parsed.payload
      : null;
  } catch {
    return null;
  }
}

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
 * into IndexedDB without altering their bytes. After IndexedDB accepts the snapshot, the legacy copy
 * is removed. UID namespaces retain only their tiny ownership marker; full snapshots return to
 * localStorage only if durable persistence later fails.
 */
export function createAsyncDurableStorage(options: AsyncDurableStorageOptions): StateStorage {
  const reportDegraded = () => options.onStatusChange?.("degraded");
  const reportAvailable = () => options.onStatusChange?.("available");
  const queuedByKey = new Map<string, Promise<void>>();
  const pendingWrites = new Map<string, { serialize: () => string; token: number; resolvers: Array<() => void>; scheduled: boolean }>();
  const tombstones = new Set<string>();
  const legacySnapshotsCleaned = new Set<string>();
  const legacyMarkersEnsured = new Set<string>();
  // Each clear moves a key to a new generation. A write captures the generation it was created in,
  // so a pre-clear write that completes late cannot remove the newer clear tombstone.
  const generationByKey = new Map<string, number>();
  const enqueue = <T>(name: string, task: () => Promise<T>): Promise<T> => {
    const prior = queuedByKey.get(name);
    // Start the first operation immediately. This preserves the fail-soft guarantee at Zustand's
    // synchronous set boundary while later same-key operations remain strictly ordered.
    const next = prior ? prior.catch(() => undefined).then(task) : task();
    queuedByKey.set(name, next.then(() => undefined, () => undefined));
    return next;
  };
  // localStorage is a migration/fallback layer, not the durable authority. Its absence must not mark
  // a healthy IndexedDB session degraded; IndexedDB failures report their own status below.
  const reportLegacyFailure = () => {
    if (!options.database) reportDegraded();
  };

  const legacyGet = (name: string): string | null => {
    try {
      return options.getLegacyStorage()?.getItem(name) ?? null;
    } catch {
      reportLegacyFailure();
      return null;
    }
  };

  const legacySet = (name: string, value: string): boolean => {
    try {
      const storage = options.getLegacyStorage();
      if (!storage) return false;
      storage.setItem(name, value);
      return true;
    } catch {
      reportLegacyFailure();
      // Kept as a diagnostic supplement only. The store/UI status is the user-visible failure path.
      console.warn(`[scanStore] Could not persist '${name}' to local fallback storage.`);
      return false;
    }
  };

  const legacyRemove = (name: string): boolean => {
    try {
      const storage = options.getLegacyStorage();
      if (!storage) return false;
      storage.removeItem(name);
      return true;
    } catch {
      reportLegacyFailure();
      return false;
    }
  };
  const ensureLegacyMarkerOnce = (name: string): boolean => {
    if (legacyMarkersEnsured.has(name)) return true;
    const marker = JSON.stringify({ [PERSIST_POINTER_KEY]: 1 });
    try {
      const storage = options.getLegacyStorage();
      if (!storage) return false;
      if (!isDurablePointer(storage.getItem(name))) storage.setItem(name, marker);
    } catch {
      // This marker is supplemental ownership metadata, not the snapshot fallback. IndexedDB is
      // healthy, so quota pressure must not create a warning/error loop on every persisted update.
      return false;
    }
    legacyMarkersEnsured.add(name);
    return true;
  };
  const removeLegacySnapshotOnce = (name: string) => {
    if (legacySnapshotsCleaned.has(name)) return;
    const completed = isUidNamespace(name) ? ensureLegacyMarkerOnce(name) : legacyRemove(name);
    if (completed) legacySnapshotsCleaned.add(name);
  };
  const tombstoneKey = (name: string) => `${name}${TOMBSTONE_SUFFIX}`;
  const generationFor = (name: string) => generationByKey.get(name) ?? 0;
  const hasTombstone = async (name: string) => {
    if (tombstones.has(name) || legacyGet(tombstoneKey(name)) === "1") return true;
    if (!options.database) return false;
    try {
      return await options.database.get(tombstoneKey(name)) === "1";
    } catch {
      reportDegraded();
      return false;
    }
  };
  const writeTombstone = (name: string): boolean => { tombstones.add(name); return legacySet(tombstoneKey(name), "1"); };
  const persistTombstone = async (name: string): Promise<boolean> => {
    if (!options.database) {
      reportDegraded();
      return false;
    }
    try {
      await options.database.set(tombstoneKey(name), "1");
      reportAvailable(); return true;
    } catch {
      reportDegraded(); return false;
    }
  };
  const clearTombstone = async (name: string, token: number) => {
    if (generationFor(name) !== token) return;
    if (options.database) {
      try {
        await options.database.remove(tombstoneKey(name));
        reportAvailable();
      } catch {
        reportDegraded();
        return;
      }
    }
    if (generationFor(name) !== token) return;
    tombstones.delete(name);
    legacyRemove(tombstoneKey(name));
  };

  const performWrite = async (name: string, value: string, token: number) => {
    // When recovering from a prior fallback, update its payload first. A crash on either side of the
    // IndexedDB commit then leaves the same newest snapshot authoritative in at least one store.
    const hadFallback = getAuthoritativePersistFallback(legacyGet(name)) !== null;
    if (hadFallback && !legacySet(name, encodeAuthoritativePersistFallback(value))) {
      reportDegraded();
      return;
    }
    let durableWritten = false;
    if (options.database) {
      try { await options.database.set(name, value); durableWritten = true; reportAvailable(); } catch { reportDegraded(); }
    } else reportDegraded();
    // A successful write after an intentional clear supersedes its tombstone. An older in-flight
    // write is deliberately ignored: it may have reached IndexedDB, but the newer tombstone wins.
    if (durableWritten && generationFor(name) === token) await clearTombstone(name, token);
    if (generationFor(name) !== token) return;
    if (durableWritten) {
      removeLegacySnapshotOnce(name);
    } else {
      // Payload and authority metadata are one localStorage value, so an interrupted write cannot
      // leave newer bytes looking like an ambiguous legacy snapshot.
      legacySnapshotsCleaned.delete(name);
      legacyMarkersEnsured.delete(name);
      if (!hadFallback) legacySet(name, encodeAuthoritativePersistFallback(value));
    }
  };
  const flushWrite = (name: string) => {
    const pending = pendingWrites.get(name);
    if (!pending) return;
    pendingWrites.delete(name);
    let value: string;
    try {
      // JSON encoding belongs here, after coalescing chose the latest state, never on Zustand's
      // synchronous set() path. An encode error remains fail-soft just like a durable write failure.
      value = pending.serialize();
    } catch {
      reportDegraded();
      pending.resolvers.forEach((resolve) => resolve());
      return;
    }
    void enqueue(name, () => performWrite(name, value, pending.token)).then(() => pending.resolvers.forEach((resolve) => resolve()));
  };
  if (typeof window !== "undefined") {
    const flushAll = () => [...pendingWrites.keys()].forEach(flushWrite);
    window.addEventListener("pagehide", flushAll);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushAll(); });
  }

  const scheduleWrite = (name: string, serialize: () => string) => new Promise<void>((resolve) => {
    const pending = pendingWrites.get(name) ?? { serialize, token: generationFor(name), resolvers: [], scheduled: false };
    pending.serialize = serialize;
    pending.resolvers.push(resolve);
    pendingWrites.set(name, pending);
    if (!pending.scheduled) { pending.scheduled = true; queueMicrotask(() => flushWrite(name)); }
  });

  return {
    getItem: (name) => {
      flushWrite(name);
      return enqueue(name, async () => {
      if (await hasTombstone(name)) {
        if (options.database) { try { await options.database.remove(name); } catch { reportDegraded(); } }
        legacyRemove(name);
        return null;
      }
      const localValue = legacyGet(name);
      const authoritativeFallback = getAuthoritativePersistFallback(localValue);
      if (authoritativeFallback !== null) {
        if (options.database) {
          try {
            await options.database.set(name, authoritativeFallback);
            reportAvailable();
            removeLegacySnapshotOnce(name);
          } catch {
            reportDegraded();
          }
        } else {
          reportDegraded();
        }
        return authoritativeFallback;
      }
      if (options.database) {
        try {
          const durable = await options.database.get(name);
          if (durable !== null) {
            reportAvailable();
            removeLegacySnapshotOnce(name);
            return durable;
          }
          const legacy = localValue;
          if (legacy !== null && !isDurablePointer(legacy)) {
            await options.database.set(name, legacy);
            reportAvailable();
            removeLegacySnapshotOnce(name);
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
      const legacy = localValue;
      return isDurablePointer(legacy) ? null : legacy;
      });
    },
    setItem: (name, value) => scheduleWrite(name, () => value),
    setDeferredItem: scheduleWrite,
    removeItem: (name) => {
      const pending = pendingWrites.get(name);
      if (pending) { pendingWrites.delete(name); pending.resolvers.forEach((resolve) => resolve()); }
      generationByKey.set(name, generationFor(name) + 1);
      legacyMarkersEnsured.delete(name);
      legacySnapshotsCleaned.delete(name);
      const localTombstone = writeTombstone(name);
      return enqueue(name, async () => {
      const durableTombstone = await persistTombstone(name);
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
      return {
        cleared: durableTombstone || localTombstone,
        authority: durableTombstone ? "durable" : localTombstone ? "local" : "none",
      } satisfies PersistenceClearResult;
      });
    },
  } as DeferredStringStorage;
}

/**
 * Zustand's typed persistence boundary. It intentionally receives the object snapshot rather than a
 * pre-stringified value, so a scan burst selects its latest snapshot before JSON encoding happens.
 */
export function createAsyncDurablePersistStorage<S>(options: AsyncDurablePersistStorageOptions): PersistStorage<S> {
  const { serialize = JSON.stringify, ...durableOptions } = options;
  const storage = createAsyncDurableStorage(durableOptions) as DeferredStringStorage;
  return {
    getItem: async (name) => {
      const raw = await storage.getItem(name);
      return raw === null ? null : JSON.parse(raw) as StorageValue<S>;
    },
    setItem: (name, snapshot) => storage.setDeferredItem(name, () => serialize(snapshot)),
    removeItem: (name) => storage.removeItem(name),
  };
}

/** Exact durable namespace probe result for a shared-browser adoption decision. */
export type PersistedStatePresence = "found" | "absent" | "unavailable";

/**
 * Probe IndexedDB directly rather than through the fail-soft read adapter. The adapter rightly falls
 * back to localStorage for normal hydration, but a missing fallback must never make an inaccessible
 * durable UID namespace look absent and enable cross-account legacy adoption.
 */
export async function getPersistedStatePresence(name: string): Promise<PersistedStatePresence> {
  const database = createNativeIndexedDbDatabase();
  if (!database) return "unavailable";
  try {
    if (await database.get(`${name}${TOMBSTONE_SUFFIX}`) === "1") return "absent";
    return await database.get(name) === null ? "absent" : "found";
  } catch {
    return "unavailable";
  }
}

// Exported as a narrow test seam for the native transaction lifecycle; application callers use the
// browser-facing storage factory below.
export function createNativeIndexedDbDatabase(): AsyncKeyValueDatabase | null {
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
    // Do not leave a rejected promise created solely by `finally` unobserved. The caller owns the
    // original openPromise and receives its failure through the normal fail-soft adapter path.
    void openPromise.then(() => { opening = null; }, () => { opening = null; });
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
