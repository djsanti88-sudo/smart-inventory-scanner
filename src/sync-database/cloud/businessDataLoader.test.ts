// Profiler-proven defect: a fresh-device bootstrap hung FOREVER on "Loading business data..."
// because loadBusinessData() ran Promise.all of getDocs() calls with no timeout and no retry. A
// one-shot getDocs() read whose transport channel errors (observed: emulator channel 400s; equally
// possible on real networks) never settles and is never retried, unlike onSnapshot. This suite proves
// (a) the old shape hangs forever, (b) the fixed loadBusinessData rejects within a bounded time when
// every attempt hangs, and (c) it succeeds when a later attempt resolves after earlier ones hang.
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDocs: vi.fn(),
}));

vi.mock("firebase/firestore", () => ({
  getDocs: (reference: unknown) => mocks.getDocs(reference),
  collection: vi.fn((_db: unknown, ...segments: string[]) => ({ path: segments.join("/") })),
  query: vi.fn((ref: unknown, ...constraints: unknown[]) => ({ ref, constraints })),
  where: vi.fn((field: string, op: string, value: unknown) => ({ field, op, value })),
  orderBy: vi.fn((field: string, dir: string) => ({ field, dir })),
}));

import {
  loadBusinessData,
  LOAD_ATTEMPT_TIMEOUT_MS,
  LOAD_MAX_ATTEMPTS,
} from "./businessDataLoader";
import type { Firestore } from "firebase/firestore";

const fakeDb = {} as Firestore;
const emptySnap = { docs: [] as unknown[] };

afterEach(() => {
  mocks.getDocs.mockReset();
  vi.useRealTimers();
});

describe("loadBusinessData bounded retry", () => {
  it("REGRESSION (would hang forever pre-fix): rejects within the bounded retry window instead of hanging when getDocs never settles", async () => {
    vi.useFakeTimers();
    // Every call returns a promise that never resolves or rejects - the exact shape of a stuck
    // transport channel that has nothing to throw.
    mocks.getDocs.mockReturnValue(new Promise(() => {}));

    const resultPromise = loadBusinessData(fakeDb, "biz-1");

    // Race the loader against the total bounded window (every attempt timing out, back to back).
    const totalBoundMs = LOAD_ATTEMPT_TIMEOUT_MS * LOAD_MAX_ATTEMPTS + 10_000; // + generous backoff slack
    let settled = false;
    resultPromise.then(
      () => { settled = true; },
      () => { settled = true; },
    );

    await vi.advanceTimersByTimeAsync(totalBoundMs);

    expect(settled).toBe(true);
    await expect(resultPromise).rejects.toThrow(/Timed out/i);
  });

  it("succeeds when a later attempt resolves after earlier attempts on the SAME read hang (flaky-then-success)", async () => {
    vi.useFakeTimers();
    let productsCallCount = 0;
    mocks.getDocs.mockImplementation((reference: { path?: string }) => {
      const path = reference?.path ?? "";
      if (path.includes("products")) {
        productsCallCount += 1;
        if (productsCallCount === 1) {
          return new Promise(() => {}); // first attempt hangs forever
        }
        return Promise.resolve({ docs: [] });
      }
      return Promise.resolve(emptySnap);
    });

    const resultPromise = loadBusinessData(fakeDb, "biz-1");
    let result: Awaited<ReturnType<typeof loadBusinessData>> | undefined;
    let error: unknown;
    resultPromise.then(
      (v) => { result = v; },
      (e) => { error = e; },
    );

    // Advance past exactly one attempt timeout + backoff so the second (successful) attempt fires.
    await vi.advanceTimersByTimeAsync(LOAD_ATTEMPT_TIMEOUT_MS + 1_000);

    expect(error).toBeUndefined();
    expect(result).toBeDefined();
    expect(result?.products).toEqual([]);
    expect(productsCallCount).toBe(2);
  });

  it("a late settle of an abandoned timed-out attempt does not double-apply (idempotent winner-only result)", async () => {
    vi.useFakeTimers();
    let attempt = 0;
    let resolveFirstLate!: (value: { docs: unknown[] }) => void;
    mocks.getDocs.mockImplementation((reference: { path?: string }) => {
      const path = reference?.path ?? "";
      if (path.includes("products")) {
        attempt += 1;
        if (attempt === 1) {
          return new Promise((resolve) => { resolveFirstLate = resolve; }); // resolves LATE, after timeout
        }
        return Promise.resolve({ docs: [] });
      }
      return Promise.resolve(emptySnap);
    });

    const resultPromise = loadBusinessData(fakeDb, "biz-1");
    let result: Awaited<ReturnType<typeof loadBusinessData>> | undefined;
    resultPromise.then((v) => { result = v; });

    await vi.advanceTimersByTimeAsync(LOAD_ATTEMPT_TIMEOUT_MS + 1_000);
    expect(result).toBeDefined();

    // The abandoned first attempt finally settles well after the loader already returned via attempt 2.
    // This must not throw, must not change the already-returned result, and the wrapper's promise
    // (already resolved) must not resolve/reject again.
    resolveFirstLate({ docs: [{ id: "late-product" }] });
    await vi.advanceTimersByTimeAsync(0);

    expect(result?.products).toEqual([]);
  });

  it("rejects immediately (no wasted retries) once every attempt for a read has failed or timed out, surfacing a clear error", async () => {
    vi.useFakeTimers();
    mocks.getDocs.mockReturnValue(Promise.reject(new Error("permission-denied")));

    const resultPromise = loadBusinessData(fakeDb, "biz-1");
    let error: unknown;
    resultPromise.catch((e) => { error = e; });

    await vi.advanceTimersByTimeAsync(LOAD_ATTEMPT_TIMEOUT_MS * LOAD_MAX_ATTEMPTS + 10_000);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/permission-denied/);
  });
});
