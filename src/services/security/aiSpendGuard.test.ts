import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { killSwitchOn, checkRateLimit, checkAndIncrementDaily, dailyUsage, __resetForTest } from "./aiSpendGuard";

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

    it("dailyUsage peeks without incrementing", () => {
      const o = { file: tmpFile, dateKey: "2026-06-28" };
      checkAndIncrementDaily({ ...o, limit: 10 });
      expect(dailyUsage(o).count).toBe(1);
      expect(dailyUsage(o).count).toBe(1); // peek does not increment
    });
  });
});
