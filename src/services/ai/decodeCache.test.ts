import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  withDecodeCache,
  getDecodeCache,
  setDecodeCache,
  clearDecodeCache,
  decodeCacheSize,
  decodeCacheKey,
  __clearInFlightForTest,
} from "@/services/ai/decodeCache";

beforeEach(() => {
  clearDecodeCache();
  __clearInFlightForTest();
});
afterEach(() => vi.useRealTimers());

describe("decodeCache (never re-pay AI/Firecrawl for the same barcode)", () => {
  it("runs compute once, then serves the cache on the second call (no repeat spend)", async () => {
    let calls = 0;
    const compute = async () => {
      calls++;
      return { product: "Acrylic Paint Markers", ok: true };
    };
    const isSuccess = (v: { ok: boolean }) => v.ok;

    const first = await withDecodeCache("810118139604", isSuccess, compute);
    const second = await withDecodeCache("810118139604", isSuccess, compute);

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.value.product).toBe("Acrylic Paint Markers");
    expect(calls).toBe(1); // the expensive path ran exactly once
  });

  it("caches a MISS briefly so the same unresolved code stops re-running (money-bleed fix)", async () => {
    let calls = 0;
    const compute = async () => {
      calls++;
      return { ok: false };
    };
    const isSuccess = (v: { ok: boolean }) => v.ok;

    const a = await withDecodeCache("000", isSuccess, compute, { missTtlMs: 600_000 });
    const b = await withDecodeCache("000", isSuccess, compute, { missTtlMs: 600_000 });

    expect(a.cached).toBe(false);
    expect(b.cached).toBe(true); // served from the short-lived miss cache (no repeat AI/Firecrawl spend)
    expect(calls).toBe(1);
  });

  it("re-runs a miss after its TTL expires (so a later retry still works)", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const compute = async () => {
      calls++;
      return { ok: false };
    };
    const isSuccess = (v: { ok: boolean }) => v.ok;

    await withDecodeCache("000", isSuccess, compute, { missTtlMs: 1_000 });
    vi.advanceTimersByTime(1_500); // past the miss TTL
    const b = await withDecodeCache("000", isSuccess, compute, { missTtlMs: 1_000 });

    expect(b.cached).toBe(false);
    expect(calls).toBe(2);
  });

  it("forceRefresh bypasses the cache (manual Retry)", async () => {
    let calls = 0;
    const compute = async () => {
      calls++;
      return { ok: true, n: calls };
    };
    const isSuccess = (v: { ok: boolean }) => v.ok;

    await withDecodeCache("z", isSuccess, compute);
    const b = await withDecodeCache("z", isSuccess, compute, { forceRefresh: true });

    expect(b.cached).toBe(false);
    expect(calls).toBe(2);
  });

  it("a successful decode is cached indefinitely (no TTL)", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const compute = async () => {
      calls++;
      return { ok: true };
    };
    const isSuccess = (v: { ok: boolean }) => v.ok;

    await withDecodeCache("ok1", isSuccess, compute, { missTtlMs: 1_000 });
    vi.advanceTimersByTime(60 * 60 * 1000); // an hour later
    const b = await withDecodeCache("ok1", isSuccess, compute, { missTtlMs: 1_000 });

    expect(b.cached).toBe(true); // success never expires
    expect(calls).toBe(1);
  });

  it("keys are independent per code and clear/size work", async () => {
    setDecodeCache("aaa", { v: 1 });
    setDecodeCache("bbb", { v: 2 });
    expect(getDecodeCache("aaa")).toEqual({ v: 1 });
    expect(getDecodeCache("bbb")).toEqual({ v: 2 });
    expect(getDecodeCache("ccc")).toBeUndefined();
    expect(decodeCacheSize()).toBe(2);
    clearDecodeCache();
    expect(decodeCacheSize()).toBe(0);
  });

  it("normalizes the key (trims surrounding whitespace) and ignores empty codes", async () => {
    setDecodeCache(" 123 ", { v: 9 });
    expect(getDecodeCache("123")).toEqual({ v: 9 });
    expect(decodeCacheKey("  x  ")).toBe("x");
    setDecodeCache("   ", { v: 0 });
    expect(decodeCacheSize()).toBe(1); // empty code not stored
  });
});

