import { afterEach, describe, expect, it, vi } from "vitest";
import { createAsyncDurablePersistStorage, createAsyncDurableStorage, createNativeIndexedDbDatabase, getPersistedStatePresence, type AsyncKeyValueDatabase } from "@/stores/scanPersistStorage";

class Db implements AsyncKeyValueDatabase {
  values = new Map<string, string>(); fail = false;
  async get(k: string) { return this.values.get(k) ?? null; }
  async set(k: string, v: string) { if (this.fail) throw new Error("blocked"); this.values.set(k, v); }
  async remove(k: string) { if (this.fail) throw new Error("blocked"); this.values.delete(k); }
}
function legacy() { const values = new Map<string, string>(); return { values, getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k) }; }

type Handler<T> = ((event: Event) => T) | null;
function nativeDbHarness() {
  const request = { result: undefined as unknown, error: null as DOMException | null, onsuccess: null as Handler<void>, onerror: null as Handler<void> };
  const transaction = {
    error: null as DOMException | null,
    oncomplete: null as Handler<void>,
    onabort: null as Handler<void>,
    objectStore: () => ({ get: () => request }),
  };
  const database = {
    objectStoreNames: { contains: () => true },
    onversionchange: null as Handler<void>,
    close: vi.fn(),
    transaction: vi.fn(() => transaction),
  };
  const openRequest = { result: database, error: null as DOMException | null, onupgradeneeded: null as Handler<void>, onsuccess: null as Handler<void>, onerror: null as Handler<void> };
  return {
    factory: { open: vi.fn(() => openRequest) },
    openRequest,
    request,
    transaction,
    open() { openRequest.onsuccess?.(new Event("success")); },
  };
}

afterEach(() => vi.unstubAllGlobals());

class InFlightWriteWithFailedDeleteDb extends Db {
  private releaseWrite: (() => void) | null = null;
  private notifyWriteStarted: (() => void) | null = null;
  private readonly writeMayFinish = new Promise<void>((resolve) => { this.releaseWrite = resolve; });
  readonly writeStarted = new Promise<void>((resolve) => {
    this.notifyWriteStarted = resolve;
  });

  override async set(key: string, value: string): Promise<void> {
    if (key === "sis-scan-owner") {
      this.notifyWriteStarted?.();
      await this.writeMayFinish;
    }
    await super.set(key, value);
  }

  override async remove(): Promise<void> {
    throw new Error("delete blocked");
  }

  finishWrite(): void { this.releaseWrite?.(); }
}

class SnapshotDeleteFailsDb extends Db {
  override async remove(key: string): Promise<void> {
    if (key === "sis-scan-owner") throw new Error("delete blocked");
    await super.remove(key);
  }
}

