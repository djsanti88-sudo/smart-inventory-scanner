import { describe, expect, it, vi } from "vitest";
import { TrustedExactMembershipCache } from "./trustedExactMembershipCache";

describe("TrustedExactMembershipCache", () => {
  it("caches only a positive membership result for its TTL", async () => {
    let now = 1_000;
    const read = vi.fn().mockResolvedValue(true);
    const cache = new TrustedExactMembershipCache({ now: () => now, ttlMs: 30_000 });

    await expect(cache.get("uid-a", "business-a", read)).resolves.toBe(true);
    await expect(cache.get("uid-a", "business-a", read)).resolves.toBe(true);
    expect(read).toHaveBeenCalledOnce();

    now += 30_000;
    await expect(cache.get("uid-a", "business-a", read)).resolves.toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("does not cache absent memberships or read errors", async () => {
    const cache = new TrustedExactMembershipCache();
    const absent = vi.fn().mockResolvedValue(false);
    await expect(cache.get("uid-a", "business-a", absent)).resolves.toBe(false);
    await expect(cache.get("uid-a", "business-a", absent)).resolves.toBe(false);
    expect(absent).toHaveBeenCalledTimes(2);

    const rejected = vi.fn().mockRejectedValue(new Error("Firestore unavailable"));
    await expect(cache.get("uid-a", "business-a", rejected)).rejects.toThrow("Firestore unavailable");
    await expect(cache.get("uid-a", "business-a", rejected)).rejects.toThrow("Firestore unavailable");
    expect(rejected).toHaveBeenCalledTimes(2);
  });

  it("coalesces simultaneous reads for one uid and business", async () => {
    const cache = new TrustedExactMembershipCache();
    let resolve!: (value: boolean) => void;
    const read = vi.fn(() => new Promise<boolean>((done) => { resolve = done; }));

    const first = cache.get("uid-a", "business-a", read);
    const second = cache.get("uid-a", "business-a", read);
    expect(read).toHaveBeenCalledOnce();
    resolve(true);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
  });

  it("fails closed when distinct in-flight membership reads reach the bound", async () => {
    const cache = new TrustedExactMembershipCache({ maxInFlight: 2 });
    const resolvers: Array<(value: boolean) => void> = [];
    const read = vi.fn(() => new Promise<boolean>((done) => { resolvers.push(done); }));

    const first = cache.get("uid-a", "business-a", read);
    const second = cache.get("uid-b", "business-b", read);
    const firstCoalesced = cache.get("uid-a", "business-a", read);

    await expect(cache.get("uid-c", "business-c", read)).resolves.toBe(false);
    expect(read).toHaveBeenCalledTimes(2);

    resolvers[0](true);
    resolvers[1](false);
    await expect(Promise.all([first, second, firstCoalesced])).resolves.toEqual([true, false, true]);

    await expect(cache.get("uid-c", "business-c", vi.fn().mockResolvedValue(true))).resolves.toBe(true);
  });

  it("keeps at most 2,000 least-recently-used positive entries", async () => {
    const cache = new TrustedExactMembershipCache({ maxEntries: 2 });
    const read = vi.fn().mockResolvedValue(true);
    await cache.get("uid", "oldest", read);
    await cache.get("uid", "newest", read);
    await cache.get("uid", "oldest", read); // refresh oldest's LRU position
    await cache.get("uid", "third", read);

    expect(cache.size).toBe(2);
    await cache.get("uid", "newest", read);
    expect(read).toHaveBeenCalledTimes(4); // newest was evicted, oldest was retained
  });
});
