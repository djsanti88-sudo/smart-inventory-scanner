import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  withDecodeCache,
  getDecodeCache,
  setDecodeCache,
  clearDecodeCache,
  decodeCacheSize,
  decodeCacheKey,
} from "@/services/ai/decodeCache";

beforeEach(() => clearDecodeCache());
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
