// Tier-3 hardening: regression coverage for two #27 IndexedDB defects fixed in idbBacking.ts.
//   Defect #1a: a SYNCHRONOUS throw from indexedDB.open() must reject AND reset the module's
//     cached connection promise, so a later call can retry instead of being forever-rejected.
//   Defect #3: once the connection is open, tx() must start the IDBTransaction SYNCHRONOUSLY (in
//     the caller's current task, before any microtask boundary) - the real guarantee flush() on
//     pagehide depends on.
// A hand-rolled fake IndexedDB is used (no fake-indexeddb dependency in this repo). Each test
// re-imports the module fresh via vi.resetModules() so the module-level dbPromise/cachedDb state
// from one test never leaks into the next.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

type Handler = (() => void) | null;

class FakeIDBRequest<T = unknown> {
  result: T | undefined;
  error: unknown = null;
  onsuccess: Handler = null;
  onerror: Handler = null;
}

class FakeOpenRequest extends FakeIDBRequest<FakeDB> {
  onupgradeneeded: Handler = null;
  onblocked: Handler = null;
}

/**
 * P1 (tier-3 external review, 2026-08-09): this fake used to apply every write and fire `onsuccess`
 * with NO transaction lifecycle at all - there was no `oncomplete`, no `onabort`, and the data was
 * already durable by the time the request succeeded. That is mock theater: it made "resolve on
 * request success" and "resolve on commit" indistinguishable, so the premature-durability defect was
 * invisible to the suite. The fake now models the REAL two-phase lifecycle:
 *   - a request settles (onsuccess) while the transaction is still open,
 *   - writes are STAGED, not applied,
 *   - the transaction then either COMMITS (staged writes applied, `oncomplete`) or ABORTS
 *     (staged writes discarded, `onabort`) - the quota-at-commit / eviction case.
 */
class FakeTransaction {
  oncomplete: Handler = null;
  onabort: Handler = null;
  onerror: Handler = null;
  error: unknown = null;
  private pending = 0;
  private started = false;
  private done = false;
  private staged: Array<() => void> = [];

  constructor(readonly db: FakeDB) {
    // A real transaction auto-commits once its request queue drains.
    queueMicrotask(() => {
      this.started = true;
      this.maybeFinish();
    });
  }

  objectStore(_name: string) {
    return new FakeObjectStore(this);
  }

  request<T>(compute: () => T, apply?: () => void): FakeIDBRequest<T> {
    const req = new FakeIDBRequest<T>();
    this.pending += 1;
    queueMicrotask(() => {
      if (this.done) return;
      req.result = compute();
      if (apply) this.staged.push(apply);
      req.onsuccess?.(); // request success - the transaction is STILL OPEN and can still abort
      this.pending -= 1;
      queueMicrotask(() => this.maybeFinish());
    });
    return req;
  }

  private maybeFinish() {
    if (this.done || !this.started || this.pending > 0) return;
    this.done = true;
    if (this.db.abortAtCommit) {
      this.error = new Error("QuotaExceededError: transaction aborted at commit");
      this.onabort?.(); // staged writes are DISCARDED - nothing was ever durable
      return;
    }
    for (const apply of this.staged) apply();
    this.oncomplete?.();
  }
}

class FakeObjectStore {
  constructor(private t: FakeTransaction) {}
  get(key: string) {
    return this.t.request<string | undefined>(() =>
      this.t.db.readsReturnNothing ? undefined : this.t.db.data.get(key),
    );
  }
  put(value: string, key: string) {
    return this.t.request<undefined>(
      () => undefined,
      () => this.t.db.data.set(key, value),
    );
  }
  delete(key: string) {
    return this.t.request<undefined>(
      () => undefined,
      () => this.t.db.data.delete(key),
    );
  }
}

class FakeDB {
  data = new Map<string, string>();
  /** Every transaction aborts at commit time, AFTER its requests have already reported success. */
  abortAtCommit = false;
  /** Puts commit, but reads hand back nothing - the "accepts writes, loses them" broken backing. */
  readsReturnNothing = false;
  objectStoreNames = { contains: () => true };
  onclose: Handler = null;
  onversionchange: Handler = null;
  transaction(_store: string, _mode: string) {
    return new FakeTransaction(this);
  }
  createObjectStore() {
    /* no-op: objectStoreNames.contains() already reports true */
  }
  close() {
    /* no-op */
  }
}

