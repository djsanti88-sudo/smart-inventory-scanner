import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { killSwitchOn, checkRateLimit, readDailyUsed, chargeDailySlot, __resetForTest } from "./aiSpendGuard";

/** In-memory StorageLike stub matching the ladder storage's minimal get/set/increment surface. */
function memStorage() {
  const m = new Map<string, string>();
  return {
    async get(k: string) { return m.get(k) ?? null; },
    async set(k: string, v: string) { m.set(k, v); },
    async increment(k: string) { const n = Number(m.get(k) ?? "0") + 1; m.set(k, String(n)); return n; },
  };
}

describe("aiSpendGuard", () => {
  let tmpFile: string;
  beforeEach(() => {
    __resetForTest();
    tmpFile = path.join(os.tmpdir(), `ai-usage-${process.pid}-${Math.floor(Math.random() * 1e9)}.json`);
  });
  afterEach(() => {
    try { fs.unlinkSync(tmpFile); } catch {}
  });

  describe("killSwitchOn", () => {
    it("is off by default and on for 1/true", () => {
      expect(killSwitchOn({} as NodeJS.ProcessEnv)).toBe(false);
      expect(killSwitchOn({ AI_LOOKUP_KILL_SWITCH: "1" } as unknown as NodeJS.ProcessEnv)).toBe(true);
      expect(killSwitchOn({ AI_LOOKUP_KILL_SWITCH: "true" } as unknown as NodeJS.ProcessEnv)).toBe(true);
      expect(killSwitchOn({ AI_LOOKUP_KILL_SWITCH: "0" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    });
  });

  // checkRateLimit without opts.storage: the documented dev/no-storage in-memory fallback (unchanged
  // behavior from before B1 - still async now, but no durable storage involved).
  describe("checkRateLimit (in-memory fallback, no storage)", () => {
    it("allows up to the limit then blocks within the window", async () => {
      const ip = "1.2.3.4";
      const now = 1_000_000;
      for (let i = 0; i < 3; i++) {
        expect((await checkRateLimit(ip, { limit: 3, windowMs: 1000, now })).allowed).toBe(true);
      }
      const blocked = await checkRateLimit(ip, { limit: 3, windowMs: 1000, now });
      expect(blocked.allowed).toBe(false);
      expect(blocked.retryAfterMs).toBeGreaterThan(0);
    });

    it("resets after the window elapses", async () => {
      const ip = "5.6.7.8";
      await checkRateLimit(ip, { limit: 1, windowMs: 1000, now: 0 });
      expect((await checkRateLimit(ip, { limit: 1, windowMs: 1000, now: 500 })).allowed).toBe(false);
      expect((await checkRateLimit(ip, { limit: 1, windowMs: 1000, now: 1500 })).allowed).toBe(true);
    });

    it("tracks IPs independently", async () => {
      expect((await checkRateLimit("a", { limit: 1, windowMs: 1000, now: 0 })).allowed).toBe(true);
      expect((await checkRateLimit("a", { limit: 1, windowMs: 1000, now: 0 })).allowed).toBe(false);
      expect((await checkRateLimit("b", { limit: 1, windowMs: 1000, now: 0 })).allowed).toBe(true);
    });

    it("treats an empty AI_LOOKUP_RATE_LIMIT env as the default (600), not 0", async () => {
      const prev = process.env.AI_LOOKUP_RATE_LIMIT;
      process.env.AI_LOOKUP_RATE_LIMIT = ""; // present-but-blank, the env-pull failure mode
      try {
        const ip = "9.9.9.9";
        const now = 2_000_000;
        // With the bug (blank -> Number("") = 0) the 2nd call is blocked; with the default 600 all
        // 600 pass and the 601st is blocked (proves the default is exactly 600, not merely nonzero).
        for (let i = 0; i < 600; i++) {
          expect((await checkRateLimit(ip, { windowMs: 60_000, now })).allowed).toBe(true);
        }
        expect((await checkRateLimit(ip, { windowMs: 60_000, now })).allowed).toBe(false);
      } finally {
        if (prev === undefined) delete process.env.AI_LOOKUP_RATE_LIMIT;
        else process.env.AI_LOOKUP_RATE_LIMIT = prev;
      }
    });

    // Bulk-scan contract (owner report 2026-07-22): a fast 300-code scan session must never mass-429
    // under the DEFAULT limit (no env override, no opts.limit) - the old 120 default failed this.
    it("300 sequential checks within one window all pass under the default limit", async () => {
      const prev = process.env.AI_LOOKUP_RATE_LIMIT;
      delete process.env.AI_LOOKUP_RATE_LIMIT; // exercise the true built-in default
      try {
        const ip = "7.7.7.7";
        const now = 3_000_000;
        for (let i = 0; i < 300; i++) {
          expect((await checkRateLimit(ip, { windowMs: 60_000, now })).allowed).toBe(true);
        }
      } finally {
        if (prev !== undefined) process.env.AI_LOOKUP_RATE_LIMIT = prev;
      }
    });
  });

  // B1: durable storage-backed rate limiting - same fixed-window contract, but backed by the
  // injected LadderStorage-shaped get/set/increment seam (mirrors chargeDailySlot's pattern).
  describe("checkRateLimit (durable, storage-backed)", () => {
    it("allows up to the limit then blocks within the window", async () => {
      const s = memStorage();
      const ip = "1.2.3.4";
      const now = 1_000_000;
      for (let i = 0; i < 3; i++) {
        expect((await checkRateLimit(ip, { limit: 3, windowMs: 1000, now, storage: s })).allowed).toBe(true);
      }
      const blocked = await checkRateLimit(ip, { limit: 3, windowMs: 1000, now, storage: s });
      expect(blocked.allowed).toBe(false);
      expect(blocked.retryAfterMs).toBeGreaterThan(0);
    });

    it("resets after the window elapses (new window key)", async () => {
      const s = memStorage();
      const ip = "5.6.7.8";
      await checkRateLimit(ip, { limit: 1, windowMs: 1000, now: 0, storage: s });
      expect((await checkRateLimit(ip, { limit: 1, windowMs: 1000, now: 500, storage: s })).allowed).toBe(false);
      expect((await checkRateLimit(ip, { limit: 1, windowMs: 1000, now: 1500, storage: s })).allowed).toBe(true);
    });

    it("tracks IPs independently under the same storage handle", async () => {
      const s = memStorage();
      expect((await checkRateLimit("a", { limit: 1, windowMs: 1000, now: 0, storage: s })).allowed).toBe(true);
      expect((await checkRateLimit("a", { limit: 1, windowMs: 1000, now: 0, storage: s })).allowed).toBe(false);
      expect((await checkRateLimit("b", { limit: 1, windowMs: 1000, now: 0, storage: s })).allowed).toBe(true);
    });

    // B1 TDD: two separate "instances" (two independent process-local Maps, e.g. two serverless
    // warm lambdas) sharing ONE durable store must see and enforce the SAME limit - the whole point
    // of moving off the in-memory Map.
    it("two independent instances sharing one storage handle enforce ONE shared limit", async () => {
      const sharedStorage = memStorage();
      const ip = "10.0.0.1";
      const now = 5_000_000;
      // "Instance A" and "Instance B" are just two separate calls - checkRateLimit has no
      // process-local state when storage is supplied, so this simulates two warm lambdas.
      const a1 = await checkRateLimit(ip, { limit: 2, windowMs: 1000, now, storage: sharedStorage });
      const b1 = await checkRateLimit(ip, { limit: 2, windowMs: 1000, now, storage: sharedStorage });
      const a2 = await checkRateLimit(ip, { limit: 2, windowMs: 1000, now, storage: sharedStorage });
      expect(a1.allowed).toBe(true);
      expect(b1.allowed).toBe(true);
      expect(a2.allowed).toBe(false); // 3rd request in the same window, same shared limit of 2
    });

    // TDD: a storage error must fail OPEN to the in-memory fallback, never fail-closed (a Turso
    // hiccup must not 429 the whole app).
    it("falls back to in-memory allow-through when storage.increment throws", async () => {
      __resetForTest();
      const brokenStorage = {
        async get() { return null; },
        async set() {},
        async increment(): Promise<number> { throw new Error("storage unavailable"); },
      };
      const ip = "8.8.8.8";
      const r = await checkRateLimit(ip, { limit: 3, windowMs: 1000, now: 100, storage: brokenStorage });
      expect(r.allowed).toBe(true); // fails OPEN, not closed
    });

    it("window start rolls over to a NEW key at the boundary (durable window rollover)", async () => {
      const s = memStorage();
      const ip = "3.3.3.3";
      // limit 1, windowMs 1000: now=999 is still window 0; now=1000 is window 1.
      expect((await checkRateLimit(ip, { limit: 1, windowMs: 1000, now: 999, storage: s })).allowed).toBe(true);
      expect((await checkRateLimit(ip, { limit: 1, windowMs: 1000, now: 999, storage: s })).allowed).toBe(false);
      expect((await checkRateLimit(ip, { limit: 1, windowMs: 1000, now: 1000, storage: s })).allowed).toBe(true);
    });

    // BUG (Codex interaction review, 2026-07-27): ai-lookup POST and every catalog route
    // (catalog-dispute, catalog-review GET, catalog-review/[id] POST) all called
    // checkRateLimit(ip, ...) with the RAW ip and no route-family prefix, so they shared ONE
    // bucket per client IP. A bulk-scan session hammering ai-lookup could exhaust the shared
    // bucket and 429 an unrelated catalog-dispute request from the SAME IP (and vice versa), even
    // though each route defines its OWN limit env var (AI_LOOKUP_RATE_LIMIT vs
    // CATALOG_DISPUTE_RATE_LIMIT) - proof the routes were never meant to share one counter. The
    // fix: each route's key carries its own UPPERCASE route-family prefix (matching the existing
    // `GET:${ip}` / `EXPORT:${ip}` convention and the actual literals the routes now use:
    // `POST:${ip}` for ai-lookup, `DISPUTE:${ip}` for catalog-dispute), so route A's traffic can
    // never burn route B's limit.
    describe("cross-route bucket isolation (route-prefixed keys)", () => {
      it("exhausting one route's bucket for an IP does not block a DIFFERENT route's bucket for the same IP", async () => {
        const s = memStorage();
        const ip = "42.42.42.42";
        const now = 9_000_000;

        // Route A ("ai-lookup" POST) exhausts its own tiny limit of 1, using the ACTUAL prefix
        // ai-lookup/route.ts passes to checkRateLimit: `POST:${clientIp}`.
        const a1 = await checkRateLimit(`POST:${ip}`, { limit: 1, windowMs: 60_000, now, storage: s });
        const a2 = await checkRateLimit(`POST:${ip}`, { limit: 1, windowMs: 60_000, now, storage: s });
        expect(a1.allowed).toBe(true);
        expect(a2.allowed).toBe(false); // route A's own bucket is exhausted

        // Route B ("catalog-dispute" POST) for the SAME client IP, same window, must still be
        // allowed - it has its own bucket because the key carries a distinct route prefix, using
        // the ACTUAL prefix catalog-dispute/route.ts passes: `DISPUTE:${ip}`.
        const b1 = await checkRateLimit(`DISPUTE:${ip}`, { limit: 1, windowMs: 60_000, now, storage: s });
        expect(b1.allowed).toBe(true);
      });

      // Reproduces the actual pre-fix call shape: every route calling checkRateLimit(ip, ...) with
      // the bare IP (no prefix at all) collapses onto ONE shared key, so route A's traffic exhausts
      // route B's limit even though the routes define different limits. This is the failing case
      // that the route-prefix fix (checkRateLimit(`PREFIX:${ip}`, ...)) eliminates.
      it("[pre-fix reproduction] bare-IP keys let one route's traffic exhaust a different route's limit", async () => {
        const s = memStorage();
        const ip = "42.42.42.42";
        const now = 9_000_000;

        // Simulates a bulk-scan session hammering ai-lookup POST's pre-fix call shape:
        // checkRateLimit(clientIp, { storage }) - bare IP, ai-lookup's own (larger) limit of 600.
        for (let i = 0; i < 5; i++) {
          const a = await checkRateLimit(ip, { limit: 600, windowMs: 60_000, now, storage: s });
          expect(a.allowed).toBe(true);
        }

        // Simulates catalog-dispute POST's pre-fix call: checkRateLimit(ip, { storage }) - same bare
        // IP, same shared bucket/counter (now at 5), even though catalog-dispute configures its own
        // much tighter limit (e.g. CATALOG_DISPUTE_RATE_LIMIT default of 5). The 6th increment on the
        // SHARED counter blows past catalog-dispute's limit purely because of ai-lookup's traffic.
        const b1 = await checkRateLimit(ip, { limit: 5, windowMs: 60_000, now, storage: s });
        // With bare (unprefixed) keys this is falsely blocked by ai-lookup's traffic - proves the bug.
        expect(b1.allowed).toBe(false);
      });
    });
  });

  // v2 (hardened): atomic, storage-backed daily cap. readDailyUsed is a pure read (gates + GET);
  // chargeDailySlot is the ONLY write, and it must be called exactly once per genuine paid rung -
  // never at the route gate, never twice per request (the "232/200 while ~27 paid calls happened"
  // bug: the old counter incremented on rejected requests too).
  describe("daily cap v2 (atomic, storage-backed)", () => {
    it("read-only check never writes", async () => {
      const s = memStorage();
      expect(await readDailyUsed(s, "2026-07-09")).toBe(0);
      expect(await readDailyUsed(s, "2026-07-09")).toBe(0); // still 0 - no phantom increments
    });

    it("charge increments exactly once per call", async () => {
      const s = memStorage();
      const r1 = await chargeDailySlot(s, { limit: 200, dateKey: "2026-07-09" });
      const r2 = await chargeDailySlot(s, { limit: 200, dateKey: "2026-07-09" });
      expect(r1.used).toBe(1);
      expect(r2.used).toBe(2);
      expect(r1.limit).toBe(200);
      expect(r2.limit).toBe(200);
    });

    it("20 concurrent charges land on exactly 20 (atomicity contract)", async () => {
      const s = memStorage();
      await Promise.all(Array.from({ length: 20 }, () => chargeDailySlot(s, { limit: 200, dateKey: "2026-07-09" })));
      expect(await readDailyUsed(s, "2026-07-09")).toBe(20);
    });

    it("resets on a new date key", async () => {
      const s = memStorage();
      await chargeDailySlot(s, { limit: 5, dateKey: "2026-07-08" });
      expect(await readDailyUsed(s, "2026-07-09")).toBe(0);
    });

    it("readDailyUsed defaults to today's date key when none is passed", async () => {
      const s = memStorage();
      await chargeDailySlot(s); // defaults to today
      expect(await readDailyUsed(s)).toBe(1);
    });

    it("chargeDailySlot defaults limit from AI_LOOKUP_DAILY_LIMIT (blank env -> 2000 default, not 0)", async () => {
      const prev = process.env.AI_LOOKUP_DAILY_LIMIT;
      process.env.AI_LOOKUP_DAILY_LIMIT = "";
      try {
        const s = memStorage();
        const r = await chargeDailySlot(s, { dateKey: "2026-07-09" });
        expect(r.limit).toBe(2000);
      } finally {
        if (prev === undefined) delete process.env.AI_LOOKUP_DAILY_LIMIT;
        else process.env.AI_LOOKUP_DAILY_LIMIT = prev;
      }
    });
  });

  // B8 (2026-07-15): the cap has two historical bugs (double-billing across two request paths -
  // LESSONS L12 - and the 232/200 counter that incremented on REJECTED requests). Storage-level
  // atomicity is already proven above ("20 concurrent charges land on exactly 20"). This block adds
  // the GUARD-level contract: (a) a wider concurrent burst still bills exactly once per genuine call,
  // and (b) the pipeline's actual read-check-charge dance (readDailyUsed then chargeDailySlot, NOT a
  // single atomic compare-and-swap) has a KNOWN, BOUNDED TOCTOU window - concurrent callers can all
  // pass the read-check before any of them charges, so overshoot is bounded by concurrency, never
  // unbounded. This documents the accepted semantics; it does not claim the race is eliminated.
  describe("B8 daily cap race contract (guard level)", () => {
    it("50 parallel chargeDailySlot calls bill exactly 50 (no lost increments)", async () => {
      const s = memStorage();
      await Promise.all(Array.from({ length: 50 }, () => chargeDailySlot(s, { limit: 500, dateKey: "2026-07-15" })));
      expect(await readDailyUsed(s, "2026-07-15")).toBe(50);
    });

    it("read-then-charge overshoot is bounded by caller concurrency (documented TOCTOU)", async () => {
      // limit 10, 15 concurrent callers doing the pipeline's read-check-charge dance:
      const s = memStorage();
      const limit = 10;
      let charged = 0;
      await Promise.all(Array.from({ length: 15 }, async () => {
        const used = await readDailyUsed(s, "2026-07-15");
        if (used >= limit) return;
        await chargeDailySlot(s, { limit, dateKey: "2026-07-15" });
        charged++;
      }));
      // The check-then-charge window means up to (concurrency) overshoot, never unbounded:
      expect(charged).toBeGreaterThanOrEqual(10);
      expect(charged).toBeLessThanOrEqual(15);
    });
  });
});