describe("L3 in-flight coalescing (owner-ratified 2026-07-15, Task 12c/AM-6)", () => {
  it("3 concurrent calls for the SAME key compute ONCE and share the result", async () => {
    let computes = 0;
    const compute = async () => {
      computes++;
      await new Promise((r) => setTimeout(r, 20));
      return { name: "product" };
    };
    const isSuccess = () => true;
    const [a, b, c] = await Promise.all([
      withDecodeCache("00049000006346", isSuccess, compute),
      withDecodeCache("00049000006346", isSuccess, compute),
      withDecodeCache("00049000006346", isSuccess, compute),
    ]);
    expect(computes).toBe(1);
    expect(a.value).toEqual(b.value);
    expect(c.value).toEqual(a.value);
    // The original caller is the one that actually computed; the two joined waiters are marked.
    expect([a.joined, b.joined, c.joined].filter(Boolean)).toHaveLength(2);
    expect([a.joined, b.joined, c.joined].filter((j) => !j)).toHaveLength(1);
  });

  it("different keys still compute independently (no cross-key coalescing)", async () => {
    let computes = 0;
    const compute = async () => {
      computes++;
      await new Promise((r) => setTimeout(r, 10));
      return { ok: true };
    };
    const [a, b] = await Promise.all([
      withDecodeCache("key-a", () => true, compute),
      withDecodeCache("key-b", () => true, compute),
    ]);
    expect(computes).toBe(2);
    expect(a.joined).toBeFalsy();
    expect(b.joined).toBeFalsy();
  });

  it("a THROWING compute clears the in-flight slot so the next call retries (not poisoned forever)", async () => {
    let n = 0;
    const compute = async () => {
      n++;
      if (n === 1) throw new Error("boom");
      return { ok: true };
    };
    await expect(withDecodeCache("key-x", () => true, compute)).rejects.toThrow("boom");
    const r = await withDecodeCache("key-x", () => true, compute);
    expect(r.value).toEqual({ ok: true });
    expect(n).toBe(2);
  });

  it("forceRefresh is NEVER joined by a later normal call, and never joins one itself (both directions)", async () => {
    let computes = 0;
    const releasers: Array<() => void> = [];
    const slowCompute = async () => {
      computes++;
      const mine = computes; // capture at call time, not at resolve time
      await new Promise<void>((resolve) => releasers.push(resolve));
      return { ok: true, n: mine };
    };

    // Kick off a normal call that is still in flight (does not resolve until we release it below).
    const normalPromise = withDecodeCache("shared-key", () => true, slowCompute);
    await new Promise((r) => setTimeout(r, 5)); // let it register in the in-flight map

    // A forceRefresh call for the SAME key must NOT join the pending normal call - it computes its own.
    const forced = await withDecodeCache("shared-key", () => true, async () => {
      computes++;
      return { ok: true, forced: true };
    }, { forceRefresh: true });
    expect(forced.value).toEqual({ ok: true, forced: true });
    expect(forced.cached).toBe(false);
    expect(forced.joined).toBeFalsy();

    // Release the original slow compute and confirm it never got merged with the forced call's result.
    releasers.forEach((fn) => fn());
    const normal = await normalPromise;
    expect(normal.value).toEqual({ ok: true, n: 1 });
    expect(computes).toBe(2); // one for the original normal call, one for the forced call - never shared

    // Now the reverse direction: a normal call must not join a PRIOR forceRefresh's in-flight slot,
    // because forceRefresh never registers itself in the map in the first place.
    let laterComputes = 0;
    const releasers2: Array<() => void> = [];
    const forcedSlow = withDecodeCache("shared-key-2", () => true, async () => {
      laterComputes++;
      await new Promise<void>((resolve) => releasers2.push(resolve));
      return { ok: true, tag: "forced-slow" };
    }, { forceRefresh: true });
    await new Promise((r) => setTimeout(r, 5));
    const laterNormal = await withDecodeCache("shared-key-2", () => true, async () => {
      laterComputes++;
      return { ok: true, tag: "normal" };
    });
    expect(laterNormal.value).toEqual({ ok: true, tag: "normal" });
    expect(laterNormal.joined).toBeFalsy();
    releasers2.forEach((fn) => fn());
    await forcedSlow;
    expect(laterComputes).toBe(2); // the forceRefresh call never registered, so the normal call never joined it
  });

  it("cap-exhausted burst: 3 concurrent calls under an exhausted cap all reject with the cap error, compute runs at most twice", async () => {
    class FakeCapExceededError extends Error {}
    let computes = 0;
    const compute = async () => {
      computes++;
      await new Promise((r) => setTimeout(r, 10));
      throw new FakeCapExceededError("cap exceeded");
    };
    const isSuccess = () => true;
    const results = await Promise.allSettled([
      withDecodeCache("cap-key", isSuccess, compute),
      withDecodeCache("cap-key", isSuccess, compute),
      withDecodeCache("cap-key", isSuccess, compute),
    ]);
    // All three reject with the SAME cap error (joined waiters share the original rejection).
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    for (const r of results) {
      if (r.status === "rejected") expect(r.reason).toBeInstanceOf(FakeCapExceededError);
    }
    // The throwing compute clears its slot in `finally`, so at most one more retry can start before
    // the other callers observe the rejection - never an unbounded stampede.
    expect(computes).toBeLessThanOrEqual(2);
  });
});
