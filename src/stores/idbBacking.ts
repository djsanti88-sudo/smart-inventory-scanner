// src/stores/idbBacking.ts
// #27 IndexedDB migration: minimal promise KV over raw IndexedDB. No dependency on purpose
// (owner gate on new deps; the API surface we need is tiny). One DB, one object store, string
// values keyed by the same persist names localStorage used (sis-scan-v1 / sis-scan-<uid>).
// Every method rejects on IDB errors; callers (the fail-soft persist wrapper) catch and drop.

export type AsyncBacking = {
  getItem(name: string): Promise<string | null>;
  setItem(name: string, value: string): Promise<void>;
  removeItem(name: string): Promise<void>;
};

const DB_NAME = "sis-persist";
const STORE = "kv";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      const db = req.result;
      // If the connection dies (eviction, devtools clear), drop the cache so the next call reopens.
      db.onclose = () => { dbPromise = null; };
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(req.error ?? new Error("indexedDB open failed")); };
    req.onblocked = () => { /* another tab holds an old version; onsuccess still fires later */ };
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        let req: IDBRequest<T>;
        try {
          const t = db.transaction(STORE, mode);
          req = run(t.objectStore(STORE));
        } catch (err) {
          dbPromise = null; // connection may be stale; reopen next time
          reject(err);
          return;
        }
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("indexedDB request failed"));
      }),
  );
}

/** null when IndexedDB is unavailable (SSR, jsdom, lockdown browsers) - caller falls back to localStorage. */
export function createIdbBacking(): AsyncBacking | null {
  if (typeof indexedDB === "undefined") return null;
  return {
    getItem: (name) =>
      tx<unknown>("readonly", (s) => s.get(name) as IDBRequest<unknown>).then((v) =>
        typeof v === "string" ? v : null,
      ),
    setItem: (name, value) => tx("readwrite", (s) => s.put(value, name)).then(() => undefined),
    removeItem: (name) => tx("readwrite", (s) => s.delete(name)).then(() => undefined),
  };
}
