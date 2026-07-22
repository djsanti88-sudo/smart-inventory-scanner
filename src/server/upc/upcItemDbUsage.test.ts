import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileLadderStorage } from "./storage";
import { upcItemDbUsage } from "./upcItemDbUsage";

// `server-only` is aliased to a no-op stub by vitest.config.ts, so importing this
// server-only module in the node unit project is safe (same as goUpcUsage tests).

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "upcitemdb-usage-"));
}

// Injected clock. Never call a bare `new Date()` inside these tests -- the day
// key must be deterministic and driven only by this fixed instant.
const AT_JULY_12 = () => new Date("2026-07-12T12:00:00.000Z"); // day "2026-07-12"

describe("upcItemDbUsage", () => {
  let dir: string;

  beforeEach(() => {
    dir = freshDir();
  });

  it("fresh store: allowed with used 0, limit 90 (buffer under UPCitemdb's 100/day)", async () => {
    const usage = upcItemDbUsage(fileLadderStorage(dir), { now: AT_JULY_12 });
    const gate = await usage.canSpend();
    expect(gate.allowed).toBe(true);
    expect(gate.used).toBe(0);
    expect(gate.limit).toBe(90);
  });

  it("record() three times increments used to 3, persisted across a fresh gate over the same dir", async () => {
    const usage = upcItemDbUsage(fileLadderStorage(dir), { now: AT_JULY_12 });
    await usage.record();
    await usage.record();
    await usage.record();
    expect((await usage.canSpend()).used).toBe(3);
    const reread = upcItemDbUsage(fileLadderStorage(dir), { now: AT_JULY_12 });
    expect((await reread.canSpend()).used).toBe(3);
  });

  it("used at the limit (90) blocks with a local-cap reason", async () => {
    const storage = fileLadderStorage(dir);
    for (let i = 0; i < 90; i++) await storage.increment(`upcitemdb-usage:2026-07-12`);
    const usage = upcItemDbUsage(storage, { now: AT_JULY_12 });
    const gate = await usage.canSpend();
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("UPCitemdb local daily limit reached");
    expect(gate.used).toBe(90);
  });

  it("a stored day different from the current day resets used to 0 (day rollover)", async () => {
    const storage = fileLadderStorage(dir);
    for (let i = 0; i < 90; i++) await storage.increment(`upcitemdb-usage:2026-07-11`); // yesterday, at cap
    const usage = upcItemDbUsage(storage, { now: AT_JULY_12 }); // today
    const gate = await usage.canSpend();
    expect(gate.used).toBe(0);
    expect(gate.allowed).toBe(true);
    // recording after rollover writes under TODAY's key, not yesterday's
    await usage.record();
    expect(await storage.get("upcitemdb-usage:2026-07-12")).toBe("1");
    expect(await storage.get("upcitemdb-usage:2026-07-11")).toBe("90"); // untouched
  });

  it("record() calls storage.increment, never get/set directly for the write path (atomic, race-free)", async () => {
    const storage = fileLadderStorage(dir);
    const increment = vi.spyOn(storage, "increment");
    const set = vi.spyOn(storage, "set");
    const usage = upcItemDbUsage(storage, { now: AT_JULY_12 });

    await usage.record();

    expect(increment).toHaveBeenCalledTimes(1);
    expect(increment).toHaveBeenCalledWith("upcitemdb-usage:2026-07-12");
    expect(set).not.toHaveBeenCalled();
  });

  it("NEVER touches the paid Go-UPC usage key or the daily AI-lookup cap key (own namespace)", async () => {
    const storage = fileLadderStorage(dir);
    const usage = upcItemDbUsage(storage, { now: AT_JULY_12 });
    await usage.record();
    // The paid Go-UPC usage file is untouched (still default month/used 0).
    expect(await storage.readUsage()).toEqual({ month: "2026-07", used: 0 });
    // No key resembling the AI-lookup daily cap's own namespace was ever written.
    expect(await storage.get("ai-lookup-daily-cap")).toBeNull();
  });

  describe("UPCITEMDB_DAILY_LIMIT env override", () => {
    let saved: string | undefined;
    beforeEach(() => {
      saved = process.env.UPCITEMDB_DAILY_LIMIT;
      process.env.UPCITEMDB_DAILY_LIMIT = "5";
    });
    afterEach(() => {
      if (saved === undefined) delete process.env.UPCITEMDB_DAILY_LIMIT;
      else process.env.UPCITEMDB_DAILY_LIMIT = saved;
    });

    it("respects UPCITEMDB_DAILY_LIMIT=5", async () => {
      const storage = fileLadderStorage(dir);
      for (let i = 0; i < 5; i++) await storage.increment("upcitemdb-usage:2026-07-12");
      const usage = upcItemDbUsage(storage, { now: AT_JULY_12 });
      const gate = await usage.canSpend();
      expect(gate.limit).toBe(5);
      expect(gate.allowed).toBe(false);
    });
  });
});
