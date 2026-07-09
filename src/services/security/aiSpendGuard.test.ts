import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { killSwitchOn, checkRateLimit, checkAndIncrementDaily, dailyUsage, readDailyUsed, chargeDailySlot, __resetForTest } from "./aiSpendGuard";

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

  describe("checkRateLimit", () => {
    it("allows up to the limit then blocks within the window", () => {
      const ip = "1.2.3.4";
      const now = 1_000_000;
      for (let i = 0; i < 3; i++) {
        expect(checkRateLimit(ip, { limit: 3, windowMs: 1000, now }).allowed).toBe(true);
      }
      const blocked = checkRateLimit(ip, { limit: 3, windowMs: 1000, now });
      expect(blocked.allowed).toBe(false);
      expect(blocked.retryAfterMs).toBeGreaterThan(0);
    });

    it("resets after the window elapses", () => {
      const ip = "5.6.7.8";
      checkRateLimit(ip, { limit: 1, windowMs: 1000, now: 0 });
      expect(checkRateLimit(ip, { limit: 1, windowMs: 1000, now: 500 }).allowed).toBe(false);
      expect(checkRateLimit(ip, { limit: 1, windowMs: 1000, now: 1500 }).allowed).toBe(true);
    });

    it("tracks IPs independently", () => {
      expect(checkRateLimit("a", { limit: 1, windowMs: 1000, now: 0 }).allowed).toBe(true);
      expect(checkRateLimit("a", { limit: 1, windowMs: 1000, now: 0 }).allowed).toBe(false);
      expect(checkRateLimit("b", { limit: 1, windowMs: 1000, now: 0 }).allowed).toBe(true);
    });

    it("treats an empty AI_LOOKUP_RATE_LIMIT env as the default (30), not 0", () => {
      const prev = process.env.AI_LOOKUP_RATE_LIMIT;
      process.env.AI_LOOKUP_RATE_LIMIT = ""; // present-but-blank, the env-pull failure mode
      try {
        const ip = "9.9.9.9";
        const now = 2_000_000;
        // With the bug (blank -> Number("") = 0) the 2nd call is blocked; with the default 30 all pass.
        for (let i = 0; i < 5; i++) {
          expect(checkRateLimit(ip, { windowMs: 60_000, now }).allowed).toBe(true);
        }
      } finally {
        if (prev === undefined) delete process.env.AI_LOOKUP_RATE_LIMIT;
        else process.env.AI_LOOKUP_RATE_LIMIT = prev;
      }
    });
  });

  describe("checkAndIncrementDaily", () => {
    it("increments and blocks once the daily cap is hit, making zero further calls", () => {
      const o = { limit: 2, file: tmpFile, dateKey: "2026-06-28" };
      expect(checkAndIncrementDaily(o)).toEqual({ allowed: true, used: 1, limit: 2 });
      expect(checkAndIncrementDaily(o)).toEqual({ allowed: true, used: 2, limit: 2 });
      expect(checkAndIncrementDaily(o)).toEqual({ allowed: false, used: 2, limit: 2 });
      // still blocked on repeat
      expect(checkAndIncrementDaily(o).allowed).toBe(false);
    });

    it("persists across a process restart (re-read from file, in-memory cleared)", () => {
      const o = { limit: 5, file: tmpFile, dateKey: "2026-06-28" };
      checkAndIncrementDaily(o);
      checkAndIncrementDaily(o);
      __resetForTest(); // simulate a fresh process
      expect(checkAndIncrementDaily(o)).toEqual({ allowed: true, used: 3, limit: 5 });
    });

    it("resets on a new date", () => {
      const file = tmpFile;
      checkAndIncrementDaily({ limit: 1, file, dateKey: "2026-06-28" });
      expect(checkAndIncrementDaily({ limit: 1, file, dateKey: "2026-06-28" }).allowed).toBe(false);
      // new day -> fresh budget
      expect(checkAndIncrementDaily({ limit: 1, file, dateKey: "2026-06-29" }).allowed).toBe(true);
    });

    it("treats an empty AI_LOOKUP_DAILY_LIMIT env as the default 200, not 0 (regression: blank env -> 0 cap blocked ALL decode)", () => {
      const prev = process.env.AI_LOOKUP_DAILY_LIMIT;
      process.env.AI_LOOKUP_DAILY_LIMIT = ""; // the production failure: var present but blank
      try {
        // No explicit opts.limit -> reads env -> blank must fall back to 200 -> ALLOWED, not blocked at 0/0.
        const r = checkAndIncrementDaily({ file: tmpFile, dateKey: "2026-06-28" });
        expect(r.allowed).toBe(true);
        expect(r.limit).toBe(200);
      } finally {
        if (prev === undefined) delete process.env.AI_LOOKUP_DAILY_LIMIT;
        else process.env.AI_LOOKUP_DAILY_LIMIT = prev;
      }
    });

    it("dailyUsage peeks without incrementing", () => {
      const o = { file: tmpFile, dateKey: "2026-06-28" };
      checkAndIncrementDaily({ ...o, limit: 10 });
      expect(dailyUsage(o).count).toBe(1);
      expect(dailyUsage(o).count).toBe(1); // peek does not increment
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

    it("chargeDailySlot defaults limit from AI_LOOKUP_DAILY_LIMIT (blank env -> 200, not 0)", async () => {
      const prev = process.env.AI_LOOKUP_DAILY_LIMIT;
      process.env.AI_LOOKUP_DAILY_LIMIT = "";
      try {
        const s = memStorage();
        const r = await chargeDailySlot(s, { dateKey: "2026-07-09" });
        expect(r.limit).toBe(200);
      } finally {
        if (prev === undefined) delete process.env.AI_LOOKUP_DAILY_LIMIT;
        else process.env.AI_LOOKUP_DAILY_LIMIT = prev;
      }
    });
  });
});
