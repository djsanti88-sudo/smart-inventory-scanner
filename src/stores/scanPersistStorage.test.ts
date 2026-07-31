import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createAsyncDurableStorage,
  createCoalescedFailSoftStorage,
  type AsyncKeyValueDatabase,
} from "@/stores/scanPersistStorage";

// QA finding #16 (critical, CONTAINED MITIGATION): scanStore.ts used a plain
// createJSONStorage(() => localStorage) with NO quota guard, so near the ~5MB quota a
// throwing setItem propagated synchronously out of set() inside processScan and bricked
// the /scan page (fresh tab still broken until localStorage is cleared). The mitigation is a
// storage wrapper that (a) fails SOFT on any setItem throw (never propagates), (b) COALESCES
// the ~6 writes-per-scan into at most one real setItem per tick, and (c) FLUSHES synchronously
// on pagehide / visibilitychange(hidden) so a scan-then-close never loses the last write.
// These tests exercise that wrapper in isolation (no store), the pure/testable seam.

// A fake in-memory backing storage so we can count and control setItem precisely.
function makeBacking() {
  const map = new Map<string, string>();
  const setItem = vi.fn((name: string, value: string) => {
    map.set(name, value);
  });
  const getItem = vi.fn((name: string) => (map.has(name) ? map.get(name)! : null));
  const removeItem = vi.fn((name: string) => {
    map.delete(name);
  });
  return { map, setItem, getItem, removeItem, storage: { setItem, getItem, removeItem } };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createCoalescedFailSoftStorage - quota fail-soft (the de-brick)", () => {
  it("a setItem that throws QuotaExceededError does NOT propagate (fails soft, warns)", () => {
    const backing = makeBacking();
    backing.setItem.mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = createCoalescedFailSoftStorage(() => backing.storage);

    store.setItem("sis-scan-v1", "{}");
    // The write is coalesced; force the flush and assert it never throws.
    expect(() => store.flush()).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });

  it("getItem / removeItem pass straight through to the backing storage", () => {
    const backing = makeBacking();
    backing.map.set("sis-scan-v1", "hello");
    const store = createCoalescedFailSoftStorage(() => backing.storage);
    expect(store.getItem("sis-scan-v1")).toBe("hello");
    store.removeItem("sis-scan-v1");
    expect(backing.removeItem).toHaveBeenCalledWith("sis-scan-v1");
    expect(backing.map.has("sis-scan-v1")).toBe(false);
  });
});

describe("createCoalescedFailSoftStorage - write coalescing (reduce amplification)", () => {
  it("six rapid setItem calls in one tick flush as at most ONE real backing write (latest value wins)", () => {
    const backing = makeBacking();
    const store = createCoalescedFailSoftStorage(() => backing.storage);

    for (let i = 0; i < 6; i++) store.setItem("sis-scan-v1", `v${i}`);
    // Nothing written yet - all coalesced.
    expect(backing.setItem).not.toHaveBeenCalled();

    store.flush();
    expect(backing.setItem).toHaveBeenCalledTimes(1);
    expect(backing.setItem).toHaveBeenLastCalledWith("sis-scan-v1", "v5"); // latest value
  });

  it("a second burst after a flush produces a second single write (not unbounded)", () => {
    const backing = makeBacking();
    const store = createCoalescedFailSoftStorage(() => backing.storage);

    store.setItem("sis-scan-v1", "a");
    store.setItem("sis-scan-v1", "b");
    store.flush();
    store.setItem("sis-scan-v1", "c");
    store.flush();

    expect(backing.setItem).toHaveBeenCalledTimes(2);
    expect(backing.setItem).toHaveBeenLastCalledWith("sis-scan-v1", "c");
  });

  it("perf-sanity: real backing writes per 'scan' stay ~1 regardless of how many scans accumulate (not super-linear)", () => {
    const backing = makeBacking();
    const store = createCoalescedFailSoftStorage(() => backing.storage);
    // Simulate 50 scans, each firing the ~6 set() calls a real processScan does, each flushed per tick.
    const SCANS = 50;
    for (let scan = 0; scan < SCANS; scan++) {
      for (let w = 0; w < 6; w++) store.setItem("sis-scan-v1", `scan${scan}-w${w}`);
      store.flush(); // one tick boundary per scan
    }
    // Without coalescing this would be 50*6 = 300 writes; coalesced it is exactly one per scan.
    expect(backing.setItem).toHaveBeenCalledTimes(SCANS);
  });

  it("the scheduled timer flush also collapses a burst to one write (no explicit flush needed)", () => {
    const backing = makeBacking();
    const store = createCoalescedFailSoftStorage(() => backing.storage);
    store.setItem("sis-scan-v1", "x");
    store.setItem("sis-scan-v1", "y");
    vi.runAllTimers(); // let the scheduled coalesced flush fire
    expect(backing.setItem).toHaveBeenCalledTimes(1);
    expect(backing.setItem).toHaveBeenLastCalledWith("sis-scan-v1", "y");
  });
});

