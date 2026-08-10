import { describe, it, expect, vi } from "vitest";
import { checkAccountDeleteRateLimit } from "./accountDeleteRateLimit";

// Fake Firestore: a transaction runs against a single in-memory doc keyed by the ref path, mirroring
// the makeMockTx/makeMockDb shape catalogDispute.test.ts / masterAppend.test.ts already establish for
// Admin SDK transactions elsewhere in this repo.

interface MockRef {
  path: string;
}

function makeMockDb(initial: Record<string, { windowStart?: number; count?: number }> = {}) {
  const store = new Map<string, { windowStart?: number; count?: number }>(Object.entries(initial));
  const setCalls: Array<{ path: string; data: Record<string, unknown> }> = [];

  const tx = {
    get: vi.fn(async (ref: MockRef) => {
      const data = store.get(ref.path);
      return { exists: data !== undefined, data: () => data };
    }),
    set: vi.fn((ref: MockRef, data: Record<string, unknown>) => {
      setCalls.push({ path: ref.path, data });
      store.set(ref.path, data as { windowStart?: number; count?: number });
    }),
  };

  const db = {
    collection: vi.fn((name: string) => ({
      doc: vi.fn((id: string) => ({ path: `${name}/${id}` }) as MockRef),
    })),
    runTransaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as FirebaseFirestore.Firestore;

  return { db, store, setCalls, tx };
}

describe("checkAccountDeleteRateLimit", () => {
  it("allows the first attempt in a fresh window and writes windowStart/count=1", async () => {
    const { db, store } = makeMockDb();
    const now = 1_000_000;
    const result = await checkAccountDeleteRateLimit("DELETE:biz-1:owner-uid", { limit: 3, windowMs: 3_600_000, now }, { db });
    expect(result).toEqual({ allowed: true, retryAfterMs: 0, remaining: 2 });
    expect(store.get("_rateLimits/DELETE:biz-1:owner-uid")).toEqual({
      windowStart: now,
      count: 1,
      updatedAt: new Date(now).toISOString(),
    });
  });

  it("increments the count atomically within the same window across sequential calls", async () => {
    const { db } = makeMockDb();
    const now = 1_000_000;
    const first = await checkAccountDeleteRateLimit("k", { limit: 3, windowMs: 3_600_000, now }, { db });
    const second = await checkAccountDeleteRateLimit("k", { limit: 3, windowMs: 3_600_000, now: now + 1000 }, { db });
    const third = await checkAccountDeleteRateLimit("k", { limit: 3, windowMs: 3_600_000, now: now + 2000 }, { db });
    expect(first).toEqual({ allowed: true, retryAfterMs: 0, remaining: 2 });
    expect(second).toEqual({ allowed: true, retryAfterMs: 0, remaining: 1 });
    expect(third).toEqual({ allowed: true, retryAfterMs: 0, remaining: 0 });
  });

  it("denies the 4th attempt within the same window (3/hour default) with a Retry-After derived from windowStart", async () => {
    const { db } = makeMockDb();
    const now = 1_000_000;
    const windowMs = 3_600_000;
    await checkAccountDeleteRateLimit("k", { limit: 3, windowMs, now }, { db });
    await checkAccountDeleteRateLimit("k", { limit: 3, windowMs, now: now + 1000 }, { db });
    await checkAccountDeleteRateLimit("k", { limit: 3, windowMs, now: now + 2000 }, { db });
    const fourth = await checkAccountDeleteRateLimit("k", { limit: 3, windowMs, now: now + 3000 }, { db });
    expect(fourth.allowed).toBe(false);
    expect(fourth.remaining).toBe(0);
    // resetAt = windowStart(now) + windowMs; retryAfterMs = resetAt - (now + 3000)
    expect(fourth.retryAfterMs).toBe(windowMs - 3000);
  });

  it("a request that will be REJECTED still increments the durable counter (counts attempts, not just allowed ones)", async () => {
    const { db, store } = makeMockDb();
    const now = 1_000_000;
    const windowMs = 3_600_000;
    await checkAccountDeleteRateLimit("k", { limit: 1, windowMs, now }, { db });
    const second = await checkAccountDeleteRateLimit("k", { limit: 1, windowMs, now: now + 500 }, { db });
    expect(second.allowed).toBe(false);
    expect(store.get("_rateLimits/k")?.count).toBe(2);
  });

  it("resets to a fresh window once the prior window has expired, even after it was exhausted", async () => {
    const { db } = makeMockDb();
    const now = 1_000_000;
    const windowMs = 3_600_000;
    await checkAccountDeleteRateLimit("k", { limit: 1, windowMs, now }, { db });
    const stillDenied = await checkAccountDeleteRateLimit("k", { limit: 1, windowMs, now: now + 100 }, { db });
    expect(stillDenied.allowed).toBe(false);
    const afterWindow = await checkAccountDeleteRateLimit("k", { limit: 1, windowMs, now: now + windowMs + 1 }, { db });
    expect(afterWindow).toEqual({ allowed: true, retryAfterMs: 0, remaining: 0 });
  });

  it("keys distinct businessId:uid pairs independently (no cross-tenant bucket sharing)", async () => {
    const { db, store } = makeMockDb();
    const now = 1_000_000;
    await checkAccountDeleteRateLimit("DELETE:biz-1:uidA", { limit: 3, windowMs: 3_600_000, now }, { db });
    await checkAccountDeleteRateLimit("DELETE:biz-2:uidB", { limit: 3, windowMs: 3_600_000, now }, { db });
    expect(store.get("_rateLimits/DELETE:biz-1:uidA")?.count).toBe(1);
    expect(store.get("_rateLimits/DELETE:biz-2:uidB")?.count).toBe(1);
  });

  it("defaults to 3/hour when no options are passed", async () => {
    const { db } = makeMockDb();
    const now = 1_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const r1 = await checkAccountDeleteRateLimit("k", {}, { db });
    const r2 = await checkAccountDeleteRateLimit("k", {}, { db });
    const r3 = await checkAccountDeleteRateLimit("k", {}, { db });
    const r4 = await checkAccountDeleteRateLimit("k", {}, { db });
    vi.useRealTimers();
    expect([r1.allowed, r2.allowed, r3.allowed, r4.allowed]).toEqual([true, true, true, false]);
  });

  it("fails CLOSED: propagates a Firestore transaction error instead of allowing the request", async () => {
    const db = {
      collection: vi.fn(() => ({ doc: vi.fn(() => ({ path: "x" })) })),
      runTransaction: vi.fn(async () => {
        throw new Error("firestore unavailable");
      }),
    } as unknown as FirebaseFirestore.Firestore;

    await expect(checkAccountDeleteRateLimit("k", {}, { db })).rejects.toThrow("firestore unavailable");
  });

  it("uses the Admin-SDK-only _rateLimits collection (never a business-scoped or client-reachable path)", async () => {
    const { db } = makeMockDb();
    await checkAccountDeleteRateLimit("k", { now: 1 }, { db });
    expect(db.collection).toHaveBeenCalledWith("_rateLimits");
  });
});
