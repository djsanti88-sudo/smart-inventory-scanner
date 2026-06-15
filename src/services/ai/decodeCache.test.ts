import { describe, it, expect, beforeEach } from "vitest";
import {
  withDecodeCache,
  getDecodeCache,
  setDecodeCache,
  clearDecodeCache,
  decodeCacheSize,
  decodeCacheKey,
} from "@/services/ai/decodeCache";

beforeEach(() => clearDecodeCache());

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

  it("does NOT cache failures - a failed decode stays retryable", async () => {
    let calls = 0;
    const compute = async () => {
      calls++;
      return { ok: false };
    };
    const isSuccess = (v: { ok: boolean }) => v.ok;

    const a = await withDecodeCache("000", isSuccess, compute);
    const b = await withDecodeCache("000", isSuccess, compute);

    expect(a.cached).toBe(false);
    expect(b.cached).toBe(false); // not served from cache because it never succeeded
    expect(calls).toBe(2);
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