describe("active async persistence adapter", () => {
  it("migrates legacy bytes into durable storage", async () => {
    const db = new Db(), local = legacy(); local.values.set("sis-scan-owner", '{"version":14}');
    const storage = createAsyncDurableStorage({ database: db, getLegacyStorage: () => local });
    await expect(storage.getItem("sis-scan-owner")).resolves.toBe('{"version":14}');
    expect(await db.get("sis-scan-owner")).toBe('{"version":14}');
  });
  it("coalesces burst writes to the latest snapshot", async () => {
    const db = new Db(), local = legacy(), set = vi.spyOn(db, "set");
    const storage = createAsyncDurableStorage({ database: db, getLegacyStorage: () => local });
    await Promise.all([storage.setItem("sis-scan-owner", "a"), storage.setItem("sis-scan-owner", "b")]);
    expect(set).toHaveBeenCalledTimes(1); expect(await db.get("sis-scan-owner")).toBe("b");
  });
  it("defers one typed persist serialization for a burst and encodes only its latest snapshot", async () => {
    const db = new Db();
    const serialize = vi.fn((snapshot: unknown) => JSON.stringify(snapshot));
    const storage = createAsyncDurablePersistStorage<{ scanFeed: string[] }>({
      database: db,
      getLegacyStorage: () => legacy(),
      serialize,
    });

    await Promise.all([
      storage.setItem("sis-scan-owner", { state: { scanFeed: ["scan-1"] }, version: 14 }),
      storage.setItem("sis-scan-owner", { state: { scanFeed: ["scan-1", "scan-2"] }, version: 14 }),
      storage.setItem("sis-scan-owner", { state: { scanFeed: ["scan-1", "scan-2", "scan-3"] }, version: 14 }),
    ]);

    expect(serialize).toHaveBeenCalledTimes(1);
    expect(await db.get("sis-scan-owner")).toBe(
      JSON.stringify({ state: { scanFeed: ["scan-1", "scan-2", "scan-3"] }, version: 14 }),
    );
  });
  it("never retries full-snapshot localStorage writes across a healthy IndexedDB scan burst", async () => {
    const db = new Db();
    const fallbackSet = vi.fn(() => { throw new DOMException("quota full", "QuotaExceededError"); });
    const fallback = { getItem: vi.fn(() => null), setItem: fallbackSet, removeItem: vi.fn() };
    const status = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const storage = createAsyncDurableStorage({ database: db, getLegacyStorage: () => fallback, onStatusChange: status });

    for (let scan = 1; scan <= 101; scan += 1) {
      await storage.setItem("sis-scan-v1", `snapshot-${scan}`);
    }

    expect(await db.get("sis-scan-v1")).toBe("snapshot-101");
    expect(fallbackSet).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalledWith("degraded");
  });
  it("writes a uid ownership marker once without copying growing durable snapshots", async () => {
    const db = new Db();
    const local = legacy();
    const fallbackSet = vi.spyOn(local, "setItem");
    const storage = createAsyncDurableStorage({ database: db, getLegacyStorage: () => local });

    await storage.setItem("sis-scan-owner", "snapshot-1");
    await storage.setItem("sis-scan-owner", "snapshot-2");
    await storage.setItem("sis-scan-owner", "snapshot-3");

    expect(fallbackSet).toHaveBeenCalledOnce();
    expect(fallbackSet).toHaveBeenCalledWith("sis-scan-owner", '{"__scanPersistPointer":1}');
    expect(local.values.get("sis-scan-owner")).toBe('{"__scanPersistPointer":1}');
    expect(await db.get("sis-scan-owner")).toBe("snapshot-3");
  });
  it("recreates the uid ownership marker after clear followed by an intentional new write", async () => {
    const db = new Db();
    const local = legacy();
    const storage = createAsyncDurableStorage({ database: db, getLegacyStorage: () => local });
    await storage.setItem("sis-scan-owner", "before clear");

    await storage.removeItem("sis-scan-owner");
    expect(local.values.has("sis-scan-owner")).toBe(false);
    await storage.setItem("sis-scan-owner", "after clear");

    expect(await db.get("sis-scan-owner")).toBe("after clear");
    expect(local.values.get("sis-scan-owner")).toBe('{"__scanPersistPointer":1}');
  });
  it("retries uid marker creation after a transient localStorage failure", async () => {
    const db = new Db();
    const values = new Map<string, string>();
    let failMarkerWrite = true;
    const local = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (failMarkerWrite) throw new DOMException("temporarily blocked", "InvalidStateError");
        values.set(key, value);
      },
      removeItem: (key: string) => { values.delete(key); },
    };
    const storage = createAsyncDurableStorage({ database: db, getLegacyStorage: () => local });

    await storage.setItem("sis-scan-owner", "snapshot-1");
    expect(values.has("sis-scan-owner")).toBe(false);
    failMarkerWrite = false;
    await storage.setItem("sis-scan-owner", "snapshot-2");

    expect(values.get("sis-scan-owner")).toBe('{"__scanPersistPointer":1}');
  });
  it("retries legacy snapshot removal after a transient localStorage failure", async () => {
    const db = new Db();
    await db.set("sis-scan-v1", "durable snapshot");
    const values = new Map([["sis-scan-v1", "stale legacy snapshot"]]);
    let failRemoval = true;
    const local = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => {
        if (failRemoval && key === "sis-scan-v1") throw new DOMException("temporarily blocked", "InvalidStateError");
        values.delete(key);
      },
    };
    const storage = createAsyncDurableStorage({ database: db, getLegacyStorage: () => local });

    await expect(storage.getItem("sis-scan-v1")).resolves.toBe("durable snapshot");
    expect(values.get("sis-scan-v1")).toBe("stale legacy snapshot");
    failRemoval = false;
    await storage.setItem("sis-scan-v1", "new durable snapshot");

    expect(values.has("sis-scan-v1")).toBe(false);
  });
  it("removes the legacy snapshot after successfully migrating its exact bytes into IndexedDB", async () => {
    const db = new Db();
    const local = legacy();
    local.values.set("sis-scan-v1", '{"version":14,"state":{"scanFeed":[{"id":"scan-1"}]}}');
    const remove = vi.spyOn(local, "removeItem");
    const storage = createAsyncDurableStorage({ database: db, getLegacyStorage: () => local });

    await expect(storage.getItem("sis-scan-v1")).resolves.toBe('{"version":14,"state":{"scanFeed":[{"id":"scan-1"}]}}');

    expect(await db.get("sis-scan-v1")).toBe('{"version":14,"state":{"scanFeed":[{"id":"scan-1"}]}}');
    expect(remove).toHaveBeenCalledWith("sis-scan-v1");
    expect(local.values.has("sis-scan-v1")).toBe(false);
  });
  it("uses localStorage as a full-snapshot fallback only while IndexedDB writes fail", async () => {
    const db = new Db();
    const local = legacy();
    const storage = createAsyncDurableStorage({ database: db, getLegacyStorage: () => local });
    db.fail = true;

    await storage.setItem("sis-scan-v1", "fallback snapshot");

    expect(local.values.get("sis-scan-v1")).toBe("fallback snapshot");
    await expect(createAsyncDurableStorage({ database: null, getLegacyStorage: () => local }).getItem("sis-scan-v1")).resolves.toBe("fallback snapshot");

    db.fail = false;
    await storage.setItem("sis-scan-v1", "durable recovery");

    expect(await db.get("sis-scan-v1")).toBe("durable recovery");
    expect(local.values.has("sis-scan-v1")).toBe(false);
  });
  it("tombstones failed deletion so stale data cannot rehydrate", async () => {
    const db = new Db(), local = legacy(); await db.set("sis-scan-owner", "old"); db.fail = true;
    await createAsyncDurableStorage({ database: db, getLegacyStorage: () => local }).removeItem("sis-scan-owner");
    db.fail = false;
    await expect(createAsyncDurableStorage({ database: db, getLegacyStorage: () => local }).getItem("sis-scan-owner")).resolves.toBeNull();
  });
  it("clears only the selected UID namespace and leaves another UID snapshot durable", async () => {
    const db = new Db();
    const storage = createAsyncDurableStorage({ database: db, getLegacyStorage: () => legacy() });
    await storage.setItem("sis-scan-owner", "owner snapshot");
    await storage.setItem("sis-scan-counter", "counter snapshot");

    await storage.removeItem("sis-scan-owner");

    const reloaded = createAsyncDurableStorage({ database: db, getLegacyStorage: () => legacy() });
    await expect(reloaded.getItem("sis-scan-owner")).resolves.toBeNull();
    await expect(reloaded.getItem("sis-scan-counter")).resolves.toBe("counter snapshot");
  });
  it("keeps a clear tombstone authoritative when a pre-clear write finishes and deletion fails without localStorage", async () => {
    const db = new InFlightWriteWithFailedDeleteDb();
    const unavailableLocalStorage = () => { throw new Error("private browsing"); };
    const storage = createAsyncDurableStorage({ database: db, getLegacyStorage: unavailableLocalStorage });

    const write = storage.setItem("sis-scan-owner", "pre-clear snapshot");
    await db.writeStarted;
    const clear = storage.removeItem("sis-scan-owner");
    db.finishWrite();
    await Promise.all([write, clear]);

    await expect(createAsyncDurableStorage({ database: db, getLegacyStorage: unavailableLocalStorage }).getItem("sis-scan-owner")).resolves.toBeNull();
  });
  it("allows only a post-clear write to supersede a durable tombstone", async () => {
    const db = new SnapshotDeleteFailsDb();
    await db.set("sis-scan-owner", "old snapshot");
    const storage = createAsyncDurableStorage({ database: db, getLegacyStorage: () => null });

    await storage.removeItem("sis-scan-owner");
    await storage.setItem("sis-scan-owner", "intentional new snapshot");

    await expect(createAsyncDurableStorage({ database: db, getLegacyStorage: () => null }).getItem("sis-scan-owner")).resolves.toBe("intentional new snapshot");
  });
  it("fails soft when both stores are unavailable", async () => {
    const db = new Db(); db.fail = true;
    const storage = createAsyncDurableStorage({ database: db, getLegacyStorage: () => { throw new Error("private"); } });
    await expect(storage.setItem("sis-scan-owner", "scan")).resolves.toBeUndefined();
  });
  it("notifies an external status consumer when durable and local storage fail", async () => {
    const db = new Db(); db.fail = true;
    const status = vi.fn();
    const storage = createAsyncDurableStorage({ database: db, getLegacyStorage: () => { throw new Error("private"); }, onStatusChange: status });

    await storage.setItem("sis-scan-owner", "scan");

    expect(status).toHaveBeenCalledWith("degraded");
  });
  it("keeps durable persistence available when only the localStorage fallback is blocked", async () => {
    const db = new Db();
    const status = vi.fn();
    const storage = createAsyncDurableStorage({ database: db, getLegacyStorage: () => { throw new Error("private"); }, onStatusChange: status });

    await storage.setItem("sis-scan-owner", "durable scan");

    expect(await db.get("sis-scan-owner")).toBe("durable scan");
    expect(status).toHaveBeenCalledWith("available");
    expect(status).not.toHaveBeenCalledWith("degraded");
  });
});