function installFakeIndexedDB(opts: { failOpenSync?: boolean; failOpenAsync?: boolean } = {}) {
  const db = new FakeDB();
  const fake = {
    open(_name: string, _version: number) {
      if (opts.failOpenSync) {
        throw new Error("sync open failure (simulated Safari private-mode / lockdown policy)");
      }
      const req = new FakeOpenRequest();
      queueMicrotask(() => {
        if (opts.failOpenAsync) {
          req.error = new Error("async open failure");
          req.onerror?.();
          return;
        }
        req.result = db;
        req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
  vi.stubGlobal("indexedDB", fake);
  return db;
}

describe("idbBacking", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("defect #1a: synchronous open() throw must not permanently poison the connection", () => {
    it("rejects the in-flight call, then a later call on a working environment succeeds", async () => {
      installFakeIndexedDB({ failOpenSync: true });
      const { createIdbBacking } = await import("./idbBacking");
      const backing = createIdbBacking();
      expect(backing).not.toBeNull();

      await expect(backing!.setItem("k", "v")).rejects.toThrow(/sync open failure/);

      // Environment "recovers" (e.g. the enterprise policy lifts, or this call lands on a
      // different, working profile) - the SAME backing instance must be able to retry, proving the
      // failed open reset the module's cached promise instead of caching a forever-rejected one.
      installFakeIndexedDB({});
      await expect(backing!.setItem("k", "v")).resolves.toBeUndefined();
      await expect(backing!.getItem("k")).resolves.toBe("v");
    });

    it("a repeated synchronous throw keeps rejecting (never resolves stale/garbage data)", async () => {
      installFakeIndexedDB({ failOpenSync: true });
      const { createIdbBacking } = await import("./idbBacking");
      const backing = createIdbBacking();
      await expect(backing!.setItem("k", "v")).rejects.toThrow();
      await expect(backing!.getItem("k")).rejects.toThrow();
    });
  });

  describe("an async onerror from open() also allows a later retry to succeed", () => {
    it("rejects then recovers", async () => {
      installFakeIndexedDB({ failOpenAsync: true });
      const { createIdbBacking } = await import("./idbBacking");
      const backing = createIdbBacking();
      await expect(backing!.setItem("k", "v")).rejects.toThrow();
      installFakeIndexedDB({});
      await expect(backing!.setItem("k", "v")).resolves.toBeUndefined();
    });
  });

  describe("defect #3: transaction creation is synchronous once the connection is open", () => {
    it("creates the IDBTransaction before any microtask boundary on a warm connection", async () => {
      const db = installFakeIndexedDB({});
      const { createIdbBacking } = await import("./idbBacking");
      const backing = createIdbBacking();

      // Warm the connection first (first call is necessarily async while opening).
      await backing!.setItem("warm", "1");

      let transactionCreatedSync = false;
      const originalTransaction = db.transaction.bind(db);
      db.transaction = (...args: Parameters<FakeDB["transaction"]>) => {
        transactionCreatedSync = true;
        return originalTransaction(...args);
      };

      // Call setItem and assert the transaction already exists in the SAME synchronous task,
      // before awaiting anything - this is the guarantee flush() on pagehide relies on.
      const pending = backing!.setItem("k2", "v2");
      expect(transactionCreatedSync).toBe(true);
      await pending;
    });

    it("falls back to the async open-then-transact path on a cold connection (no throw)", async () => {
      installFakeIndexedDB({});
      const { createIdbBacking } = await import("./idbBacking");
      const backing = createIdbBacking();
      // First call on a fresh module: connection is not yet open, so this necessarily awaits.
      await expect(backing!.setItem("cold", "1")).resolves.toBeUndefined();
      await expect(backing!.getItem("cold")).resolves.toBe("1");
    });
  });

  // F2 (tier-3 review round 3): the persist wrapper must be able to write a blob and its sibling write
  // stamp in ONE transaction. Two sequential setItem() calls schedule the second put in a microtask
  // after the first request's onsuccess, which on a pagehide flush routinely never lands before the
  // document unloads - leaving the blob stamped with the PREVIOUS write's stamp.
  describe("setItems: multi-put in a single transaction", () => {
    it("writes every entry in ONE readwrite transaction", async () => {
      const db = installFakeIndexedDB({});
      const { createIdbBacking } = await import("./idbBacking");
      const backing = createIdbBacking();
      await backing!.setItem("warm", "1"); // warm the connection first

      let transactions = 0;
      const originalTransaction = db.transaction.bind(db);
      db.transaction = (...args: Parameters<FakeDB["transaction"]>) => {
        transactions += 1;
        return originalTransaction(...args);
      };

      await backing!.setItems!([["blob", "payload"], ["blob::stamp", "42"]]);

      expect(transactions).toBe(1);
      expect(await backing!.getItem("blob")).toBe("payload");
      expect(await backing!.getItem("blob::stamp")).toBe("42");
    });

    it("starts the transaction SYNCHRONOUSLY on a warm connection (the pagehide-flush guarantee)", async () => {
      const db = installFakeIndexedDB({});
      const { createIdbBacking } = await import("./idbBacking");
      const backing = createIdbBacking();
      await backing!.setItem("warm", "1");

      let transactionCreatedSync = false;
      const originalTransaction = db.transaction.bind(db);
      db.transaction = (...args: Parameters<FakeDB["transaction"]>) => {
        transactionCreatedSync = true;
        return originalTransaction(...args);
      };

      const pending = backing!.setItems!([["b", "v"], ["b::stamp", "7"]]);
      expect(transactionCreatedSync).toBe(true);
      await pending;
    });

    it("rejects when the connection cannot be opened (fail-soft is the caller's job)", async () => {
      installFakeIndexedDB({ failOpenSync: true });
      const { createIdbBacking } = await import("./idbBacking");
      const backing = createIdbBacking();
      await expect(backing!.setItems!([["b", "v"], ["b::stamp", "7"]])).rejects.toThrow(/sync open failure/);
    });
  });

  // -----------------------------------------------------------------------------------------------
  // P1 (HIGH, premature durability). runTx/runTxMulti settled on the REQUEST's onsuccess, which in
  // IndexedDB fires while the transaction is still open. The transaction can still abort afterwards
  // (quota is evaluated at commit, eviction, crash), and callers DELETE the only other copy of the
  // data on the strength of the resolved promise - so an abort-after-request-success destroyed both
  // copies. The promise must settle at the commit: oncomplete = durable, onabort/onerror = rejected.
  // -----------------------------------------------------------------------------------------------
  describe("P1: promises settle on transaction COMMIT, not on request success", () => {
    it("setItem REJECTS when the transaction aborts after the put request already succeeded", async () => {
      const db = installFakeIndexedDB({});
      const { createIdbBacking } = await import("./idbBacking");
      const backing = createIdbBacking();
      await backing!.setItem("warm", "1"); // warm the connection

      db.abortAtCommit = true;
      await expect(backing!.setItem("k", "v")).rejects.toThrow(/aborted/i);
      expect(db.data.has("k")).toBe(false); // nothing was ever durable
    });

    it("setItems REJECTS when the transaction aborts after every put request succeeded", async () => {
      const db = installFakeIndexedDB({});
      const { createIdbBacking } = await import("./idbBacking");
      const backing = createIdbBacking();
      await backing!.setItem("warm", "1");

      db.abortAtCommit = true;
      await expect(backing!.setItems!([["blob", "payload"], ["blob::stamp", "42"]])).rejects.toThrow(/aborted/i);
      expect(db.data.has("blob")).toBe(false);
      expect(db.data.has("blob::stamp")).toBe(false);
    });

    it("removeItem REJECTS when the transaction aborts after the delete request succeeded", async () => {
      const db = installFakeIndexedDB({});
      const { createIdbBacking } = await import("./idbBacking");
      const backing = createIdbBacking();
      await backing!.setItem("keep", "1");

      db.abortAtCommit = true;
      await expect(backing!.removeItem("keep")).rejects.toThrow(/aborted/i);
      expect(db.data.get("keep")).toBe("1"); // the discarded delete never took effect
    });

    it("a committed write really is durable (the happy path still resolves)", async () => {
      const db = installFakeIndexedDB({});
      const { createIdbBacking } = await import("./idbBacking");
      const backing = createIdbBacking();
      await expect(backing!.setItem("k", "v")).resolves.toBeUndefined();
      expect(db.data.get("k")).toBe("v");
      await expect(backing!.getItem("k")).resolves.toBe("v");
    });

    // The defect's real-world consequence, end to end through the persist wrapper: the legacy
    // migration copy deletes the localStorage SOURCE once the backing write resolves. If that resolve
    // came from request success and the transaction then aborted, BOTH copies were gone.
    it("an abort-after-request-success does NOT delete the legacy localStorage copy", async () => {
      const db = installFakeIndexedDB({});
      const { createIdbBacking } = await import("./idbBacking");
      const { createAsyncCoalescedFailSoftPersistStorage } = await import("./scanPersistStorage");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const VALUE = JSON.stringify({ state: { scanFeed: [{ id: "ONLY-COPY" }] }, version: 7 });
      const legacyData = new Map<string, string>([["sis-scan-v1", VALUE]]);
      const legacy = {
        getItem: (n: string) => legacyData.get(n) ?? null,
        setItem: (n: string, v: string) => { legacyData.set(n, v); },
        removeItem: (n: string) => { legacyData.delete(n); },
      };

      const backing = createIdbBacking()!;
      const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing, {
        migrateFrom: legacy,
        probeBacking: async () => true, // deterministic: no fire-and-forget probe racing this test
      });

      await backing.setItem("warm", "1"); // warm the connection so the migration put starts synchronously
      db.abortAtCommit = true;

      await storage.getItem("sis-scan-v1"); // legacy hit -> background copy-then-clear starts
      // Let the copy's transaction reach its (aborting) commit and the .catch run.
      for (let i = 0; i < 20; i++) await Promise.resolve();

      expect(db.data.has("sis-scan-v1")).toBe(false); // the copy never committed...
      expect(legacyData.get("sis-scan-v1")).toBe(VALUE); // ...so the ONLY copy must still exist
      warn.mockRestore();
    });
  });

  // P4: the newest-wins reader needs blob + stamp from ONE consistent snapshot. Two single-key
  // transactions can be interleaved by another tab's atomic write and pair a stale blob with a new
  // stamp - crowning a false winner and deleting the genuinely newest copy in the other store.
  describe("P4: getItems reads every key in ONE readonly transaction", () => {
    it("returns the values in order from a single transaction", async () => {
      const db = installFakeIndexedDB({});
      const { createIdbBacking } = await import("./idbBacking");
      const backing = createIdbBacking();
      await backing!.setItems!([["blob", "payload"], ["blob::stamp", "42"]]);

      let transactions = 0;
      const originalTransaction = db.transaction.bind(db);
      db.transaction = (...args: Parameters<FakeDB["transaction"]>) => {
        transactions += 1;
        return originalTransaction(...args);
      };

      await expect(backing!.getItems!(["blob", "blob::stamp", "absent"])).resolves.toEqual([
        "payload",
        "42",
        null,
      ]);
      expect(transactions).toBe(1);
    });

    it("starts the read transaction SYNCHRONOUSLY on a warm connection", async () => {
      const db = installFakeIndexedDB({});
      const { createIdbBacking } = await import("./idbBacking");
      const backing = createIdbBacking();
      await backing!.setItem("warm", "1");

      let transactionCreatedSync = false;
      const originalTransaction = db.transaction.bind(db);
      db.transaction = (...args: Parameters<FakeDB["transaction"]>) => {
        transactionCreatedSync = true;
        return originalTransaction(...args);
      };

      const pending = backing!.getItems!(["warm", "warm::stamp"]);
      expect(transactionCreatedSync).toBe(true);
      await pending;
    });

    it("rejects when the connection cannot be opened", async () => {
      installFakeIndexedDB({ failOpenSync: true });
      const { createIdbBacking } = await import("./idbBacking");
      const backing = createIdbBacking();
      await expect(backing!.getItems!(["a", "b"])).rejects.toThrow(/sync open failure/);
    });
  });

  describe("probeIdbBacking", () => {
    it("resolves true on a working backend after a real round trip", async () => {
      installFakeIndexedDB({});
      const { probeIdbBacking } = await import("./idbBacking");
      await expect(probeIdbBacking()).resolves.toBe(true);
    });

    it("resolves false (never throws) when open() fails synchronously", async () => {
      installFakeIndexedDB({ failOpenSync: true });
      const { probeIdbBacking } = await import("./idbBacking");
      await expect(probeIdbBacking()).resolves.toBe(false);
    });

    it("resolves false when open() fails asynchronously", async () => {
      installFakeIndexedDB({ failOpenAsync: true });
      const { probeIdbBacking } = await import("./idbBacking");
      await expect(probeIdbBacking()).resolves.toBe(false);
    });

    // P9: the round-trip READ result used to be discarded, so the read leg proved nothing. A backing
    // that accepts a put and then hands back nothing on read is broken in exactly the way this probe
    // exists to catch, and it used to pass.
    it("resolves false when the write is accepted but the read-back value does not match", async () => {
      const db = installFakeIndexedDB({});
      db.readsReturnNothing = true;
      const { probeIdbBacking } = await import("./idbBacking");
      await expect(probeIdbBacking()).resolves.toBe(false);
    });

    // P1 at the probe: a backing whose transactions abort at commit is not usable, and the probe must
    // say so rather than believing the request-level success.
    it("resolves false when every transaction aborts at commit", async () => {
      const db = installFakeIndexedDB({});
      db.abortAtCommit = true;
      const { probeIdbBacking } = await import("./idbBacking");
      await expect(probeIdbBacking()).resolves.toBe(false);
    });

    it("resolves false when indexedDB is entirely unavailable", async () => {
      vi.stubGlobal("indexedDB", undefined);
      const { probeIdbBacking } = await import("./idbBacking");
      await expect(probeIdbBacking()).resolves.toBe(false);
    });
  });
});
