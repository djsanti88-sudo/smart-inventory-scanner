import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createAsyncCoalescedFailSoftPersistStorage,
  decodeLegacyStamped,
  encodeLegacyStamped,
} from "./scanPersistStorage";
import type { AsyncBacking } from "./idbBacking";

const stampKey = (name: string) => `${name}::stamp`;

/** P7: localStorage now holds blob+stamp as ONE atomic `sisv1:<stamp>:<raw>` value, so assertions
 *  read through the decoder instead of assuming the raw blob sits there bare. Pre-envelope plain
 *  values still decode (stamp comes from the sibling key), which is what back-compat means here. */
function readLegacyBlob(data: Map<string, string>, name: string): unknown {
  const decoded = decodeLegacyStamped(data.get(name) ?? null);
  return decoded.raw === null ? null : JSON.parse(decoded.raw);
}
function readLegacyStamp(data: Map<string, string>, name: string): number {
  const decoded = decodeLegacyStamped(data.get(name) ?? null);
  if (decoded.stamp !== null) return decoded.stamp;
  return Number(data.get(stampKey(name)) ?? 0);
}

function makeFakeBacking(overrides: Partial<AsyncBacking> = {}) {
  const data = new Map<string, string>();
  const backing: AsyncBacking = {
    getItem: vi.fn(async (n: string) => data.get(n) ?? null),
    setItem: vi.fn(async (n: string, v: string) => { data.set(n, v); }),
    removeItem: vi.fn(async (n: string) => { data.delete(n); }),
    ...overrides,
  };
  return { backing, data };
}

const VALUE = { state: { scanFeed: [{ id: "s1" }] }, version: 7 };