describe("native IndexedDB bridge", () => {
  it("reports an inaccessible IndexedDB namespace as unavailable, never absent", async () => {
    const failedOpen = {
      error: new DOMException("blocked", "InvalidStateError"),
      onupgradeneeded: null as Handler<void>,
      onsuccess: null as Handler<void>,
      onerror: null as Handler<void>,
    };
    vi.stubGlobal("indexedDB", { open: vi.fn(() => failedOpen) });

    const presence = getPersistedStatePresence("sis-scan-owner");
    failedOpen.onerror?.(new Event("error"));

    await expect(presence).resolves.toBe("unavailable");
  });

  it("waits for transaction completion before resolving a successful read", async () => {
    const harness = nativeDbHarness();
    vi.stubGlobal("indexedDB", harness.factory);
    const database = createNativeIndexedDbDatabase();
    if (!database) throw new Error("test setup did not provide IndexedDB");
    let settled = false;
    const read = database.get("sis-scan-owner").then((value) => { settled = true; return value; });

    harness.open();
    await Promise.resolve();
    harness.request.result = "snapshot";
    harness.request.onsuccess?.(new Event("success"));
    await Promise.resolve();
    expect(settled).toBe(false);
    harness.transaction.oncomplete?.(new Event("complete"));

    await expect(read).resolves.toBe("snapshot");
  });

  it("rejects when the IndexedDB transaction aborts", async () => {
    const harness = nativeDbHarness();
    vi.stubGlobal("indexedDB", harness.factory);
    const database = createNativeIndexedDbDatabase();
    if (!database) throw new Error("test setup did not provide IndexedDB");
    const read = database.get("sis-scan-owner");

    harness.open();
    await Promise.resolve();
    harness.transaction.error = new DOMException("aborted", "AbortError");
    harness.transaction.onabort?.(new Event("abort"));

    await expect(read).rejects.toMatchObject({ name: "AbortError" });
  });

  it("cleans up a failed open so the next operation can retry without an unhandled cleanup rejection", async () => {
    const retry = nativeDbHarness();
    const failedOpen = { error: new DOMException("blocked", "InvalidStateError"), onupgradeneeded: null as Handler<void>, onsuccess: null as Handler<void>, onerror: null as Handler<void> };
    const factory = { open: vi.fn().mockReturnValueOnce(failedOpen).mockReturnValueOnce(retry.openRequest) };
    vi.stubGlobal("indexedDB", factory);
    const database = createNativeIndexedDbDatabase();
    if (!database) throw new Error("test setup did not provide IndexedDB");

    const first = database.get("sis-scan-owner");
    failedOpen.onerror?.(new Event("error"));
    await expect(first).rejects.toMatchObject({ name: "InvalidStateError" });

    const second = database.get("sis-scan-owner");
    expect(factory.open).toHaveBeenCalledTimes(2);
    retry.open();
    await Promise.resolve();
    retry.request.result = "retry snapshot";
    retry.request.onsuccess?.(new Event("success"));
    retry.transaction.oncomplete?.(new Event("complete"));
    await expect(second).resolves.toBe("retry snapshot");
  });
});
