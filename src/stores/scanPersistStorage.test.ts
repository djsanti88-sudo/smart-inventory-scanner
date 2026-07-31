import { afterEach, describe, expect, it, vi } from "vitest";
import { createAsyncDurablePersistStorage, createAsyncDurableStorage, createNativeIndexedDbDatabase, getAuthoritativePersistFallback, getPersistedStatePresence, type AsyncKeyValueDatabase } from "@/stores/scanPersistStorage";

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

class SelectiveRecoveryDb extends Db {
  failMainWrite = false;
  failCandidateRemove = false;
  failTombstoneRemove = false;

  override async set(key: string, value: string): Promise<void> {
    if (this.failMainWrite && key === "sis-scan-owner") throw new Error("main write interrupted");
    await super.set(key, value);
  }

  override async remove(key: string): Promise<void> {
    if (this.failCandidateRemove && key === "sis-scan-owner::scanbin-recovery-v1") {
      throw new Error("candidate cleanup interrupted");
    }
    if (this.failTombstoneRemove && key === "sis-scan-owner::scanbin-cleared-v1") {
      throw new Error("tombstone cleanup interrupted");
    }
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

    expect(getAuthoritativePersistFallback(local.values.get("sis-scan-v1") ?? null)).toBe("fallback snapshot");
    await expect(createAsyncDurableStorage({ database: null, getLegacyStorage: () => local }).getItem("sis-scan-v1")).resolves.toBe("fallback snapshot");

    db.fail = false;
    await storage.setItem("sis-scan-v1", "durable recovery");

    expect(await db.get("sis-scan-v1")).toBe("durable recovery");
    expect(local.values.has("sis-scan-v1")).toBe(false);
  });
  it("promotes a newer fallback snapshot ahead of an older durable snapshot after reload", async () => {
    const db = new Db();
    const local = legacy();
    await db.set("sis-scan-owner", "older durable snapshot");
    const storage = createAsyncDurableStorage({ database: db, getLegacyStorage: () => local });

    db.fail = true;
    await storage.setItem("sis-scan-owner", "newer fallback snapshot");
    db.fail = false;

    const reloaded = createAsyncDurableStorage({ database: db, getLegacyStorage: () => local });
    await expect(reloaded.getItem("sis-scan-owner")).resolves.toBe("newer fallback snapshot");
    expect(await db.get("sis-scan-owner")).toBe("newer fallback snapshot");
  });
  it("records fallback payload and authority atomically when interrupted at the local write boundary", async () => {
    const db = new Db();
    await db.set("sis-scan-owner", "older durable snapshot");
    db.fail = true;
    const values = new Map<string, string>();
    let setCalls = 0;
    const local = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        setCalls += 1;
        if (setCalls > 1) throw new Error("simulated interruption after one atomic local write");
        values.set(key, value);
      },
      removeItem: (key: string) => { values.delete(key); },
    };
    const storage = createAsyncDurableStorage({ database: db, getLegacyStorage: () => local });

    await storage.setItem("sis-scan-owner", "newer fallback snapshot");

    expect(setCalls).toBe(1);
    expect(getAuthoritativePersistFallback(values.get("sis-scan-owner") ?? null)).toBe("newer fallback snapshot");
    db.fail = false;
    await expect(createAsyncDurableStorage({ database: db, getLegacyStorage: () => local }).getItem("sis-scan-owner"))
      .resolves.toBe("newer fallback snapshot");
  });
  it("updates an existing fallback envelope before a recovered durable write can commit", async () => {
    const db = new Db();
    const local = legacy();
    const events: string[] = [];
    const originalDbSet = db.set.bind(db);
    vi.spyOn(db, "set").mockImplementation(async (key, value) => {
      events.push(`db:${value}`);
      await originalDbSet(key, value);
    });
    const originalLocalSet = local.setItem.bind(local);
    vi.spyOn(local, "setItem").mockImplementation((key, value) => {
      events.push(`local:${value}`);
      return originalLocalSet(key, value);
    });
    const storage = createAsyncDurableStorage({ database: db, getLegacyStorage: () => local });
    db.fail = true;
    await storage.setItem("sis-scan-owner", "older fallback snapshot");

    events.length = 0;
    db.fail = false;
    await storage.setItem("sis-scan-owner", "latest recovered snapshot");

    const localLatest = events.findIndex((event) => event.startsWith("local:") && event.includes("latest recovered snapshot"));
    const durableLatest = events.findIndex((event) => event === "db:latest recovered snapshot");
    expect(localLatest).toBeGreaterThanOrEqual(0);
    expect(durableLatest).toBeGreaterThan(localLatest);
  });
  it("journals the newest snapshot durably when quota blocks updating an existing fallback envelope", async () => {
    const db = new SelectiveRecoveryDb();
    await db.set("sis-scan-owner", "original durable snapshot");
    const values = new Map<string, string>();
    let quotaBlocked = false;
    const local = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (quotaBlocked) throw new DOMException("quota full", "QuotaExceededError");
        values.set(key, value);
      },
      removeItem: (key: string) => { values.delete(key); },
    };
    const storage = createAsyncDurableStorage({ database: db, getLegacyStorage: () => local });
    db.failMainWrite = true;
    await storage.setItem("sis-scan-owner", "older fallback snapshot");

    quotaBlocked = true;
    db.failMainWrite = false;
    await storage.setItem("sis-scan-owner", "newest quota-blocked snapshot");

    await expect(createAsyncDurableStorage({ database: db, getLegacyStorage: () => local }).getItem("sis-scan-owner"))
      .resolves.toBe("newest quota-blocked snapshot");
  });
  it("rehydrates the recovery candidate when interrupted after journaling but before the main write", async () => {
    const db = new SelectiveRecoveryDb();
    await db.set("sis-scan-owner", "original durable snapshot");
    const values = new Map<string, string>();
    let quotaBlocked = false;
    const local = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (quotaBlocked) throw new DOMException("quota full", "QuotaExceededError");
        values.set(key, value);
      },
      removeItem: (key: string) => { values.delete(key); },
    };
    const storage = createAsyncDurableStorage({ database: db, getLegacyStorage: () => local });
    db.failMainWrite = true;
    await storage.setItem("sis-scan-owner", "older fallback snapshot");
    quotaBlocked = true;

    await storage.setItem("sis-scan-owner", "newest journaled snapshot");
    expect(await db.get("sis-scan-owner")).toBe("original durable snapshot");
    db.failMainWrite = false;

    await expect(createAsyncDurableStorage({ database: db, getLegacyStorage: () => local }).getItem("sis-scan-owner"))
      .resolves.toBe("newest journaled snapshot");
  });
  it("keeps a recovery candidate authoritative through cleanup interruption and prevents clear resurrection", async () => {
    const db = new SelectiveRecoveryDb();
    await db.set("sis-scan-owner", "original durable snapshot");
    const values = new Map<string, string>();
    let storageBlocked = false;
    const local = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (storageBlocked) throw new DOMException("quota full", "QuotaExceededError");
        values.set(key, value);
      },
      removeItem: (key: string) => {
        if (storageBlocked) throw new DOMException("storage interrupted", "InvalidStateError");
        values.delete(key);
      },
    };
    const storage = createAsyncDurableStorage({ database: db, getLegacyStorage: () => local });
    db.failMainWrite = true;
    await storage.setItem("sis-scan-owner", "older fallback snapshot");
    db.failMainWrite = false;
    db.failCandidateRemove = true;
    storageBlocked = true;

    await storage.setItem("sis-scan-owner", "newest cleanup-interrupted snapshot");
    expect(JSON.parse((await db.get("sis-scan-owner::scanbin-recovery-v1")) ?? "null")).toMatchObject({
      payload: "newest cleanup-interrupted snapshot",
    });
    const clearResult = await storage.removeItem("sis-scan-owner");
    expect(clearResult).toMatchObject({ cleared: true, authority: "durable" });

    await expect(createAsyncDurableStorage({ database: db, getLegacyStorage: () => local }).getItem("sis-scan-owner"))
      .resolves.toBeNull();
  });
  it("rewrites a retained recovery candidate before a later ordinary main write", async () => {
    const db = new SelectiveRecoveryDb();
    await db.set("sis-scan-owner", "original durable snapshot");
    const values = new Map<string, string>();
    let storageBlocked = false;
    const local = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (storageBlocked) throw new DOMException("quota full", "QuotaExceededError");
        values.set(key, value);
      },
      removeItem: (key: string) => {
        if (storageBlocked) throw new DOMException("storage interrupted", "InvalidStateError");
        values.delete(key);
      },
    };
    const storage = createAsyncDurableStorage({ database: db, getLegacyStorage: () => local });
    db.failMainWrite = true;
    await storage.setItem("sis-scan-owner", "older fallback snapshot");
    db.failMainWrite = false;
    db.failCandidateRemove = true;
    storageBlocked = true;
    await storage.setItem("sis-scan-owner", "first recovery snapshot");

    storageBlocked = false;
    await storage.setItem("sis-scan-owner", "later ordinary snapshot");

    await expect(createAsyncDurableStorage({ database: db, getLegacyStorage: () => local }).getItem("sis-scan-owner"))
      .resolves.toBe("later ordinary snapshot");
  });
  it("rehydrates a post-clear candidate when exact tombstone retirement is interrupted", async () => {
    const db = new SelectiveRecoveryDb();
    const local = legacy();
    const storage = createAsyncDurableStorage({ database: db, getLegacyStorage: () => local });
    await storage.setItem("sis-scan-owner", "before clear");
    await storage.removeItem("sis-scan-owner");
    db.failTombstoneRemove = true;

    await storage.setItem("sis-scan-owner", "counted after clear");

    await expect(createAsyncDurableStorage({ database: db, getLegacyStorage: () => local }).getItem("sis-scan-owner"))
      .resolves.toBe("counted after clear");
  });
  it("rehydrates a token-matched post-clear candidate when interrupted before the main write", async () => {
    const db = new SelectiveRecoveryDb();
    const local = legacy();
    const storage = createAsyncDurableStorage({ database: db, getLegacyStorage: () => local });
    await storage.setItem("sis-scan-owner", "before clear");
    await storage.removeItem("sis-scan-owner");
    db.failMainWrite = true;

    await storage.setItem("sis-scan-owner", "journaled after clear");
    db.failMainWrite = false;

    await expect(createAsyncDurableStorage({ database: db, getLegacyStorage: () => local }).getItem("sis-scan-owner"))
      .resolves.toBe("journaled after clear");
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
  it("reports a non-authoritative clear when neither durable nor local tombstone can be recorded", async () => {
    const db = new Db(); db.fail = true;
    const storage = createAsyncDurableStorage({ database: db, getLegacyStorage: () => { throw new Error("private"); } });

    await expect(storage.removeItem("sis-scan-owner")).resolves.toMatchObject({ cleared: false });
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
