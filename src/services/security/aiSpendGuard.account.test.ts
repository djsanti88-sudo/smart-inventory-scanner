import { describe, it, expect } from "vitest";
import { perAccountDailyKey, readDailyUsedForAccount, chargeDailySlotForAccount } from "./aiSpendGuard";

function memStore() {
  const m = new Map<string, string>();
  return {
    async get(k: string) { return m.get(k) ?? null; },
    async set(k: string, v: string) { m.set(k, v); },
    async increment(k: string) { const n = (Number(m.get(k) ?? 0) || 0) + 1; m.set(k, String(n)); return n; },
    async incrementIfBelow(k: string, limit: number) {
      const current = (Number(m.get(k) ?? 0) || 0);
      if (!(current < limit)) return { value: current, granted: false };
      const next = current + 1;
      m.set(k, String(next));
      return { value: next, granted: true };
    },
  };
}

describe("per-account daily quota", () => {
  it("keys by businessId and date, distinct from the global key", () => {
    expect(perAccountDailyKey("b1", "2026-06-12")).toBe("ai_daily_cap:b1:2026-06-12");
    expect(perAccountDailyKey("b1", "2026-06-12")).not.toBe("ai_daily_cap:2026-06-12");
  });
  it("reads zero before any charge and counts charges per account", async () => {
    const s = memStore();
    expect(await readDailyUsedForAccount(s, "b1", "d")).toBe(0);
    await chargeDailySlotForAccount(s, "b1", "d");
    await chargeDailySlotForAccount(s, "b1", "d");
    expect(await readDailyUsedForAccount(s, "b1", "d")).toBe(2);
    expect(await readDailyUsedForAccount(s, "b2", "d")).toBe(0); // isolated per account
  });
});