describe("createCoalescedFailSoftStorage - flush on pagehide / visibilitychange (no data loss)", () => {
  it("a pending coalesced write is flushed synchronously on 'pagehide' (before the tick fires)", () => {
    const backing = makeBacking();
    const store = createCoalescedFailSoftStorage(() => backing.storage);
    store.setItem("sis-scan-v1", "latest");
    expect(backing.setItem).not.toHaveBeenCalled(); // still pending

    window.dispatchEvent(new Event("pagehide"));
    expect(backing.setItem).toHaveBeenCalledTimes(1);
    expect(backing.setItem).toHaveBeenLastCalledWith("sis-scan-v1", "latest");
  });

  it("a pending coalesced write is flushed when the document becomes hidden (visibilitychange)", () => {
    const backing = makeBacking();
    const store = createCoalescedFailSoftStorage(() => backing.storage);
    store.setItem("sis-scan-v1", "latest2");

    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(backing.setItem).toHaveBeenCalledTimes(1);
    expect(backing.setItem).toHaveBeenLastCalledWith("sis-scan-v1", "latest2");
  });
});

class DeferredMemoryDatabase implements AsyncKeyValueDatabase {
  readonly values = new Map<string, string>();
  failWrites = false;

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    if (this.failWrites) throw new DOMException("Private mode", "InvalidStateError");
    this.values.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }
}

class SlowWriteDatabase extends DeferredMemoryDatabase {
  private releaseWrite: (() => void) | null = null;
  private resume: (() => void) | null = null;
  readonly writeStarted = new Promise<void>((resolve) => { this.releaseWrite = resolve; });
  private readonly continueWrite = new Promise<void>((resolve) => { this.resume = resolve; });

  override async set(key: string, value: string): Promise<void> {
    this.releaseWrite?.();
    await this.continueWrite;
    await super.set(key, value);
  }

  finishWrite(): void {
    this.resume?.();
  }
}

describe("createAsyncDurableStorage - versioned localStorage read-through", () => {
  it("moves a pre-IndexedDB uid blob into durable storage without changing its bytes", async () => {
    const legacy = makeBacking();
    const durable = new DeferredMemoryDatabase();
    const oldBlob = JSON.stringify({ state: { scanFeed: [{ id: "physical-scan-1" }], finalCounts: [{ productId: "p1", quantity: 1 }] }, version: 14 });
    legacy.map.set("sis-scan-owner", oldBlob);
    const storage = createAsyncDurableStorage({
      database: durable,
      getLegacyStorage: () => legacy.storage,
    });

    await expect(storage.getItem("sis-scan-owner")).resolves.toBe(oldBlob);
    await expect(durable.get("sis-scan-owner")).resolves.toBe(oldBlob);
  });

  it("keeps the current durable snapshot when a stale localStorage copy remains", async () => {
    const legacy = makeBacking();
    const durable = new DeferredMemoryDatabase();
    legacy.map.set("sis-scan-owner", "old-snapshot");
    await durable.set("sis-scan-owner", "new-snapshot");
    const storage = createAsyncDurableStorage({ database: durable, getLegacyStorage: () => legacy.storage });

    await expect(storage.getItem("sis-scan-owner")).resolves.toBe("new-snapshot");
  });

  it("reports degraded storage and resolves writes when IndexedDB rejects, leaving scans usable in memory", async () => {
    const legacy = makeBacking();
    const durable = new DeferredMemoryDatabase();
    durable.failWrites = true;
    const statuses: string[] = [];
    const storage = createAsyncDurableStorage({
      database: durable,
      getLegacyStorage: () => legacy.storage,
      onStatusChange: (status) => statuses.push(status),
    });

    await expect(storage.setItem("sis-scan-owner", "latest-scan")).resolves.toBeUndefined();
    expect(statuses).toContain("degraded");
    expect(legacy.map.get("sis-scan-owner")).toBe("latest-scan");
  });

  it("clear is authoritative across durable and local legacy copies", async () => {
    const legacy = makeBacking();
    const durable = new DeferredMemoryDatabase();
    legacy.map.set("sis-local-demo-scan-v1", "legacy-demo");
    await durable.set("sis-local-demo-scan-v1", "durable-demo");
    const storage = createAsyncDurableStorage({ database: durable, getLegacyStorage: () => legacy.storage });

    await storage.removeItem("sis-local-demo-scan-v1");
    await expect(durable.get("sis-local-demo-scan-v1")).resolves.toBeNull();
    expect(legacy.map.has("sis-local-demo-scan-v1")).toBe(false);
  });

  it("does not let a slower earlier write resurrect data after clear", async () => {
    const legacy = makeBacking();
    const durable = new SlowWriteDatabase();
    const storage = createAsyncDurableStorage({ database: durable, getLegacyStorage: () => legacy.storage });

    const write = storage.setItem("sis-scan-owner", "scan-before-clear");
    await durable.writeStarted;
    const clear = storage.removeItem("sis-scan-owner");
    durable.finishWrite();
    await Promise.all([write, clear]);

    await expect(durable.get("sis-scan-owner")).resolves.toBeNull();
    expect(legacy.map.has("sis-scan-owner")).toBe(false);
  });
});
