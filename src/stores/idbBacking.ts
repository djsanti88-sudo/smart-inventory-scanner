// src/stores/idbBacking.ts
// #27 IndexedDB migration: minimal promise KV over raw IndexedDB. No dependency on purpose
// (owner gate on new deps; the API surface we need is tiny). One DB, one object store, string
// values keyed by the same persist names localStorage used (sis-scan-v1 / sis-scan-<uid>).
// Every method rejects on IDB errors; callers (the fail-soft persist wrapper) catch and drop.

export type AsyncBacking = {
  getItem(name: string): Promise<string | null>;
  setItem(name: string, value: string): Promise<void>;
  /** Write several keys in ONE readwrite transaction (defect F2). The persist wrapper writes a blob
   *  and its sibling `::stamp` key; as two sequential setItem() calls the stamp put is scheduled in a
   *  microtask after the blob request's onsuccess, which on a pagehide flush routinely never lands
   *  before the document unloads - leaving the blob carrying the PREVIOUS write's stamp and losing
   *  newest-wins next session. Optional on the TYPE only so a hand-rolled test double or a future
   *  alternative backing can omit it (callers fall back to sequential puts); the real IndexedDB
   *  backing below always provides it. */
  setItems?(entries: Array<[string, string]>): Promise<void>;
  /** Read several keys in ONE readonly transaction (defect P4), mirroring setItems. The newest-wins
   *  reader needs a blob and its sibling `::stamp` key as a CONSISTENT SNAPSHOT: read as two separate
   *  single-key transactions, a concurrent atomic write from another tab can land between them and
   *  pair the STALE blob A with the NEW stamp 3 - crowning a false winner and then destructively
   *  deleting the genuinely newest copy in the other store. Optional on the TYPE only so a hand-rolled
   *  test double or an alternative backing can omit it (callers fall back to sequential getItem calls,
   *  which are torn-read-prone by construction); the real IndexedDB backing below always provides it. */
  getItems?(names: string[]): Promise<Array<string | null>>;
  removeItem(name: string): Promise<void>;
};

const DB_NAME = "sis-persist";
const STORE = "kv";
const PROBE_KEY = "__sis_idb_probe__";

let dbPromise: Promise<IDBDatabase> | null = null;
// Defect #3: cache the resolved connection so tx() can start a transaction SYNCHRONOUSLY, in the
// current task, whenever the connection is already open - the common case once warmed up. Cleared
// whenever the connection is no longer trustworthy (close/versionchange/error/stale transaction) so
// the next call reopens through openDb() instead of handing out a dead handle.
let cachedDb: IDBDatabase | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  // Build the promise into a local first, THEN assign it to the module-level cache. This ordering
  // matters (defect #1a): if a synchronous throw inside the executor below tried to reset
  // `dbPromise = null` directly, that write would run BEFORE `new Promise(...)` has even returned,
  // and the outer `dbPromise = <promise>` assignment (which necessarily happens after construction)
  // would immediately clobber it back to the freshly-rejected promise - caching a forever-rejected
  // connection with no way to recover. Instead, reset happens via a `.catch()` on the already-
  // assigned local `promise`, guarded so a newer promise from a concurrent retry is never clobbered.
  const promise: Promise<IDBDatabase> = new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      // indexedDB.open() itself can throw SYNCHRONOUSLY (Safari private mode, some enterprise
      // lockdown policies) instead of delivering an onerror event.
      req = indexedDB.open(DB_NAME, 1);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      const db = req.result;
      cachedDb = db;
      // If the connection dies (eviction, devtools clear), drop the cache so the next call reopens.
      db.onclose = () => { dbPromise = null; cachedDb = null; };
      db.onversionchange = () => { db.close(); dbPromise = null; cachedDb = null; };
      resolve(db);
    };
    req.onerror = () => {
      cachedDb = null;
      reject(req.error ?? new Error("indexedDB open failed"));
    };
    req.onblocked = () => { /* another tab holds an old version; onsuccess still fires later */ };
  });
  dbPromise = promise;
  promise.catch(() => {
    cachedDb = null;
    // Never leave a forever-rejected promise cached: the next call must retry fresh (this is what
    // makes both the synchronous-throw path and the async onerror path recoverable).
    if (dbPromise === promise) dbPromise = null;
  });
  return promise;
}

/**
 * DURABILITY POINT (defect P1, tier-3 external review 2026-08-09). These used to settle on the
 * REQUEST's `onsuccess`, which in IndexedDB semantics fires while the transaction is still OPEN - the
 * write is visible to that transaction but NOT yet committed, and the transaction can still abort
 * afterwards (quota evaluated at commit time, storage eviction, a crash before the commit lands).
 * Callers here treat the resolved promise as DURABLE and delete the only other copy of the data on
 * the strength of it: the persist wrapper's legacy migration removes the localStorage source in its
 * `.then`, and adoption deletes the legacy blob after awaiting `setItem`. An abort after request
 * success therefore destroyed BOTH copies. So the promise now settles on the TRANSACTION:
 * `oncomplete` = committed = durable, `onabort`/`onerror` = rejected. The synchronous-start fast path
 * (the guarantee flush() on pagehide depends on) is unchanged - only the settlement point moved.
 */
