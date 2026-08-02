import { afterEach, describe, expect, it, vi } from "vitest";
import { createAsyncDurablePersistStorage, createAsyncDurableStorage, createNativeIndexedDbDatabase, getAuthoritativePersistFallback, getPersistedStatePresence, getPersistedStatePresenceFromDatabase, type AsyncKeyValueDatabase } from "@/stores/scanPersistStorage";
import { createLegacyAdoptionOperations, tryRunPersistenceMutation } from "@/stores/scanPersistNamespace";

class Db implements AsyncKeyValueDatabase {
  values = new Map<string, string>(); fail = false;
  async get(k: string) { return this.values.get(k) ?? null; }
  async set(k: string, v: string) { if (this.fail) throw new Error("blocked"); this.values.set(k, v); }
  async remove(k: string) { if (this.fail) throw new Error("blocked"); this.values.delete(k); }
  async createNamespaceIfAbsent(key: string, value: string, occupiedMetadataKeys: string[]) {
    if (this.values.has(key) || occupiedMetadataKeys.some((metadataKey) => this.values.has(metadataKey))) return "exists" as const;
    await this.set(key, value);
    return "created" as const;
  }
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

class ToggleUnavailableDb extends Db {
  unavailable = false;
  override async get(key: string): Promise<string | null> {
    if (this.unavailable) throw new Error("IndexedDB unavailable");
    return super.get(key);
  }
  override async set(key: string, value: string): Promise<void> {
    if (this.unavailable) throw new Error("IndexedDB unavailable");
    await super.set(key, value);
  }
}

class TombstoneReadFailsDb extends Db {
  failTombstoneRead = false;
  override async get(key: string): Promise<string | null> {
    if (this.failTombstoneRead && key === "sis-scan-owner::scanbin-cleared-v1") {
      throw new Error("durable tombstone unreadable");
    }
    return super.get(key);
  }
}

class CandidateReadFailsDb extends Db {
  failCandidateRead = true;
  failCandidateRemove = false;
  override async get(key: string): Promise<string | null> {
    if (this.failCandidateRead && key === "sis-scan-owner::scanbin-recovery-v1") throw new Error("candidate unreadable");
    return super.get(key);
  }
  override async remove(key: string): Promise<void> {
    if (this.failCandidateRemove && key === "sis-scan-owner::scanbin-recovery-v1") throw new Error("candidate removal failed");
    await super.remove(key);
  }
}

class RecoverySetFailsDb extends TombstoneReadFailsDb {
  failRecoverySet = false;
  override async set(key: string, value: string): Promise<void> {
    if (this.failRecoverySet && key === "sis-scan-owner::scanbin-recovery-v1") throw new Error("recovery journal unavailable");
    await super.set(key, value);
  }
}

class IntentRemoveFailsDb extends Db {
  override async remove(key: string): Promise<void> {
    if (key === "sis-scan-owner::scanbin-write-intent-v1") throw new Error("intent removal blocked");
    await super.remove(key);
  }
}

class BlockedIntentDb extends Db {
  private releaseIntents: (() => void) | null = null;
  private readonly intentsMayFinish = new Promise<void>((resolve) => { this.releaseIntents = resolve; });

  override async set(key: string, value: string): Promise<void> {
    if (key.endsWith("::scanbin-write-intent-v1")) await this.intentsMayFinish;
    await super.set(key, value);
  }