describe("createAsyncCoalescedFailSoftPersistStorage", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces a burst of setItem calls into one backing write", async () => {
    const { backing } = makeFakeBacking();
    const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing);
    for (let i = 0; i < 6; i++) storage.setItem("sis-scan-v1", { ...VALUE, version: i });
    await vi.runAllTimersAsync();
    // Adapted (review round 2): a successful write now also writes the sibling `::stamp` key that
    // makes cross-store ordering decidable (B1), so count writes of the BLOB key - the coalescing
    // guarantee this test exists for (one stringify + one blob write per tick) is unchanged.
    const blobWrites = (backing.setItem as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([n]) => n === "sis-scan-v1",
    );
    expect(blobWrites).toHaveLength(1);
    expect(JSON.parse(blobWrites[0][1]).version).toBe(5);
  });

  it("swallows backing write rejection (fail-soft, warns, never throws)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { backing } = makeFakeBacking({ setItem: vi.fn(async () => { throw new Error("quota"); }) });
    const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing);
    storage.setItem("sis-scan-v1", VALUE);
    await vi.runAllTimersAsync();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("getItem returns parsed value from the async backing", async () => {
    const { backing, data } = makeFakeBacking();
    data.set("sis-scan-v1", JSON.stringify(VALUE));
    const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing);
    await expect(storage.getItem("sis-scan-v1")).resolves.toEqual(VALUE);
  });

  it("migrates from legacy storage on IDB miss and clears legacy only after copy succeeds", async () => {
    const { backing, data } = makeFakeBacking();
    const legacy = {
      getItem: vi.fn(() => JSON.stringify(VALUE)),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing, { migrateFrom: legacy });
    await expect(storage.getItem("sis-scan-v1")).resolves.toEqual(VALUE);
    await vi.runAllTimersAsync();
    expect(data.get("sis-scan-v1")).toBe(JSON.stringify(VALUE)); // copied into IDB
    expect(legacy.removeItem).toHaveBeenCalledWith("sis-scan-v1"); // cleared AFTER copy
  });

  it("does NOT clear legacy storage when the migration copy fails", async () => {
    const legacy = { getItem: vi.fn(() => JSON.stringify(VALUE)), setItem: vi.fn(), removeItem: vi.fn() };
    const { backing } = makeFakeBacking({ setItem: vi.fn(async () => { throw new Error("idb down"); }) });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing, { migrateFrom: legacy });
    await storage.getItem("sis-scan-v1");
    await vi.runAllTimersAsync();
    expect(legacy.removeItem).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("removeItem cancels the pending write and removes from backing AND legacy", async () => {
    const { backing } = makeFakeBacking();
    const legacy = { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() };
    const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing, { migrateFrom: legacy });
    storage.setItem("sis-scan-u1", VALUE);
    storage.removeItem("sis-scan-u1");
    await vi.runAllTimersAsync();
    expect(backing.setItem).not.toHaveBeenCalled(); // pending write cancelled
    expect(backing.removeItem).toHaveBeenCalledWith("sis-scan-u1");
    expect(legacy.removeItem).toHaveBeenCalledWith("sis-scan-u1");
  });

  // Defect #2: the legacy-migration copy runs outside the coalesce queue (getItem fires it directly),
  // so a same-key real write or a same-key removeItem racing an in-flight copy must never lose.
  describe("defect #2: migration writes never win a race against a same-key real write or removal", () => {
    function deferred<T>() {
      let resolve!: (v: T) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    it("a same-key real write always applies AFTER a slower in-flight legacy migration copy", async () => {
      const data = new Map<string, string>();
      const migrationGate = deferred<void>();
      let setItemCalls = 0;
      // Adapted (review round 2): writes now also stamp a sibling `::stamp` key, so "how many writes
      // happened" is counted on the BLOB key only - the ordering guarantee under test is unchanged.
      let blobWrites = 0;
      const backing: AsyncBacking = {
        getItem: vi.fn(async (n: string) => data.get(n) ?? null),
        setItem: vi.fn(async (n: string, v: string) => {
          setItemCalls += 1;
          if (n === "sis-scan-v1") blobWrites += 1;
          if (setItemCalls === 1) await migrationGate.promise; // the migration write: hold it open
          data.set(n, v);
        }),
        removeItem: vi.fn(async (n: string) => {
          data.delete(n);
        }),
      };
      const legacyValue = { state: { scanFeed: [{ id: "OLD" }] }, version: 7 };
      const legacy = {
        getItem: vi.fn(() => JSON.stringify(legacyValue)),
        setItem: vi.fn(),
        removeItem: vi.fn(),
      };
      const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing, { migrateFrom: legacy });

      // Kick off the migration copy (getItem miss on IDB -> legacy hit -> background copy started).
      await expect(storage.getItem("sis-scan-v1")).resolves.toEqual(legacyValue);

      // A genuinely fresher scan arrives and is coalesced into a real write for the SAME key while
      // the slower migration copy is still in flight.
      const freshValue = { state: { scanFeed: [{ id: "FRESH" }] }, version: 8 };
      storage.setItem("sis-scan-v1", freshValue);
      await vi.advanceTimersByTimeAsync(0); // let the coalesce timer fire; doWrite() starts awaiting the migration

      expect(blobWrites).toBe(1); // the real write must NOT have raced ahead of the migration write

      migrationGate.resolve(); // the slow migration write finally lands
      await vi.runAllTimersAsync();

      expect(blobWrites).toBe(2);
      expect(JSON.parse(data.get("sis-scan-v1")!)).toEqual(freshValue); // the real write is the final state
    });

    it("removeItem during an in-flight migration cancels it so the migration can never resurrect the removed key", async () => {
      const data = new Map<string, string>();
      const migrationGate = deferred<void>();
      const backing: AsyncBacking = {
        getItem: vi.fn(async (n: string) => data.get(n) ?? null),
        setItem: vi.fn(async (n: string, v: string) => {
          await migrationGate.promise;
          data.set(n, v);
        }),
        removeItem: vi.fn(async (n: string) => {
          data.delete(n);
        }),
      };
      const legacy = {
        getItem: vi.fn(() => JSON.stringify(VALUE)),
        setItem: vi.fn(),
        removeItem: vi.fn(),
      };
      const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing, { migrateFrom: legacy });

      await storage.getItem("sis-scan-v1"); // starts the in-flight migration copy (blocked on the gate)
      storage.removeItem("sis-scan-v1"); // e.g. sign-out wipe / "Clear local cache", races the migration

      migrationGate.resolve(); // the migration copy finally completes AFTER the removal was requested
      await vi.runAllTimersAsync();

      expect(data.has("sis-scan-v1")).toBe(false); // final state must be "removed", never resurrected
    });
  });

  // Defect #4: an optional onPersistFailure callback is surfaceable to callers (not wired into
  // scanStore/UI here - that is a different agent's file), and must never throw into the persist path.
  describe("defect #4: onPersistFailure", () => {
    it("is called with ('write', err) when a backing write is dropped, and a throwing callback never escapes", async () => {
      const { backing } = makeFakeBacking({
        setItem: vi.fn(async () => {
          throw new Error("quota");
        }),
      });
      const onPersistFailure = vi.fn(() => {
        throw new Error("callback boom");
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing, { onPersistFailure });
      expect(() => storage.setItem("sis-scan-v1", VALUE)).not.toThrow();
      await vi.runAllTimersAsync(); // if the throwing callback escaped, this await would reject/throw
      expect(onPersistFailure).toHaveBeenCalledWith("write", expect.any(Error));
      warn.mockRestore();
    });

    it("is called with ('migrate', err) when the background legacy copy fails", async () => {
      const { backing } = makeFakeBacking({
        setItem: vi.fn(async () => {
          throw new Error("idb down");
        }),
      });
      const legacy = { getItem: vi.fn(() => JSON.stringify(VALUE)), setItem: vi.fn(), removeItem: vi.fn() };
      const onPersistFailure = vi.fn();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing, { migrateFrom: legacy, onPersistFailure });
      await storage.getItem("sis-scan-v1");
      await vi.runAllTimersAsync();
      expect(onPersistFailure).toHaveBeenCalledWith("migrate", expect.any(Error));
      warn.mockRestore();
    });
  });

  // Defect #1b: backing selection upstream is only a feature-detect, so a backing that keeps failing
  // must stop being paid for. Since review round 2 this latch is a PERF short-circuit only (writes skip
  // the doomed IndexedDB round trip and go straight to localStorage); correctness comes from the write
  // stamps + write-through below, never from the latch.
  describe("backingBroken write short-circuit (defect #1b)", () => {
    function makeAlwaysFailingBacking(): AsyncBacking {
      return {
        getItem: vi.fn(async () => {
          throw new Error("idb dead");
        }),
        setItem: vi.fn(async () => {
          throw new Error("idb dead");
        }),
        removeItem: vi.fn(async () => {
          throw new Error("idb dead");
        }),
      };
    }

    function makeLegacySyncStorage() {
      const data = new Map<string, string>();
      return {
        data,
        storage: {
          getItem: vi.fn((n: string) => data.get(n) ?? null),
          setItem: vi.fn((n: string, v: string) => {
            data.set(n, v);
          }),
          removeItem: vi.fn((n: string) => {
            data.delete(n);
          }),
        },
      };
    }

    it("demotes after 3 consecutive backing failures, warns once, and calls onPersistFailure('demoted', ...) exactly once", async () => {
      const backing = makeAlwaysFailingBacking();
      const { storage: legacy, data: legacyData } = makeLegacySyncStorage();
      const onPersistFailure = vi.fn();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing, { migrateFrom: legacy, onPersistFailure });

      for (let i = 1; i <= 3; i++) {
        storage.setItem("sis-scan-v1", { ...VALUE, version: i });
        await vi.runAllTimersAsync();
      }

      expect(onPersistFailure.mock.calls.filter(([kind]) => kind === "demoted")).toHaveLength(1);

      // A further write must now bypass IndexedDB entirely (no retry) and land in the fallback.
      const callsBefore = (backing.setItem as ReturnType<typeof vi.fn>).mock.calls.length;
      storage.setItem("sis-scan-v1", { ...VALUE, version: 4 });
      await vi.runAllTimersAsync();
      expect((backing.setItem as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);
      expect((readLegacyBlob(legacyData, "sis-scan-v1") as { version: number }).version).toBe(4);

      warn.mockRestore();
    });

    // Adapted (review round 2, defect B1): reads are no longer routed by the latch. A fresh wrapper in
    // a NEW session cannot know which store the previous session ended up writing to, so getItem now
    // ALWAYS consults both stores and lets the write stamps decide. The behaviour that matters - a
    // latched/broken IndexedDB never costs the user their data - is what this test now asserts; the old
    // "IndexedDB is never consulted again" assertion described the bug (B1), not a guarantee worth keeping.
    it("getItem still returns the local-storage copy when every IndexedDB read fails", async () => {
      const backing = makeAlwaysFailingBacking();
      const { storage: legacy, data: legacyData } = makeLegacySyncStorage();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing, { migrateFrom: legacy });

      for (let i = 1; i <= 3; i++) {
        storage.setItem("sis-scan-v1", { ...VALUE, version: i });
        await vi.runAllTimersAsync();
      }
      legacyData.set("sis-scan-v1", JSON.stringify(VALUE));

      await expect(storage.getItem("sis-scan-v1")).resolves.toEqual(VALUE);

      warn.mockRestore();
    });

    it("a success resets the consecutive-failure counter (no demotion after 2 failures then a success)", async () => {
      let shouldFail = true;
      const backing: AsyncBacking = {
        getItem: vi.fn(async () => null),
        setItem: vi.fn(async () => {
          if (shouldFail) throw new Error("idb dead");
        }),
        removeItem: vi.fn(async () => undefined),
      };
      const { storage: legacy } = makeLegacySyncStorage();
      const onPersistFailure = vi.fn();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing, { migrateFrom: legacy, onPersistFailure });

      storage.setItem("sis-scan-v1", { ...VALUE, version: 1 });
      await vi.runAllTimersAsync();
      storage.setItem("sis-scan-v1", { ...VALUE, version: 2 });
      await vi.runAllTimersAsync();
      shouldFail = false; // the 3rd write succeeds, resetting the counter
      storage.setItem("sis-scan-v1", { ...VALUE, version: 3 });
      await vi.runAllTimersAsync();
      shouldFail = true;
      storage.setItem("sis-scan-v1", { ...VALUE, version: 4 });
      await vi.runAllTimersAsync();

      expect(onPersistFailure.mock.calls.filter(([kind]) => kind === "demoted")).toHaveLength(0);
      warn.mockRestore();
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Tier-3 review round 2 (2026-08-09). The counter-based demotion latch alone was NOT sufficient:
  //   B1 (HIGH, data loss): a demoted session writes to localStorage, but the NEXT session's fresh
  //       wrapper read IndexedDB first and returned its stale non-null blob (legacy was consulted
  //       only on an IDB MISS) - the newer localStorage data was shadowed and then overwritten.
  //   B2 (MEDIUM): the writes that TRIPPED the latch were dropped with no fallback, and the
  //       failure counter was reset by read/remove successes, so a write-only failure mode
  //       interleaved with reads could never latch.
  //   B3 (MEDIUM-LOW): removeItem's demoted early-return skipped migration cancellation, so an
  //       in-flight migration copy could resurrect a removed key.
  //   B5 (LOW): probeIdbBacking() was never wired.
  // The redesign replaces the counter machinery with two provable mechanisms: (1) per-store write
  // stamps + newest-wins hydration, (2) write-through to localStorage on ANY failed backing write.
  // ---------------------------------------------------------------------------------------------
  describe("B1: newest-wins hydration across the two stores (stale IDB can never shadow newer legacy)", () => {
    function makeLegacySync(seed: Record<string, string> = {}) {
      const data = new Map<string, string>(Object.entries(seed));
      return {
        data,
        storage: {
          getItem: vi.fn((n: string) => data.get(n) ?? null),
          setItem: vi.fn((n: string, v: string) => { data.set(n, v); }),
          removeItem: vi.fn((n: string) => { data.delete(n); }),
        },
      };
    }

    const OLD = { state: { scanFeed: [{ id: "OLD" }] }, version: 7 };
    const NEW = { state: { scanFeed: [{ id: "NEW" }] }, version: 8 };

    it("returns the NEWER-stamped legacy blob when IndexedDB holds an older stamped blob", async () => {
      const { backing, data } = makeFakeBacking();
      data.set("sis-scan-v1", JSON.stringify(OLD));
      data.set(stampKey("sis-scan-v1"), "1000");
      const { storage: legacy } = makeLegacySync({
        "sis-scan-v1": JSON.stringify(NEW),
        [stampKey("sis-scan-v1")]: "2000",
      });
      const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing, { migrateFrom: legacy });
      await expect(storage.getItem("sis-scan-v1")).resolves.toEqual(NEW);
    });

    it("returns the NEWER-stamped IndexedDB blob when legacy holds an older stamped blob", async () => {
      const { backing, data } = makeFakeBacking();
      data.set("sis-scan-v1", JSON.stringify(NEW));
      data.set(stampKey("sis-scan-v1"), "2000");
      const { storage: legacy } = makeLegacySync({
        "sis-scan-v1": JSON.stringify(OLD),
        [stampKey("sis-scan-v1")]: "1000",
      });
      const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing, { migrateFrom: legacy });
      await expect(storage.getItem("sis-scan-v1")).resolves.toEqual(NEW);
    });

    it("an UNSTAMPED legacy blob (pre-scheme install) loses to a stamped IndexedDB blob", async () => {
      const { backing, data } = makeFakeBacking();
      data.set("sis-scan-v1", JSON.stringify(NEW));
      data.set(stampKey("sis-scan-v1"), "2000");
      const { storage: legacy } = makeLegacySync({ "sis-scan-v1": JSON.stringify(OLD) });
      const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing, { migrateFrom: legacy });
      await expect(storage.getItem("sis-scan-v1")).resolves.toEqual(NEW);
    });

    it("the winning legacy blob is migrated forward into IndexedDB (divergence heals, copy-then-clear)", async () => {
      const { backing, data } = makeFakeBacking();
      data.set("sis-scan-v1", JSON.stringify(OLD));
      data.set(stampKey("sis-scan-v1"), "1000");
      const { storage: legacy, data: legacyData } = makeLegacySync({
        "sis-scan-v1": JSON.stringify(NEW),
        [stampKey("sis-scan-v1")]: "2000",
      });
      const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing, { migrateFrom: legacy });
      await expect(storage.getItem("sis-scan-v1")).resolves.toEqual(NEW);
      await vi.runAllTimersAsync();
      expect(JSON.parse(data.get("sis-scan-v1")!)).toEqual(NEW);
      expect(legacyData.has("sis-scan-v1")).toBe(false);
    });

    it("a successful backing write stamps the blob so the next session can order the two stores", async () => {
      const { backing, data } = makeFakeBacking();
      const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing);
      storage.setItem("sis-scan-v1", VALUE);
      await vi.runAllTimersAsync();
      expect(data.get("sis-scan-v1")).toBe(JSON.stringify(VALUE));
      expect(Number(data.get(stampKey("sis-scan-v1")))).toBeGreaterThan(0);
    });

    it("the migration copy carries the SOURCE stamp forward (it must not spuriously outrank a newer legacy write)", async () => {
      const { backing, data } = makeFakeBacking();
      const { storage: legacy } = makeLegacySync({
        "sis-scan-v1": JSON.stringify(VALUE),
        [stampKey("sis-scan-v1")]: "1234",
      });
      const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing, { migrateFrom: legacy });
      await storage.getItem("sis-scan-v1");
      await vi.runAllTimersAsync();
      expect(data.get(stampKey("sis-scan-v1"))).toBe("1234");
    });
  });

  describe("B2: write-through to localStorage on the FIRST backing write failure (not only after the latch)", () => {
    it("lands the value AND its stamp in legacy storage on failure #1", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { backing } = makeFakeBacking({ setItem: vi.fn(async () => { throw new Error("idb down"); }) });
      const legacyData = new Map<string, string>();
      const legacy = {
        getItem: vi.fn((n: string) => legacyData.get(n) ?? null),
        setItem: vi.fn((n: string, v: string) => { legacyData.set(n, v); }),
        removeItem: vi.fn((n: string) => { legacyData.delete(n); }),
      };
      const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing, { migrateFrom: legacy });
      storage.setItem("sis-scan-v1", VALUE);
      await vi.runAllTimersAsync();
      expect(readLegacyBlob(legacyData, "sis-scan-v1")).toEqual(VALUE);
      expect(readLegacyStamp(legacyData, "sis-scan-v1")).toBeGreaterThan(0);
      warn.mockRestore();
    });

    it("read successes never reset the WRITE-failure counter (a write-only failure mode still latches)", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { backing } = makeFakeBacking({
        getItem: vi.fn(async () => null),
        setItem: vi.fn(async () => { throw new Error("writes blocked"); }),
      });
      const legacyData = new Map<string, string>();
      const legacy = {
        getItem: vi.fn((n: string) => legacyData.get(n) ?? null),
        setItem: vi.fn((n: string, v: string) => { legacyData.set(n, v); }),
        removeItem: vi.fn((n: string) => { legacyData.delete(n); }),
      };
      const onPersistFailure = vi.fn();
      const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing, { migrateFrom: legacy, onPersistFailure });
      for (let i = 1; i <= 3; i++) {
        storage.setItem("sis-scan-v1", { ...VALUE, version: i });
        await vi.runAllTimersAsync();
        await storage.getItem("sis-scan-v1"); // a successful READ between every failing write
        await vi.runAllTimersAsync();
      }
      expect(onPersistFailure.mock.calls.filter(([kind]) => kind === "demoted")).toHaveLength(1);
      warn.mockRestore();
    });

    it("B6 (accepted risk): a legacy fallback write that ALSO throws stays fail-soft and reports it", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { backing } = makeFakeBacking({ setItem: vi.fn(async () => { throw new Error("idb down"); }) });
      const legacy = {
        getItem: vi.fn(() => null),
        setItem: vi.fn(() => { throw new Error("localStorage quota exceeded"); }),
        removeItem: vi.fn(),
      };
      const onPersistFailure = vi.fn();
      const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing, { migrateFrom: legacy, onPersistFailure });
      expect(() => storage.setItem("sis-scan-v1", VALUE)).not.toThrow();
      await expect(vi.runAllTimersAsync()).resolves.toBeDefined();
      expect(onPersistFailure).toHaveBeenCalledWith("write", expect.any(Error));
      warn.mockRestore();
    });
  });

  describe("B3: removeItem cancels an in-flight migration even while the backing is latched broken", () => {
    it("never resurrects the removed key", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const data = new Map<string, string>();
      let gateRelease!: () => void;
      const gate = new Promise<void>((res) => { gateRelease = res; });
      let calls = 0;
      const backing: AsyncBacking = {
        getItem: vi.fn(async (n: string) => data.get(n) ?? null),
        setItem: vi.fn(async (n: string, v: string) => {
          calls += 1;
          if (calls === 1) { await gate; data.set(n, v); return; } // the migration copy: held open
          throw new Error("idb down"); // every later write fails -> latches the broken flag
        }),
        removeItem: vi.fn(async (n: string) => { data.delete(n); }),
      };
      const legacyData = new Map<string, string>([["sis-scan-v1", JSON.stringify(VALUE)]]);
      const legacy = {
        getItem: vi.fn((n: string) => legacyData.get(n) ?? null),
        setItem: vi.fn((n: string, v: string) => { legacyData.set(n, v); }),
        removeItem: vi.fn((n: string) => { legacyData.delete(n); }),
      };
      const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing, { migrateFrom: legacy });

      await storage.getItem("sis-scan-v1"); // starts the gated migration copy for sis-scan-v1

      // Trip the broken latch on a DIFFERENT key so the failing writes do not queue behind the gate.
      for (let i = 1; i <= 3; i++) {
        storage.setItem("sis-scan-other", { ...VALUE, version: i });
        await vi.runAllTimersAsync();
      }

      storage.removeItem("sis-scan-v1"); // sign-out wipe while the backing is latched broken
      gateRelease();
      await vi.runAllTimersAsync();

      expect(data.has("sis-scan-v1")).toBe(false);
      expect(legacyData.has("sis-scan-v1")).toBe(false);
      warn.mockRestore();
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Tier-3 review round 3 (2026-08-09).
  //   F2 (MEDIUM): blob and stamp were TWO transactions - `setItem(blob).then(() => setItem(stamp))`.
  //       The stamp put is scheduled in a microtask after the blob request's onsuccess, which on a
  //       pagehide flush routinely never lands before the document unloads, so the LAST write of every
  //       tab-close session carried a stale stamp and lost newest-wins in the next session.
  //   F3 (MEDIUM): `lastStamp` started at 0 per instance, so after a backwards device-clock jump a
  //       genuinely newer write stamped LOWER than the blob already on disk, and newest-wins then
  //       discarded the newer copy.
  // ---------------------------------------------------------------------------------------------
  describe("F2: the blob and its stamp are written in ONE backing transaction", () => {
    function makeAtomicBacking() {
      const data = new Map<string, string>();
      const setItemsCalls: Array<Array<[string, string]>> = [];
      const backing: AsyncBacking = {
        getItem: vi.fn(async (n: string) => data.get(n) ?? null),
        setItem: vi.fn(async (n: string, v: string) => { data.set(n, v); }),
        setItems: vi.fn(async (entries: Array<[string, string]>) => {
          setItemsCalls.push(entries);
          for (const [n, v] of entries) data.set(n, v);
        }),
        removeItem: vi.fn(async (n: string) => { data.delete(n); }),
      };
      return { backing, data, setItemsCalls };
    }

    it("uses the multi-put path so a flush cannot land the blob without its stamp", async () => {
      const { backing, data, setItemsCalls } = makeAtomicBacking();
      const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing);
      storage.setItem("sis-scan-v1", VALUE);
      await vi.runAllTimersAsync();

      expect(setItemsCalls).toHaveLength(1);
      expect(setItemsCalls[0].map(([n]) => n)).toEqual(["sis-scan-v1", stampKey("sis-scan-v1")]);
      expect(backing.setItem).not.toHaveBeenCalled(); // never the two-transaction path
      expect(data.get("sis-scan-v1")).toBe(JSON.stringify(VALUE));
      expect(Number(data.get(stampKey("sis-scan-v1")))).toBeGreaterThan(0);
    });

    it("the background legacy migration copy is atomic the same way (blob + carried stamp together)", async () => {
      const { backing, setItemsCalls } = makeAtomicBacking();
      const legacyData = new Map<string, string>([
        ["sis-scan-v1", JSON.stringify(VALUE)],
        [stampKey("sis-scan-v1"), "1234"],
      ]);
      const legacy = {
        getItem: vi.fn((n: string) => legacyData.get(n) ?? null),
        setItem: vi.fn((n: string, v: string) => { legacyData.set(n, v); }),
        removeItem: vi.fn((n: string) => { legacyData.delete(n); }),
      };
      const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing, { migrateFrom: legacy });
      await storage.getItem("sis-scan-v1");
      await vi.runAllTimersAsync();

      expect(setItemsCalls).toHaveLength(1);
      expect(setItemsCalls[0]).toEqual([["sis-scan-v1", JSON.stringify(VALUE)], [stampKey("sis-scan-v1"), "1234"]]);
    });
  });

  describe("F3: a backwards device-clock jump can never make a newer write look older", () => {
    it("seeds the stamp floor from what is already on disk, so the next write outranks both stores", async () => {
      const FUTURE = Date.now() + 5_000_000; // simulated rollback: on-disk stamps are 'in the future'
      const { backing, data } = makeFakeBacking();
      data.set("sis-scan-v1", JSON.stringify(VALUE));
      data.set(stampKey("sis-scan-v1"), String(FUTURE));
      const legacyData = new Map<string, string>([
        ["sis-scan-v1", JSON.stringify(VALUE)],
        [stampKey("sis-scan-v1"), String(FUTURE + 10)],
      ]);
      const legacy = {
        getItem: vi.fn((n: string) => legacyData.get(n) ?? null),
        setItem: vi.fn((n: string, v: string) => { legacyData.set(n, v); }),
        removeItem: vi.fn((n: string) => { legacyData.delete(n); }),
      };

      const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing, { migrateFrom: legacy });
      await storage.getItem("sis-scan-v1"); // hydration reads both stores and both stamps
      await vi.runAllTimersAsync();

      const FRESH = { state: { scanFeed: [{ id: "FRESH" }] }, version: 9 };
      storage.setItem("sis-scan-v1", FRESH);
      await vi.runAllTimersAsync();

      const written = Number(data.get(stampKey("sis-scan-v1")));
      expect(written).toBeGreaterThan(FUTURE + 10);
      expect(JSON.parse(data.get("sis-scan-v1")!)).toEqual(FRESH);
    });

    it("seeds the floor in the legacy-ONLY branch too (nothing in IndexedDB yet)", async () => {
      const FUTURE = Date.now() + 5_000_000;
      const { backing, data } = makeFakeBacking();
      const legacyData = new Map<string, string>([
        ["sis-scan-v1", JSON.stringify(VALUE)],
        [stampKey("sis-scan-v1"), String(FUTURE)],
      ]);
      const legacy = {
        getItem: vi.fn((n: string) => legacyData.get(n) ?? null),
        setItem: vi.fn((n: string, v: string) => { legacyData.set(n, v); }),
        removeItem: vi.fn((n: string) => { legacyData.delete(n); }),
      };
      const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing, { migrateFrom: legacy });
      await storage.getItem("sis-scan-v1"); // migration copy carries the FUTURE stamp forward
      await vi.runAllTimersAsync();

      storage.setItem("sis-scan-v1", { state: { scanFeed: [{ id: "FRESH" }] }, version: 9 });
      await vi.runAllTimersAsync();

      expect(Number(data.get(stampKey("sis-scan-v1")))).toBeGreaterThan(FUTURE);
    });
  });

  describe("B5: the startup probe routes writes to localStorage immediately (no 3-failure tax)", () => {
    it("uses an injected probe that reports the backing unusable", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { backing } = makeFakeBacking();
      const legacyData = new Map<string, string>();
      const legacy = {
        getItem: vi.fn((n: string) => legacyData.get(n) ?? null),
        setItem: vi.fn((n: string, v: string) => { legacyData.set(n, v); }),
        removeItem: vi.fn((n: string) => { legacyData.delete(n); }),
      };
      const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing, {
        migrateFrom: legacy,
        probeBacking: async () => false,
      });
      await vi.runAllTimersAsync(); // let the fire-and-forget probe settle
      storage.setItem("sis-scan-v1", VALUE);
      await vi.runAllTimersAsync();
      expect(backing.setItem).not.toHaveBeenCalled(); // FIRST write already bypasses IndexedDB
      expect(readLegacyBlob(legacyData, "sis-scan-v1")).toEqual(VALUE);
      warn.mockRestore();
    });

    it("a rejecting probe is treated as a failed probe (never escapes)", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { backing } = makeFakeBacking();
      const legacyData = new Map<string, string>();
      const legacy = {
        getItem: vi.fn((n: string) => legacyData.get(n) ?? null),
        setItem: vi.fn((n: string, v: string) => { legacyData.set(n, v); }),
        removeItem: vi.fn((n: string) => { legacyData.delete(n); }),
      };
      const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing, {
        migrateFrom: legacy,
        probeBacking: async () => { throw new Error("probe blew up"); },
      });
      await vi.runAllTimersAsync();
      storage.setItem("sis-scan-v1", VALUE);
      await vi.runAllTimersAsync();
      expect(backing.setItem).not.toHaveBeenCalled();
      expect(readLegacyBlob(legacyData, "sis-scan-v1")).toEqual(VALUE);
      warn.mockRestore();
    });

    it("defaults to the real probeIdbBacking() when a global indexedDB exists (B5: no longer dead code)", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      // A global indexedDB that exists but is BLOCKED (Chrome block-site-data / lockdown shape):
      // the pure typeof feature-detect upstream says "available", the real probe says otherwise.
      vi.stubGlobal("indexedDB", {
        open() {
          throw new Error("blocked by policy");
        },
      });
      const { backing } = makeFakeBacking();
      const legacyData = new Map<string, string>();
      const legacy = {
        getItem: vi.fn((n: string) => legacyData.get(n) ?? null),
        setItem: vi.fn((n: string, v: string) => { legacyData.set(n, v); }),
        removeItem: vi.fn((n: string) => { legacyData.delete(n); }),
      };
      const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing, { migrateFrom: legacy });
      await vi.runAllTimersAsync();
      storage.setItem("sis-scan-v1", VALUE);
      await vi.runAllTimersAsync();
      expect(backing.setItem).not.toHaveBeenCalled();
      expect(readLegacyBlob(legacyData, "sis-scan-v1")).toEqual(VALUE);
      vi.unstubAllGlobals();
      warn.mockRestore();
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Tier-3 external review (clean-room, 2026-08-09).
  // ---------------------------------------------------------------------------------------------

  function makeLegacyStore(seed: Record<string, string> = {}) {
    const data = new Map<string, string>(Object.entries(seed));
    return {
      data,
      storage: {
        getItem: vi.fn((n: string) => data.get(n) ?? null),
        setItem: vi.fn((n: string, v: string) => { data.set(n, v); }),
        removeItem: vi.fn((n: string) => { data.delete(n); }),
      },
    };
  }

  // P2 (HIGH): flush() launches `void doWrite(...)` and drops all tracking, so an already-flushed
  // write is invisible to removeItem. When that untracked write later REJECTS, its catch ran
  // writeThroughToLegacy UNCONDITIONALLY - re-creating the blob in localStorage AFTER sign-out /
  // "Clear local cache" deleted it. On a shared device that is the PREVIOUS user's inventory, and the
  // next sign-in is offered it by the adopt banner.
  describe("P2: a removed key is never resurrected by an in-flight write's failure fallback", () => {
    function deferredReject() {
      let reject!: (e: unknown) => void;
      const promise = new Promise<void>((_res, rej) => { reject = rej; });
      return { promise, reject };
    }

    it("flush -> removeItem -> the in-flight backing write REJECTS: legacy must NOT hold the value", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const gate = deferredReject();
      const backing: AsyncBacking = {
        getItem: vi.fn(async () => null),
        setItem: vi.fn(async () => { await gate.promise; }),
        setItems: vi.fn(async () => { await gate.promise; }),
        removeItem: vi.fn(async () => undefined),
      };
      const { storage: legacy, data: legacyData } = makeLegacyStore();
      const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing, { migrateFrom: legacy });

      const PREVIOUS_USER = { state: { scanFeed: [{ id: "PREVIOUS-USER-INVENTORY" }] }, version: 7 };
      storage.setItem("sis-scan-v1", PREVIOUS_USER);
      storage.flush(); // the write is now IN FLIGHT and no longer tracked by the pending slot

      storage.removeItem("sis-scan-v1"); // sign-out wipe / "Clear local cache"

      gate.reject(new Error("idb write failed after the removal")); // the in-flight write finally fails
      await vi.runAllTimersAsync();

      expect(legacyData.has("sis-scan-v1")).toBe(false); // must NOT be written back through
      expect(legacyData.has(stampKey("sis-scan-v1"))).toBe(false);
      warn.mockRestore();
    });

    it("a write that COMMITS after the removal is re-removed from both stores (late-success bookkeeping)", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      let release!: () => void;
      const gate = new Promise<void>((res) => { release = res; });
      const data = new Map<string, string>();
      const backing: AsyncBacking = {
        getItem: vi.fn(async (n: string) => data.get(n) ?? null),
        setItem: vi.fn(async (n: string, v: string) => { await gate; data.set(n, v); }),
        setItems: vi.fn(async (entries: Array<[string, string]>) => {
          await gate;
          for (const [n, v] of entries) data.set(n, v);
        }),
        removeItem: vi.fn(async (n: string) => { data.delete(n); }),
      };
      const { storage: legacy, data: legacyData } = makeLegacyStore();
      const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing, { migrateFrom: legacy });

      storage.setItem("sis-scan-v1", VALUE);
      storage.flush();
      storage.removeItem("sis-scan-v1");
      release(); // the in-flight write commits AFTER the removal, resurrecting the key
      await vi.runAllTimersAsync();

      expect(data.has("sis-scan-v1")).toBe(false); // the removal is authoritative
      expect(data.has(stampKey("sis-scan-v1"))).toBe(false);
      expect(legacyData.has("sis-scan-v1")).toBe(false);
      warn.mockRestore();
    });

    it("a NORMAL failing write (no removal) still writes through - the guard is scoped to removals", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { backing } = makeFakeBacking({ setItem: vi.fn(async () => { throw new Error("idb down"); }) });
      const { storage: legacy, data: legacyData } = makeLegacyStore();
      const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing, { migrateFrom: legacy });

      storage.setItem("sis-scan-v1", VALUE);
      await vi.runAllTimersAsync();

      expect(readLegacyBlob(legacyData, "sis-scan-v1")).toEqual(VALUE);
      warn.mockRestore();
    });

    it("a removal only silences its OWN key (another key's fallback is unaffected)", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { backing } = makeFakeBacking({ setItem: vi.fn(async () => { throw new Error("idb down"); }) });
      const { storage: legacy, data: legacyData } = makeLegacyStore();
      const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing, { migrateFrom: legacy });

      storage.removeItem("sis-scan-other");
      storage.setItem("sis-scan-v1", VALUE);
      await vi.runAllTimersAsync();

      expect(readLegacyBlob(legacyData, "sis-scan-v1")).toEqual(VALUE);
      warn.mockRestore();
    });
  });

  // P3 (HIGH): the write-stamp FLOOR was seeded only when localStorage also held a blob, and the
  // reader did not even fetch the backing stamp otherwise. In the normal steady state (everything in
  // IndexedDB, nothing in localStorage) the floor stayed 0, so after a backwards clock jump the next
  // fallback write stamped LOWER than the stale IndexedDB stamp and lost on the next reload.
  describe("P3: the stamp floor is seeded in the BACKING-ONLY path too", () => {
    it("a fallback write after a clock rollback still outranks the stale IndexedDB stamp", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const FUTURE = Date.now() + 5_000_000; // clock rolled back: the on-disk stamp is 'in the future'
      const { backing, data } = makeFakeBacking();
      data.set("sis-scan-v1", JSON.stringify(VALUE));
      data.set(stampKey("sis-scan-v1"), String(FUTURE));
      const { storage: legacy, data: legacyData } = makeLegacyStore(); // legacy is EMPTY - the backing-only path

      const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing, { migrateFrom: legacy });
      await storage.getItem("sis-scan-v1"); // hydration: backing-only hit
      await vi.runAllTimersAsync();

      // The next write fails and falls back to localStorage. Its stamp must beat the stale IDB stamp,
      // otherwise the stale IndexedDB blob wins the next reload and the session's scans are lost.
      const FRESH = { state: { scanFeed: [{ id: "FRESH" }] }, version: 9 };
      (backing.setItem as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        throw new Error("idb down");
      });
      storage.setItem("sis-scan-v1", FRESH);
      await vi.runAllTimersAsync();

      expect(readLegacyStamp(legacyData, "sis-scan-v1")).toBeGreaterThan(FUTURE);
      expect(readLegacyBlob(legacyData, "sis-scan-v1")).toEqual(FRESH);
      warn.mockRestore();
    });

    it("the reader reports the backing stamp even when localStorage holds nothing", async () => {
      const { backing, data } = makeFakeBacking();
      data.set("sis-scan-v1", JSON.stringify(VALUE));
      data.set(stampKey("sis-scan-v1"), "4242");
      const { readNewestPersistedRaw } = await import("./scanPersistStorage");
      const read = await readNewestPersistedRaw("sis-scan-v1", backing, null);
      expect(read.source).toBe("backing");
      expect(read.backingStamp).toBe(4242);
    });
  });

  // P4 (HIGH): the blob and its stamp were read in TWO transactions, so another tab's atomic write
  // could land between them and pair the STALE blob with the NEW stamp - a false winner, after which
  // the loser cleanup DELETES the genuinely newest blob from the other store.
  describe("P4: blob and stamp come from ONE consistent snapshot", () => {
    /** A backing that MUTATES between two single-key getItem calls (the other-tab atomic write), but
     *  is self-consistent when asked for both keys at once. */
    function makeTearingBacking() {
      const STALE = JSON.stringify({ state: { scanFeed: [{ id: "STALE" }] }, version: 7 });
      const FRESH = JSON.stringify({ state: { scanFeed: [{ id: "FRESH-OTHER-TAB" }] }, version: 8 });
      // Generation 0 = (STALE, stamp 1000). The other tab commits generation 1 = (FRESH, stamp 3000).
      let singleReads = 0;
      const snapshot = () =>
        singleReads >= 1
          ? { blob: FRESH, stamp: "3000" } // the other tab's write has landed
          : { blob: STALE, stamp: "1000" };
      const backing: AsyncBacking = {
        getItem: vi.fn(async (n: string) => {
          const snap = snapshot();
          singleReads += 1; // every SEPARATE read can see a different generation - that is the tear
          return n.endsWith("::stamp") ? snap.stamp : snap.blob;
        }),
        getItems: vi.fn(async (names: string[]) => {
          const snap = snapshot(); // ONE snapshot for the whole call - a real single transaction
          return names.map((n) => (n.endsWith("::stamp") ? snap.stamp : snap.blob));
        }),
        setItem: vi.fn(async () => undefined),
        setItems: vi.fn(async () => undefined),
        removeItem: vi.fn(async () => undefined),
      };
      return { backing, STALE, FRESH };
    }

    it("never pairs a stale blob with a newer stamp (uses getItems)", async () => {
      const { backing, STALE, FRESH } = makeTearingBacking();
      const { readNewestPersistedRaw } = await import("./scanPersistStorage");
      const read = await readNewestPersistedRaw("sis-scan-v1", backing, null);

      expect(backing.getItems).toHaveBeenCalledWith(["sis-scan-v1", stampKey("sis-scan-v1")]);
      expect(backing.getItem).not.toHaveBeenCalled();
      // The guarantee is CONSISTENCY, not which generation won the race: whichever generation the
      // single transaction observed, the blob and the stamp must belong to that SAME generation.
      // The forbidden outcome is the cross-pair (STALE blob, stamp 3000).
      expect([
        { blob: STALE, stamp: 1000 },
        { blob: FRESH, stamp: 3000 },
      ]).toContainEqual({ blob: read.backingRaw, stamp: read.backingStamp });
    });

    it("the torn pair would otherwise crown a false winner and DELETE the true newest legacy blob", async () => {
      const { backing, STALE } = makeTearingBacking();
      // Force the documented sequential fallback by hiding getItems, to show what the tear produces.
      const sequentialBacking = { getItem: backing.getItem };
      const { readNewestPersistedRaw } = await import("./scanPersistStorage");
      const { storage: legacy } = makeLegacyStore({
        "sis-scan-v1": encodeLegacyStamped(JSON.stringify({ state: { scanFeed: [{ id: "TRUE-NEWEST" }] } }), 2000),
      });
      const torn = await readNewestPersistedRaw("sis-scan-v1", sequentialBacking, legacy);

      // The sequential path really does tear: blob generation 0, stamp generation 1.
      expect(torn.backingRaw).toBe(STALE);
      expect(torn.backingStamp).toBe(3000);
      // ...and 3000 > 2000, so the STALE blob wins and the true newest (2000) would be deleted.
      expect(torn.source).toBe("backing");
    });
  });

  // P7 (MEDIUM): blob and stamp were two localStorage writes, so a quota error on the stamp (a
  // net-new key) could leave NEW content under an OLD stamp - stale-stamped content that newest-wins
  // judges the loser and then DELETES. They are now one atomic `sisv1:<stamp>:<raw>` envelope.
  describe("P7: the legacy blob and its stamp cannot split", () => {
    it("writes blob + stamp as ONE setItem call", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { backing } = makeFakeBacking({ setItem: vi.fn(async () => { throw new Error("idb down"); }) });
      const { storage: legacy, data: legacyData } = makeLegacyStore();
      const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing, { migrateFrom: legacy });

      storage.setItem("sis-scan-v1", VALUE);
      await vi.runAllTimersAsync();

      const blobWrites = legacy.setItem.mock.calls.filter(([n]) => n === "sis-scan-v1");
      expect(blobWrites).toHaveLength(1);
      expect(legacy.setItem.mock.calls.some(([n]) => n === stampKey("sis-scan-v1"))).toBe(false);
      const decoded = decodeLegacyStamped(legacyData.get("sis-scan-v1")!);
      expect(JSON.parse(decoded.raw!)).toEqual(VALUE);
      expect(decoded.stamp).toBeGreaterThan(0);
      warn.mockRestore();
    });

    it("a stamp-key quota failure can no longer strand new content under an old stamp", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { backing } = makeFakeBacking({ setItem: vi.fn(async () => { throw new Error("idb down"); }) });
      const data = new Map<string, string>([[stampKey("sis-scan-v1"), "1"]]); // a stale pre-envelope stamp
      const legacy = {
        getItem: vi.fn((n: string) => data.get(n) ?? null),
        // Simulate the quota wall the split-write hit: the tiny sibling stamp key cannot be written.
        setItem: vi.fn((n: string, v: string) => {
          if (n.endsWith("::stamp")) throw new Error("QuotaExceededError");
          data.set(n, v);
        }),
        removeItem: vi.fn((n: string) => { data.delete(n); }),
      };
      const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing, { migrateFrom: legacy });

      storage.setItem("sis-scan-v1", VALUE);
      await vi.runAllTimersAsync();

      // The write landed whole, carrying its own stamp - the sibling key was never needed.
      expect(readLegacyBlob(data, "sis-scan-v1")).toEqual(VALUE);
      expect(readLegacyStamp(data, "sis-scan-v1")).toBeGreaterThan(1);
      warn.mockRestore();
    });

    it("BACK-COMPAT: a pre-envelope plain blob + sibling stamp still reads correctly", async () => {
      const { backing, data } = makeFakeBacking();
      data.set("sis-scan-v1", JSON.stringify({ state: { scanFeed: [{ id: "IDB" }] }, version: 7 }));
      data.set(stampKey("sis-scan-v1"), "1000");
      const { storage: legacy } = makeLegacyStore({
        "sis-scan-v1": JSON.stringify({ state: { scanFeed: [{ id: "PLAIN-LEGACY" }] }, version: 8 }),
        [stampKey("sis-scan-v1")]: "2000",
      });
      const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing, { migrateFrom: legacy });
      await expect(storage.getItem("sis-scan-v1")).resolves.toEqual({
        state: { scanFeed: [{ id: "PLAIN-LEGACY" }] },
        version: 8,
      });
    });

    it("BACK-COMPAT: an UNSTAMPED pre-envelope plain blob is still treated as oldest", async () => {
      const { backing, data } = makeFakeBacking();
      data.set("sis-scan-v1", JSON.stringify(VALUE));
      data.set(stampKey("sis-scan-v1"), "2000");
      const { storage: legacy } = makeLegacyStore({
        "sis-scan-v1": JSON.stringify({ state: { scanFeed: [{ id: "ANCIENT" }] }, version: 1 }),
      });
      const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing, { migrateFrom: legacy });
      await expect(storage.getItem("sis-scan-v1")).resolves.toEqual(VALUE);
    });

    it("an enveloped legacy blob is migrated forward as its DECODED raw (never the envelope)", async () => {
      const { backing, data } = makeFakeBacking();
      const raw = JSON.stringify({ state: { scanFeed: [{ id: "ENVELOPED" }] }, version: 8 });
      const { storage: legacy } = makeLegacyStore({ "sis-scan-v1": encodeLegacyStamped(raw, 5555) });
      const storage = createAsyncCoalescedFailSoftPersistStorage(() => backing, { migrateFrom: legacy });

      await storage.getItem("sis-scan-v1");
      await vi.runAllTimersAsync();

      expect(data.get("sis-scan-v1")).toBe(raw); // the blob, not `sisv1:5555:{...}`
      expect(data.get(stampKey("sis-scan-v1"))).toBe("5555"); // source stamp carried forward
    });

    it("decodeLegacyStamped treats a malformed envelope as a plain blob (never discards data)", () => {
      expect(decodeLegacyStamped("sisv1:not-a-number:{}")).toEqual({ raw: "sisv1:not-a-number:{}", stamp: null });
      expect(decodeLegacyStamped("sisv1:nocolon")).toEqual({ raw: "sisv1:nocolon", stamp: null });
      expect(decodeLegacyStamped(null)).toEqual({ raw: null, stamp: null });
      // A raw blob that itself contains colons round-trips exactly.
      const raw = '{"a":"b:c:d"}';
      expect(decodeLegacyStamped(encodeLegacyStamped(raw, 7))).toEqual({ raw, stamp: 7 });
    });
  });
});