function runTx<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let req: IDBRequest<T>;
    let t: IDBTransaction;
    try {
      t = db.transaction(STORE, mode);
      req = run(t.objectStore(STORE));
    } catch (err) {
      dbPromise = null; // connection may be stale; reopen next time
      cachedDb = null;
      reject(err);
      return;
    }
    let result: T | undefined;
    let settled = false;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(String(err ?? "indexedDB transaction failed")));
    };
    // The request result is only CAPTURED here; the promise settles at commit.
    req.onsuccess = () => {
      result = req.result;
    };
    req.onerror = () => fail(req.error ?? new Error("indexedDB request failed"));
    t.oncomplete = () => {
      if (settled) return;
      settled = true;
      resolve(result as T);
    };
    t.onabort = () => fail(t.error ?? new Error("indexedDB transaction aborted"));
    t.onerror = () => fail(t.error ?? new Error("indexedDB transaction failed"));
  });
}

/** Multi-request sibling of runTx: every request `run` issues belongs to the SAME transaction, so
 *  they commit together or not at all. Resolves with the requests' results, in order, once the
 *  transaction has COMMITTED (defect P1 - see runTx above); rejects on abort/error. */
function runTxMulti<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => Array<IDBRequest<T>>,
): Promise<Array<T | undefined>> {
  return new Promise<Array<T | undefined>>((resolve, reject) => {
    let requests: Array<IDBRequest<T>>;
    let t: IDBTransaction;
    try {
      t = db.transaction(STORE, mode);
      requests = run(t.objectStore(STORE));
    } catch (err) {
      dbPromise = null; // connection may be stale; reopen next time
      cachedDb = null;
      reject(err);
      return;
    }
    if (requests.length === 0) {
      resolve([]);
      return;
    }
    const results: Array<T | undefined> = new Array(requests.length);
    let settled = false;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(String(err ?? "indexedDB transaction failed")));
    };
    requests.forEach((req, i) => {
      req.onsuccess = () => {
        results[i] = req.result;
      };
      // First error wins; the transaction aborts behind it, and the already-settled promise stands.
      req.onerror = () => fail(req.error ?? new Error("indexedDB request failed"));
    });
    t.oncomplete = () => {
      if (settled) return;
      settled = true;
      resolve(results);
    };
    t.onabort = () => fail(t.error ?? new Error("indexedDB transaction aborted"));
    t.onerror = () => fail(t.error ?? new Error("indexedDB transaction failed"));
  });
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  // Defect #3 fast path: when the connection is already open (the common case once warmed up),
  // start the transaction SYNCHRONOUSLY, in the caller's current task, before any microtask
  // boundary. This is the real guarantee flush() on pagehide depends on (see the corrected comment
  // in scanPersistStorage.ts). Only fall back to the async open-then-transact path while (re)opening.
  if (cachedDb) return runTx(cachedDb, mode, run);
  return openDb().then((db) => runTx(db, mode, run));
}

/** Same synchronous-start fast path as tx(), for the multi-request transaction. */
function txMulti<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => Array<IDBRequest<T>>,
): Promise<Array<T | undefined>> {
  if (cachedDb) return runTxMulti(cachedDb, mode, run);
  return openDb().then((db) => runTxMulti(db, mode, run));
}

/** null when IndexedDB is unavailable (SSR, jsdom, lockdown browsers) - caller falls back to localStorage. */
export function createIdbBacking(): AsyncBacking | null {
  if (typeof indexedDB === "undefined") return null;
  return {
    getItem: (name) =>
      tx<unknown>("readonly", (s) => s.get(name) as IDBRequest<unknown>).then((v) =>
        typeof v === "string" ? v : null,
      ),
    getItems: (names) =>
      txMulti<unknown>("readonly", (s) => names.map((n) => s.get(n) as IDBRequest<unknown>)).then((vals) =>
        vals.map((v) => (typeof v === "string" ? v : null)),
      ),
    setItem: (name, value) => tx("readwrite", (s) => s.put(value, name)).then(() => undefined),
    setItems: (entries) =>
      txMulti("readwrite", (s) => entries.map(([name, value]) => s.put(value, name))).then(() => undefined),
    removeItem: (name) => tx("readwrite", (s) => s.delete(name)).then(() => undefined),
  };
}

/**
 * Defect #1b: backing SELECTION (IDB vs localStorage) used to be a pure feature-detect
 * (`typeof indexedDB !== "undefined"`), which is true even when IndexedDB exists but is BLOCKED
 * (Chrome block-site-data, enterprise policy, Safari lockdown) - every write then fails silently
 * forever with no fallback. This probe does a real round trip (open + put + get + delete) so a
 * caller can make an informed choice up front, or a runtime demotion latch can retry a known-bad
 * backing before committing to it. Never throws; resolves false on any failure, including when
 * IndexedDB is entirely absent.
 */
export async function probeIdbBacking(): Promise<boolean> {
  const backing = createIdbBacking();
  if (!backing) return false;
  try {
    // P9: the read-back VALUE is checked, not just "the call did not throw". A backing that accepts a
    // put and then hands back nothing (or something else) on read is broken in exactly the way this
    // probe exists to catch; discarding the round-trip result made the read leg pure ceremony. The
    // token is unique per probe so a stale value left by an earlier probe cannot pass for a fresh one.
    const token = `probe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await backing.setItem(PROBE_KEY, token);
    const readBack = await backing.getItem(PROBE_KEY);
    await backing.removeItem(PROBE_KEY);
    return readBack === token;
  } catch {
    return false;
  }
}