  finishIntents(): void { this.releaseIntents?.(); }
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
    expect(set.mock.calls.filter(([key]) => key === "sis-scan-owner")).toHaveLength(1);
    expect(await db.get("sis-scan-owner")).toBe("b");
  });
  it("does not start IndexedDB evidence reads merely from scheduling a coalesced burst", async () => {
    const db = new Db();
    const get = vi.spyOn(db, "get");
    const storage = createAsyncDurableStorage({ database: db, getLegacyStorage: () => legacy() });

    const first = storage.setItem("sis-scan-owner", "snapshot-1");
    const second = storage.setItem("sis-scan-owner", "snapshot-2");

    expect(get).not.toHaveBeenCalled();
    await Promise.all([first, second]);
    expect(await db.get("sis-scan-owner")).toBe("snapshot-2");
  });
  it("keeps 100 scheduled snapshots synchronous, unserialized, and free of IndexedDB reads", async () => {
    const db = new BlockedIntentDb();
    const get = vi.spyOn(db, "get");
    const set = vi.spyOn(db, "set");
    const serialize = vi.fn((snapshot: unknown) => JSON.stringify(snapshot));
    const storage = createAsyncDurablePersistStorage<{ scanFeed: number[] }>({
      database: db,
      getLegacyStorage: () => null,
      serialize,
    });

    const writes = Array.from({ length: 100 }, (_, index) =>
      storage.setItem("sis-scan-owner", { state: { scanFeed: [index] }, version: 14 }));

    expect(get).not.toHaveBeenCalled();
    expect(serialize).not.toHaveBeenCalled();
    expect(set).toHaveBeenCalledOnce();
    expect(set.mock.calls.every(([key]) => key === "sis-scan-owner::scanbin-write-intent-v1")).toBe(true);
    db.finishIntents();
    await Promise.all(writes);
    expect(serialize).toHaveBeenCalledOnce();
    expect(set.mock.calls.filter(([key]) => key === "sis-scan-owner")).toHaveLength(1);
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
  it("fails closed when local and durable tombstones diverge across consecutive clears", async () => {
    const db = new SelectiveRecoveryDb();
    const values = new Map<string, string>();
    let rejectNextTombstoneOverwrite = false;
    const local = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (rejectNextTombstoneOverwrite && key === "sis-scan-owner::scanbin-cleared-v1") {
          rejectNextTombstoneOverwrite = false;
          throw new DOMException("tombstone write interrupted", "InvalidStateError");
        }
        values.set(key, value);
      },
      removeItem: (key: string) => { values.delete(key); },
    };
    const storage = createAsyncDurableStorage({ database: db, getLegacyStorage: () => local });
    await storage.setItem("sis-scan-owner", "before clear A");
    await storage.removeItem("sis-scan-owner");
    db.failTombstoneRemove = true;
    db.failCandidateRemove = true;
    await storage.setItem("sis-scan-owner", "candidate superseding clear A");
    db.failTombstoneRemove = false;
    rejectNextTombstoneOverwrite = true;

    await storage.removeItem("sis-scan-owner");

    await expect(createAsyncDurableStorage({ database: db, getLegacyStorage: () => local }).getItem("sis-scan-owner"))
      .resolves.toBeNull();
  });
  it("preserves newest local fallback when recovery detection and journaling are both unavailable", async () => {
    const db = new ToggleUnavailableDb();
    await db.set("sis-scan-owner", "older durable snapshot");
    await db.set("sis-scan-owner::scanbin-recovery-v1", "stale recovery candidate");
    const local = legacy();
    db.unavailable = true;
    const storage = createAsyncDurableStorage({ database: db, getLegacyStorage: () => local });

    await storage.setItem("sis-scan-owner", "newest offline snapshot");

    await expect(createAsyncDurableStorage({ database: null, getLegacyStorage: () => local }).getItem("sis-scan-owner"))
      .resolves.toBe("newest offline snapshot");
    db.unavailable = false;
    await expect(createAsyncDurableStorage({ database: db, getLegacyStorage: () => local }).getItem("sis-scan-owner"))
      .resolves.toBe("newest offline snapshot");
    expect(await db.get("sis-scan-owner")).toBe("newest offline snapshot");
  });
  it("does not promote or retire a candidate while the durable tombstone is unreadable", async () => {
    const db = new TombstoneReadFailsDb();
    const clear = JSON.stringify({ __scanPersistClear: 1, version: 3, id: "clear-3" });
    const candidate = JSON.stringify({
      __scanPersistRecovery: 1,
      payload: "post-clear candidate",
      supersedesTombstone: clear,
    });
    await db.set("sis-scan-owner", "stale main");
    await db.set("sis-scan-owner::scanbin-cleared-v1", clear);
    await db.set("sis-scan-owner::scanbin-recovery-v1", candidate);
    db.failTombstoneRead = true;

    const storage = createAsyncDurableStorage({ database: db, getLegacyStorage: () => legacy() });
    await expect(storage.getItem("sis-scan-owner")).resolves.toBeNull();

    db.failTombstoneRead = false;
    expect(await db.get("sis-scan-owner")).toBe("stale main");
    expect(await db.get("sis-scan-owner::scanbin-recovery-v1")).toBe(candidate);
  });
  it("selects a newer local ordered clear over an older durable clear and its candidate", async () => {
    const db = new Db();
    const local = legacy();
    const older = JSON.stringify({ __scanPersistClear: 1, version: 4, id: "clear-4" });
    const newer = JSON.stringify({ __scanPersistClear: 1, version: 5, id: "clear-5" });
    await db.set("sis-scan-owner::scanbin-cleared-v1", older);
    await db.set("sis-scan-owner::scanbin-recovery-v1", JSON.stringify({
      __scanPersistRecovery: 1,
      payload: "candidate after clear 5",
      supersedesTombstone: newer,
    }));
    local.values.set("sis-scan-owner::scanbin-cleared-v1", newer);

    await expect(createAsyncDurableStorage({ database: db, getLegacyStorage: () => local }).getItem("sis-scan-owner"))
      .resolves.toBe("candidate after clear 5");
  });
  it("recovers liveness with a newer journal generation after two adapters leave conflicting clears", async () => {
    const db = new Db();
    const tabALocal = legacy();
    const tabAClear = JSON.stringify({ __scanPersistClear: 1, version: 7, id: "tab-a-clear" });
    const tabBClear = JSON.stringify({ __scanPersistClear: 1, version: 7, id: "tab-b-clear" });
    tabALocal.values.set("sis-scan-owner::scanbin-cleared-v1", tabAClear);
    await db.set("sis-scan-owner::scanbin-cleared-v1", tabBClear);
    const recoveringTab = createAsyncDurableStorage({ database: db, getLegacyStorage: () => tabALocal });

    await expect(recoveringTab.getItem("sis-scan-owner")).resolves.toBeNull();
    await recoveringTab.setItem("sis-scan-owner", "complete snapshot after conflict");

    const freshTab = createAsyncDurableStorage({ database: db, getLegacyStorage: () => tabALocal });
    await expect(freshTab.getItem("sis-scan-owner")).resolves.toBe("complete snapshot after conflict");
    await freshTab.setItem("sis-scan-owner", "future snapshot after recovery");
    await expect(createAsyncDurableStorage({ database: db, getLegacyStorage: () => tabALocal }).getItem("sis-scan-owner"))
      .resolves.toBe("future snapshot after recovery");
  });
  it("keeps the newer conflict-recovery journal authoritative when interrupted before main commit", async () => {
    const db = new SelectiveRecoveryDb();
    const local = legacy();
    local.values.set("sis-scan-owner::scanbin-cleared-v1", JSON.stringify({ __scanPersistClear: 1, version: 9, id: "tab-a" }));
    await db.set("sis-scan-owner::scanbin-cleared-v1", JSON.stringify({ __scanPersistClear: 1, version: 9, id: "tab-b" }));
    const storage = createAsyncDurableStorage({ database: db, getLegacyStorage: () => local });
    await expect(storage.getItem("sis-scan-owner")).resolves.toBeNull();
    db.failMainWrite = true;

    await storage.setItem("sis-scan-owner", "journaled conflict recovery");
    db.failMainWrite = false;

    await expect(createAsyncDurableStorage({ database: db, getLegacyStorage: () => local }).getItem("sis-scan-owner"))
      .resolves.toBe("journaled conflict recovery");
  });
  it("suppresses a delayed pre-clear write and lets only a post-conflict write restore liveness", async () => {
    const db = new Db();
    const local = legacy();
    const storage = createAsyncDurableStorage({ database: db, getLegacyStorage: () => local });
    const delayedPreClearWrite = storage.setItem("sis-scan-owner", "snapshot scheduled before clears");
    local.values.set("sis-scan-owner::scanbin-cleared-v1", JSON.stringify({ __scanPersistClear: 1, version: 11, id: "tab-b" }));
    await db.set("sis-scan-owner::scanbin-cleared-v1", JSON.stringify({ __scanPersistClear: 1, version: 11, id: "tab-c" }));
    await delayedPreClearWrite;

    await expect(createAsyncDurableStorage({ database: db, getLegacyStorage: () => local }).getItem("sis-scan-owner"))
      .resolves.toBeNull();
    await storage.setItem("sis-scan-owner", "snapshot scheduled after conflict");
    expect(await db.get("sis-scan-owner")).toBe("snapshot scheduled after conflict");
    await expect(createAsyncDurableStorage({ database: db, getLegacyStorage: () => local }).getItem("sis-scan-owner"))
      .resolves.toBe("snapshot scheduled after conflict");
  });
  it("suppresses a pre-single-clear write while the first post-clear write survives from synchronous evidence", async () => {
    const db = new Db();
    const local = legacy();
    const storage = createAsyncDurableStorage({ database: db, getLegacyStorage: () => local });
    const delayed = storage.setItem("sis-scan-owner", "scheduled before one clear");
    const clear = JSON.stringify({ __scanPersistClear: 1, version: 13, id: "other-tab-clear" });
    local.values.set("sis-scan-owner::scanbin-cleared-v1", clear);
    await db.set("sis-scan-owner::scanbin-cleared-v1", clear);
    window.dispatchEvent(new StorageEvent("storage", { key: "sis-scan-owner::scanbin-cleared-v1", newValue: clear }));
    await delayed;
    await expect(createAsyncDurableStorage({ database: db, getLegacyStorage: () => local }).getItem("sis-scan-owner"))
      .resolves.toBeNull();

    await storage.setItem("sis-scan-owner", "first physical scan after clear");
    await expect(createAsyncDurableStorage({ database: db, getLegacyStorage: () => local }).getItem("sis-scan-owner"))
      .resolves.toBe("first physical scan after clear");
  });
  it("preserves an equal-time scan issued after a durable-only clear when notification is unavailable", async () => {
    const now = vi.fn(() => 10);
    vi.stubGlobal("performance", { timeOrigin: 1_000, now });
    const clearingDb = new Db();
    const writingDb = new Db();
    writingDb.values = clearingDb.values;
    const clearingTab = createAsyncDurableStorage({ database: clearingDb, getLegacyStorage: () => null });
    await clearingTab.removeItem("sis-scan-owner");
    const writingTab = createAsyncDurableStorage({ database: writingDb, getLegacyStorage: () => null });

    await writingTab.setItem("sis-scan-owner", "first physical scan after durable-only clear");

    await expect(createAsyncDurableStorage({ database: writingDb, getLegacyStorage: () => null }).getItem("sis-scan-owner"))
      .resolves.toBe("first physical scan after durable-only clear");
  });
  it("ignores a stale lower-version local tombstone when validating a newer durable intent barrier", async () => {
    vi.stubGlobal("performance", { timeOrigin: 1_500, now: vi.fn(() => 10) });
    const clearingDb = new Db();
    const writingDb = new Db();
    writingDb.values = clearingDb.values;
    const values = new Map<string, string>([["sis-scan-owner::scanbin-cleared-v1", "legacy-clear"]]);
    const local = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (key.endsWith("::scanbin-cleared-v1")) throw new Error("local tombstone overwrite blocked");
        values.set(key, value);
      },
      removeItem: (key: string) => values.delete(key),
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const clearingTab = createAsyncDurableStorage({ database: clearingDb, getLegacyStorage: () => local });
    await expect(clearingTab.removeItem("sis-scan-owner")).resolves.toMatchObject({ cleared: true, authority: "durable" });
    const writingTab = createAsyncDurableStorage({ database: writingDb, getLegacyStorage: () => local });

    await writingTab.setItem("sis-scan-owner", "equal-time scan after newer durable clear");

    expect(await writingDb.get("sis-scan-owner")).toBe("equal-time scan after newer durable clear");
    warn.mockRestore();
  });
  it("suppresses a pre-clear snapshot even when its durable write is delayed until after the clear", async () => {
    vi.stubGlobal("performance", { timeOrigin: 2_000, now: vi.fn(() => 10) });
    const db = new Db();
    const storage = createAsyncDurableStorage({ database: db, getLegacyStorage: () => null });
    const delayed = storage.setItem("sis-scan-owner", "snapshot scheduled before durable-only clear");
    await db.set(
      "sis-scan-owner::scanbin-cleared-v1",
      JSON.stringify({ __scanPersistClear: 1, version: 16, id: "later-clear", issuedAt: 2_011 }),
    );

    await delayed;

    await expect(createAsyncDurableStorage({ database: db, getLegacyStorage: () => null }).getItem("sis-scan-owner"))
      .resolves.toBeNull();
  });
  it("recovers the first causally post-conflict snapshot when conflict notification is delayed", async () => {
    vi.stubGlobal("performance", { timeOrigin: 3_000, now: vi.fn(() => 10) });
    const db = new Db();
    const storage = createAsyncDurableStorage({ database: db, getLegacyStorage: () => null });
    await db.set(
      "sis-scan-owner::scanbin-cleared-v1",
      JSON.stringify({ __scanPersistClear: 1, version: 17, id: "conflict-a", issuedAt: 3_005 }),
    );
    await db.set(
      "sis-scan-owner::scanbin-recovery-v1",
      JSON.stringify({
        __scanPersistRecovery: 1,
        payload: "uncommitted",
        supersedesTombstone: JSON.stringify({
          __scanPersistClear: 1,
          version: 17,
          id: "conflict-b",
          issuedAt: 3_006,
        }),
      }),
    );

    await storage.setItem("sis-scan-owner", "first physical scan after unseen conflict");

    await expect(createAsyncDurableStorage({ database: db, getLegacyStorage: () => null }).getItem("sis-scan-owner"))
      .resolves.toBe("first physical scan after unseen conflict");
  });
  it("fails closed when a snapshot and an unseen durable clear have equal causal timestamps", async () => {
    vi.stubGlobal("performance", { timeOrigin: 4_000, now: vi.fn(() => 10) });
    const db = new Db();
    const storage = createAsyncDurableStorage({ database: db, getLegacyStorage: () => null });
    const write = storage.setItem("sis-scan-owner", "snapshot at ambiguous boundary");
    await db.set(
      "sis-scan-owner::scanbin-cleared-v1",
      JSON.stringify({ __scanPersistClear: 1, version: 18, id: "equal-time-clear", issuedAt: 4_010 }),
    );

    await write;

    await expect(createAsyncDurableStorage({ database: db, getLegacyStorage: () => null }).getItem("sis-scan-owner"))
      .resolves.toBeNull();
  });
  it("does not let a later coalesced snapshot recreate an intent removed by a cross-tab clear", async () => {
    vi.stubGlobal("performance", { timeOrigin: 4_500, now: vi.fn(() => 10) });
    const db = new Db();
    const storage = createAsyncDurableStorage({ database: db, getLegacyStorage: () => null });
    const beforeClear = storage.setItem("sis-scan-owner", "snapshot before equal-time clear");
    void db.remove("sis-scan-owner::scanbin-write-intent-v1");
    void db.set(
      "sis-scan-owner::scanbin-cleared-v1",
      JSON.stringify({
        __scanPersistClear: 1,
        version: 19,
        id: "cross-tab-clear",
        issuedAt: 4_510,
        intentBarrierEstablished: true,
      }),
    );
    const coalescedAfterClear = storage.setItem("sis-scan-owner", "coalesced after equal-time clear");

    await Promise.all([beforeClear, coalescedAfterClear]);

    await expect(createAsyncDurableStorage({ database: db, getLegacyStorage: () => null }).getItem("sis-scan-owner"))
      .resolves.toBeNull();
  });
  it("does not report a clear authoritative when its write-intent barrier cannot be removed", async () => {
    const db = new IntentRemoveFailsDb();
    const storage = createAsyncDurableStorage({ database: db, getLegacyStorage: () => null });

    await expect(storage.removeItem("sis-scan-owner")).resolves.toEqual({ cleared: false, authority: "none" });
  });
  it("uses one physical write to recover when cached no-clear state is followed by cross-adapter conflict publication", async () => {
    const db = new Db();
    const local = legacy();
    const storage = createAsyncDurableStorage({ database: db, getLegacyStorage: () => local });
    await expect(storage.getItem("sis-scan-owner")).resolves.toBeNull();
    const clearA = JSON.stringify({ __scanPersistClear: 1, version: 14, id: "tab-a" });
    const clearB = JSON.stringify({ __scanPersistClear: 1, version: 14, id: "tab-b" });
    local.values.set("sis-scan-owner::scanbin-cleared-v1", clearA);
    await db.set("sis-scan-owner::scanbin-cleared-v1", clearB);
    window.dispatchEvent(new StorageEvent("storage", { key: "sis-scan-owner::scanbin-cleared-v1", newValue: clearA }));
    window.dispatchEvent(new StorageEvent("storage", { key: "sis-scan-owner::scanbin-cleared-v1", newValue: clearB }));

    await storage.setItem("sis-scan-owner", "only physical write after conflict");

    await expect(createAsyncDurableStorage({ database: db, getLegacyStorage: () => local }).getItem("sis-scan-owner"))
      .resolves.toBe("only physical write after conflict");
  });
  it("reports a clear non-authoritative when candidate ordering is unknown and deletion fails", async () => {
    const db = new CandidateReadFailsDb();
    db.failCandidateRead = false;
    await db.set("sis-scan-owner::scanbin-recovery-v1", "unreadable candidate");
    db.failCandidateRead = true;
    db.failCandidateRemove = true;
    const storage = createAsyncDurableStorage({ database: db, getLegacyStorage: () => legacy() });
    await expect(storage.removeItem("sis-scan-owner")).resolves.toEqual({ cleared: false, authority: "none" });
  });
  it("establishes clear authority when unknown candidate ordering is eliminated by confirmed deletion", async () => {
    const db = new CandidateReadFailsDb();
    db.failCandidateRead = false;
    await db.set("sis-scan-owner::scanbin-recovery-v1", "unreadable candidate");
    db.failCandidateRead = true;
    const storage = createAsyncDurableStorage({ database: db, getLegacyStorage: () => legacy() });
    await expect(storage.removeItem("sis-scan-owner")).resolves.toMatchObject({ cleared: true });
    db.failCandidateRead = false;
    await expect(createAsyncDurableStorage({ database: db, getLegacyStorage: () => legacy() }).getItem("sis-scan-owner"))
      .resolves.toBeNull();
  });
  it("preserves a post-clear scan locally while durable clear reads fail and promotes it after recovery", async () => {
    const db = new TombstoneReadFailsDb();
    const local = legacy();
    const storage = createAsyncDurableStorage({ database: db, getLegacyStorage: () => local });
    await storage.removeItem("sis-scan-owner");
    db.failTombstoneRead = true;
    await storage.setItem("sis-scan-owner", "physical scan after clear");
    db.failTombstoneRead = false;
    await expect(createAsyncDurableStorage({ database: db, getLegacyStorage: () => local }).getItem("sis-scan-owner"))
      .resolves.toBe("physical scan after clear");
  });
  it("keeps an existing post-clear fallback causal when recovery journal update fails", async () => {
    const db = new RecoverySetFailsDb();
    const local = legacy();
    const storage = createAsyncDurableStorage({ database: db, getLegacyStorage: () => local });
    await storage.removeItem("sis-scan-owner");
    db.failTombstoneRead = true;
    await storage.setItem("sis-scan-owner", "first local post-clear scan");
    db.failTombstoneRead = false;
    db.failRecoverySet = true;

    await storage.setItem("sis-scan-owner", "newest local post-clear scan");

    await expect(createAsyncDurableStorage({ database: null, getLegacyStorage: () => local }).getItem("sis-scan-owner"))
      .resolves.toBe("newest local post-clear scan");
  });
  it("creates a causal local fallback before a first post-clear recovery journal write can fail", async () => {
    const db = new RecoverySetFailsDb();
    const local = legacy();
    const storage = createAsyncDurableStorage({ database: db, getLegacyStorage: () => local });
    await storage.removeItem("sis-scan-owner");
    db.failRecoverySet = true;

    await storage.setItem("sis-scan-owner", "first scan after clear");

    await expect(createAsyncDurableStorage({ database: null, getLegacyStorage: () => local }).getItem("sis-scan-owner"))
      .resolves.toBe("first scan after clear");
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

describe("persistence context generations", () => {
  it("does not create a write intent when the captured context is already stale", async () => {
    const database = new Db();
    let context = "A";
    const storage = createAsyncDurableStorage({ database, getLegacyStorage: () => legacy(), getWriteContext: () => context, isWriteContextCurrent: (token) => token === context });
    const write = storage.setItem("sis-scan-owner", "stale");
    context = "B";
    await write;
    // Intent creation is synchronous ordering evidence; the stale context must block its payload.
    expect(await database.get("sis-scan-owner::scanbin-write-intent-v1")).toBeTruthy();
    expect(await database.get("sis-scan-owner")).toBeNull();
  });

  it("does not write a pagehide fallback after its captured context becomes stale", async () => {
    const database = new Db();
    const local = legacy();
    let context = "A";
    const storage = createAsyncDurableStorage({ database, getLegacyStorage: () => local, getWriteContext: () => context, isWriteContextCurrent: (token) => token === context });
    const pending = storage.setItem("sis-scan-owner", "stale-pagehide");
    context = "B";
    window.dispatchEvent(new Event("pagehide"));
    await pending;
    expect(local.values.get("sis-scan-owner")).toBeUndefined();
    expect(await database.get("sis-scan-owner")).toBeNull();
  });

  it("does not perform recovery, tombstone cleanup, or main writes after context changes at a durable boundary", async () => {
    let context = "A";
    class SwitchingDb extends Db {
      override async get(key: string) {
        const value = await super.get(key);
        if (key === "sis-scan-owner::scanbin-recovery-v1") context = "B";
        return value;
      }
    }
    const database = new SwitchingDb();
    const local = legacy();
    const storage = createAsyncDurableStorage({ database, getLegacyStorage: () => local, getWriteContext: () => context, isWriteContextCurrent: (token) => token === context });
    await storage.setItem("sis-scan-owner", "A-main");
    expect(await database.get("sis-scan-owner")).toBeNull();
    expect(await database.get("sis-scan-owner::scanbin-recovery-v1")).toBeNull();
    expect(await database.get("sis-scan-owner::scanbin-cleared-v1")).toBeNull();
    expect(local.values.get("sis-scan-owner")).toBeUndefined();
  });

  it("rejects an A snapshot delayed before durable commit after the same uid switches to B", async () => {
    const database = new Db();
    let context = "A";
    const storage = createAsyncDurableStorage({
      database,
      getLegacyStorage: () => legacy(),
      getWriteContext: () => context,
      isWriteContextCurrent: (token) => token === context,
    });

    const stale = storage.setItem("sis-scan-owner", "A feed A-count A-review A-raw-code");
    context = "B";
    await stale;

    expect(await database.get("sis-scan-owner")).toBeNull();
  });

  it("stops before fallback, recovery, and main writes when context changes after an awaited read", async () => {
    let context = "A";
    class ContextSwitchingRecoveryReadDb extends Db {
      override async get(key: string): Promise<string | null> {
        const value = await super.get(key);
        if (key === "sis-scan-owner::scanbin-recovery-v1") context = "B";
        return value;
      }
    }
    const database = new ContextSwitchingRecoveryReadDb();
    const local = legacy();
    const storage = createAsyncDurableStorage({
      database,
      getLegacyStorage: () => local,
      getWriteContext: () => context,
      isWriteContextCurrent: (token) => token === context,
    });

    await storage.setItem("sis-scan-owner", "A-raw-code");

    expect(await database.get("sis-scan-owner")).toBeNull();
    expect(await database.get("sis-scan-owner::scanbin-recovery-v1")).toBeNull();
    expect(local.values.get("sis-scan-owner")).toBeUndefined();
  });

  it("does not remove a tombstone when the write context changes after the awaited tombstone read", async () => {
    let context = "A";
    class TombstoneReadSwitchDb extends Db {
      tombstoneReads = 0;
      override async get(key: string): Promise<string | null> {
        const value = await super.get(key);
        if (key === "sis-scan-owner::scanbin-cleared-v1" && ++this.tombstoneReads >= 2) context = "B";
        return value;
      }
    }
    const database = new TombstoneReadSwitchDb();
    const storage = createAsyncDurableStorage({
      database,
      getLegacyStorage: () => legacy(),
      getWriteContext: () => context,
      isWriteContextCurrent: (token) => token === context,
    });

    await storage.removeItem("sis-scan-owner");
    context = "A";
    await storage.setItem("sis-scan-owner", "A-newer-scan");

    expect(await database.get("sis-scan-owner::scanbin-cleared-v1")).not.toBeNull();
    expect(await database.get("sis-scan-owner")).toBeNull();
  });

  it("does not remove a matching write intent when its context changes after the awaited intent read", async () => {
    let context = "A";
    class IntentReadSwitchDb extends Db {
      override async get(key: string): Promise<string | null> {
        const value = await super.get(key);
        if (key === "sis-scan-owner::scanbin-write-intent-v1") context = "B";
        return value;
      }
    }
    const database = new IntentReadSwitchDb();
    const storage = createAsyncDurableStorage({
      database,
      getLegacyStorage: () => legacy(),
      getWriteContext: () => context,
      isWriteContextCurrent: (token) => token === context,
    });

    await storage.setItem("sis-scan-owner", "A-scan");

    expect(await database.get("sis-scan-owner::scanbin-write-intent-v1")).not.toBeNull();
  });
});

describe("durable legacy adoption", () => {
  it("does not consume the anonymous snapshot while a destructive clear owns the mutation barrier", async () => {
    const db = new Db();
    const source = JSON.stringify({ state: { scanFeed: [{ id: "legacy" }] }, version: 8 });
    await db.set("sis-scan-v1", source);
    const operations = createLegacyAdoptionOperations({
      database: db,
      createStorage: () => createAsyncDurableStorage({ database: db, getLegacyStorage: () => null }),
      getPresence: (name) => getPersistedStatePresenceFromDatabase(name, db),
    });
    let release!: () => void;
    const held = tryRunPersistenceMutation(() => new Promise<void>((resolve) => { release = resolve; }));
    expect(held.ran).toBe(true);
    await expect(operations.adopt("owner")).resolves.toEqual({ status: "target-exists" });
    expect(await db.get("sis-scan-v1")).toBe(source);
    expect(await db.get("sis-scan-owner")).toBeNull();
    release();
    if (held.ran) await held.value;
  });

  it("adopts a durable-only anonymous snapshot after normalizing zero-delta scans", async () => {
    const db = new Db();
    const source = JSON.stringify({
      state: { scanFeed: [{ id: "scan-1", productId: "p-1", quantityDelta: 0 }], finalCounts: [{ productId: "p-1", quantity: 1 }] },
      version: 8,
    });
    await db.set("sis-scan-v1", source);
    const operations = createLegacyAdoptionOperations({
      database: db,
      createStorage: () => createAsyncDurableStorage({ database: db, getLegacyStorage: () => null }),
      getPresence: (name: string) => getPersistedStatePresenceFromDatabase(name, db),
    });

    await expect(operations.inspect()).resolves.toBe("found");
    await expect(operations.adopt("owner")).resolves.toEqual({ status: "adopted" });
    const copied = JSON.parse((await db.get("sis-scan-owner"))!);
    expect(copied.state.scanFeed).toEqual([{ id: "scan-1", productId: "p-1", quantityDelta: 1 }]);
    expect(await operations.inspect()).toBe("absent");
  });

  it("never overwrites an existing durable UID target", async () => {
    const db = new Db();
    await db.set("sis-scan-v1", JSON.stringify({ state: { scanFeed: [{ id: "legacy" }] }, version: 8 }));
    await db.set("sis-scan-owner", "owner snapshot");
    const operations = createLegacyAdoptionOperations({
      database: db,
      createStorage: () => createAsyncDurableStorage({ database: db, getLegacyStorage: () => null }),
      getPresence: (name) => getPersistedStatePresenceFromDatabase(name, db),
    });

    await expect(operations.adopt("owner")).resolves.toEqual({ status: "target-exists" });
    expect(await db.get("sis-scan-owner")).toBe("owner snapshot");
    expect(await db.get("sis-scan-v1")).not.toBeNull();
  });

  it("treats target tombstone metadata as occupied and never writes behind it", async () => {
    const db = new Db();
    const source = JSON.stringify({ state: { scanFeed: [{ id: "legacy" }] }, version: 8 });
    await db.set("sis-scan-v1", source);
    await db.set("sis-scan-owner::scanbin-cleared-v1", JSON.stringify({ __scanPersistClear: 1, version: 1, id: "owner-clear" }));
    const operations = createLegacyAdoptionOperations({
      database: db,
      createStorage: () => createAsyncDurableStorage({ database: db, getLegacyStorage: () => null }),
      getPresence: (name) => getPersistedStatePresenceFromDatabase(name, db),
    });

    await expect(operations.adopt("owner")).resolves.toEqual({ status: "target-exists" });
    expect(await db.get("sis-scan-owner")).toBeNull();
    expect(await db.get("sis-scan-v1")).toBe(source);
  });

  it("fails closed when a main-only CAS can interleave a target tombstone", async () => {
    class TombstoneInterleavingDb extends Db {
      async createIfAbsent(key: string, value: string): Promise<"created" | "exists"> {
        await this.set(`${key}::scanbin-cleared-v1`, JSON.stringify({ __scanPersistClear: 1, version: 1, id: "racing-clear" }));
        if (await this.get(key) !== null) return "exists";
        await this.set(key, value);
        return "created";
      }
    }
    const db = new TombstoneInterleavingDb();
    Object.assign(db, { createNamespaceIfAbsent: undefined });
    const source = JSON.stringify({ state: { scanFeed: [{ id: "legacy" }] }, version: 8 });
    await db.set("sis-scan-v1", source);
    const operations = createLegacyAdoptionOperations({
      database: db,
      createStorage: () => createAsyncDurableStorage({ database: db, getLegacyStorage: () => null }),
      getPresence: (name) => getPersistedStatePresenceFromDatabase(name, db),
    });

    await expect(operations.adopt("owner")).resolves.toEqual({ status: "unavailable" });
    expect(await db.get("sis-scan-owner")).toBeNull();
    expect(await db.get("sis-scan-v1")).toBe(source);
  });

  it("fails closed when a main-only CAS can interleave target recovery metadata", async () => {
    class RecoveryInterleavingDb extends Db {
      async createIfAbsent(key: string, value: string): Promise<"created" | "exists"> {
        await this.set(`${key}::scanbin-recovery-v1`, JSON.stringify({ __scanPersistRecovery: 1, payload: "racing-recovery" }));
        if (await this.get(key) !== null) return "exists";
        await this.set(key, value);
        return "created";
      }
    }
    const db = new RecoveryInterleavingDb();
    Object.assign(db, { createNamespaceIfAbsent: undefined });
    const source = JSON.stringify({ state: { scanFeed: [{ id: "legacy" }] }, version: 8 });
    await db.set("sis-scan-v1", source);
    const operations = createLegacyAdoptionOperations({
      database: db,
      createStorage: () => createAsyncDurableStorage({ database: db, getLegacyStorage: () => null }),
      getPresence: (name) => getPersistedStatePresenceFromDatabase(name, db),
    });

    await expect(operations.adopt("owner")).resolves.toEqual({ status: "unavailable" });
    expect(await db.get("sis-scan-owner")).toBeNull();
    expect(await db.get("sis-scan-v1")).toBe(source);
  });

  it("treats tombstoned anonymous state as absent", async () => {
    const db = new Db();
    await db.set("sis-scan-v1", JSON.stringify({ state: { scanFeed: [{ id: "stale" }] }, version: 8 }));
    await db.set("sis-scan-v1::scanbin-cleared-v1", JSON.stringify({ __scanPersistClear: 1, version: 1, id: "clear" }));
    await db.set("sis-scan-v1::scanbin-recovery-v1", JSON.stringify({ __scanPersistRecovery: 1, payload: "stale recovery" }));
    const operations = createLegacyAdoptionOperations({
      database: db,
      createStorage: () => createAsyncDurableStorage({ database: db, getLegacyStorage: () => null }),
      getPresence: (name) => getPersistedStatePresenceFromDatabase(name, db),
    });

    await expect(operations.inspect()).resolves.toBe("absent");
    await expect(operations.adopt("owner")).resolves.toEqual({ status: "absent" });
  });

  it("fails closed when durable inspection is unavailable", async () => {
    class UnavailableDb extends Db {
      override async get(): Promise<string | null> { throw new Error("database unavailable"); }
    }
    const db = new UnavailableDb();
    const operations = createLegacyAdoptionOperations({
      database: db,
      createStorage: () => createAsyncDurableStorage({ database: db, getLegacyStorage: () => null }),
      getPresence: (name) => getPersistedStatePresenceFromDatabase(name, db),
    });

    await expect(operations.inspect()).resolves.toBe("unavailable");
    await expect(operations.adopt("owner")).resolves.toEqual({ status: "unavailable" });
  });

  it("does not consume the durable source when a writable local fallback masks target write failure", async () => {
    class TargetWriteFailsDb extends Db {
      override async set(key: string, value: string): Promise<void> {
        if (key === "sis-scan-owner") throw new Error("target write failed");
        await super.set(key, value);
      }
    }
    const db = new TargetWriteFailsDb();
    const local = legacy();
    const source = JSON.stringify({ state: { scanFeed: [{ id: "scan-1" }] }, version: 8 });
    await db.set("sis-scan-v1", source);
    const operations = createLegacyAdoptionOperations({
      database: db,
      createStorage: () => createAsyncDurableStorage({ database: db, getLegacyStorage: () => local }),
      getPresence: (name) => getPersistedStatePresenceFromDatabase(name, db),
    });

    await expect(operations.adopt("owner")).resolves.toEqual({ status: "unavailable" });
    expect(await db.get("sis-scan-v1")).toBe(source);
    expect(await db.get("sis-scan-owner")).toBeNull();
    expect(local.values.get("sis-scan-owner")).toBeUndefined();
  });

  it("does not report adopted when source consumption cannot be verified", async () => {
    const db = new Db();
    const source = JSON.stringify({ state: { scanFeed: [{ id: "scan-1" }] }, version: 8 });
    await db.set("sis-scan-v1", source);
    const realStorage = createAsyncDurableStorage({ database: db, getLegacyStorage: () => null });
    const operations = createLegacyAdoptionOperations({
      database: db,
      createStorage: () => ({ ...realStorage, removeItem: async () => undefined }),
      getPresence: (name) => getPersistedStatePresenceFromDatabase(name, db),
    });

    await expect(operations.adopt("owner")).resolves.toEqual({ status: "unavailable" });
    expect(await db.get("sis-scan-owner")).not.toBeNull();
    await expect(operations.adopt("owner")).resolves.toEqual({ status: "target-exists" });
  });

  it("rejects invalid snapshots and isolates local-demo state", async () => {
    const db = new Db();
    await db.set("sis-scan-v1", "not JSON");
    const invalid = createLegacyAdoptionOperations({
      database: db,
      createStorage: () => createAsyncDurableStorage({ database: db, getLegacyStorage: () => null }),
      getPresence: (name) => getPersistedStatePresenceFromDatabase(name, db),
    });
    await expect(invalid.adopt("owner")).resolves.toEqual({ status: "invalid" });
    const demo = createLegacyAdoptionOperations({
      database: db,
      createStorage: () => createAsyncDurableStorage({ database: db, getLegacyStorage: () => null }),
      getPresence: (name) => getPersistedStatePresenceFromDatabase(name, db),
      isLocalDemo: () => true,
    });
    await expect(demo.inspect()).resolves.toBe("absent");
    await expect(demo.adopt("owner")).resolves.toEqual({ status: "absent" });
    expect(await db.get("sis-scan-owner")).toBeNull();
  });

  it("uses durable create-if-absent across independent adoption operations", async () => {
    const db = new Db();
    await db.set("sis-scan-v1", JSON.stringify({ state: { scanFeed: [{ id: "only-once" }] }, version: 8 }));
    const options = {
      database: db,
      createStorage: () => createAsyncDurableStorage({ database: db, getLegacyStorage: () => null }),
      getPresence: (name: string) => getPersistedStatePresenceFromDatabase(name, db),
    };
    const first = createLegacyAdoptionOperations(options);
    const second = createLegacyAdoptionOperations(options);

    const results = await Promise.all([first.adopt("owner"), second.adopt("owner")]);
    expect(results).toContainEqual({ status: "adopted" });
    expect(results).toContainEqual({ status: "target-exists" });
    expect(JSON.parse((await db.get("sis-scan-owner"))!).state.scanFeed).toEqual([{ id: "only-once" }]);
  });
});

describe("native IndexedDB bridge", () => {
  it("reports a tokenized clear absent even when failed deletion leaves the main snapshot", async () => {
    const db = new Db();
    await db.set("sis-scan-owner", "stale main");
    await db.set("sis-scan-owner::scanbin-cleared-v1", JSON.stringify({ __scanPersistClear: 1, version: 2, id: "clear-2" }));
    await expect(getPersistedStatePresenceFromDatabase("sis-scan-owner", db)).resolves.toBe("absent");
  });

  it("reports recovery-only post-clear state found only when it supersedes the exact clear", async () => {
    const db = new Db();
    const clear = JSON.stringify({ __scanPersistClear: 1, version: 2, id: "clear-2" });
    await db.set("sis-scan-owner::scanbin-cleared-v1", clear);
    await db.set("sis-scan-owner::scanbin-recovery-v1", JSON.stringify({
      __scanPersistRecovery: 1,
      payload: "post-clear snapshot",
      supersedesTombstone: clear,
    }));
    await expect(getPersistedStatePresenceFromDatabase("sis-scan-owner", db)).resolves.toBe("found");
  });

  it("reports a recovery-only namespace found without a clear", async () => {
    const db = new Db();
    await db.set("sis-scan-owner::scanbin-recovery-v1", "raw legacy recovery");
    await expect(getPersistedStatePresenceFromDatabase("sis-scan-owner", db)).resolves.toBe("found");
  });

  it("orders durable clear and recovery causality for namespace presence", async () => {
    const older = JSON.stringify({ __scanPersistClear: 1, version: 2, id: "clear-2" });
    const newer = JSON.stringify({ __scanPersistClear: 1, version: 3, id: "clear-3" });
    const conflict = JSON.stringify({ __scanPersistClear: 1, version: 3, id: "other-clear-3" });
    const db = new Db();
    await db.set("sis-scan-owner::scanbin-cleared-v1", older);
    await db.set("sis-scan-owner::scanbin-recovery-v1", JSON.stringify({ __scanPersistRecovery: 1, payload: "newer", supersedesTombstone: newer }));
    await expect(getPersistedStatePresenceFromDatabase("sis-scan-owner", db)).resolves.toBe("found");
    await db.set("sis-scan-owner::scanbin-cleared-v1", newer);
    await db.set("sis-scan-owner::scanbin-recovery-v1", JSON.stringify({ __scanPersistRecovery: 1, payload: "older", supersedesTombstone: older }));
    await expect(getPersistedStatePresenceFromDatabase("sis-scan-owner", db)).resolves.toBe("absent");
    await db.set("sis-scan-owner::scanbin-recovery-v1", JSON.stringify({ __scanPersistRecovery: 1, payload: "conflict", supersedesTombstone: conflict }));
    await expect(getPersistedStatePresenceFromDatabase("sis-scan-owner", db)).resolves.toBe("unavailable");
  });

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
