import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileLadderStorage } from "./storage";
import { openFoodFactsUsage } from "./openFoodFactsUsage";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "off-usage-"));
}

// Injected clock. Never call a bare `new Date()` inside these tests -- the minute
// key must be deterministic and driven only by this fixed instant.
const AT_12_34 = () => new Date("2026-07-12T12:34:10.000Z"); // minute "2026-07-12T12:34"
const AT_12_35 = () => new Date("2026-07-12T12:35:00.000Z"); // next minute

describe("openFoodFactsUsage", () => {
  let dir: string;

  beforeEach(() => {
    dir = freshDir();
  });

  it("fresh store: allowed with used 0, limit 10 (buffer under OFF's ~15/min read limit)", async () => {
    const usage = openFoodFactsUsage(fileLadderStorage(dir), { now: AT_12_34 });
    const gate = await usage.canSpend();
    expect(gate.allowed).toBe(true);
    expect(gate.used).toBe(0);
    expect(gate.limit).toBe(10);
  });

  it("record() three times increments used to 3, persisted across a fresh gate over the same dir", async () => {
    const usage = openFoodFactsUsage(fileLadderStorage(dir), { now: AT_12_34 });
    await usage.record();
    await usage.record();
    await usage.record();
    expect((await usage.canSpend()).used).toBe(3);
    const reread = openFoodFactsUsage(fileLadderStorage(dir), { now: AT_12_34 });
    expect((await reread.canSpend()).used).toBe(3);
  });

  it("used at the limit (10) blocks with a local per-minute-cap reason", async () => {
    const storage = fileLadderStorage(dir);
    for (let i = 0; i < 10; i++) await storage.increment("openfoodfacts-usage:2026-07-12T12:34");
    const usage = openFoodFactsUsage(storage, { now: AT_12_34 });
    const gate = await usage.canSpend();
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("Open Food Facts local per-minute limit reached");
    expect(gate.used).toBe(10);
  });

  it("a stored minute different from the current minute resets used to 0 (minute rollover)", async () => {
    const storage = fileLadderStorage(dir);
    for (let i = 0; i < 10; i++) await storage.increment("openfoodfacts-usage:2026-07-12T12:34"); // prior minute, at cap
    const usage = openFoodFactsUsage(storage, { now: AT_12_35 }); // next minute
    const gate = await usage.canSpend();
    expect(gate.used).toBe(0);
    expect(gate.allowed).toBe(true);
    await usage.record();
    expect(await storage.get("openfoodfacts-usage:2026-07-12T12:35")).toBe("1");
    expect(await storage.get("openfoodfacts-usage:2026-07-12T12:34")).toBe("10"); // untouched
  });

  it("record() calls storage.increment, never set directly (atomic, race-free)", async () => {
    const storage = fileLadderStorage(dir);
    const increment = vi.spyOn(storage, "increment");
    const set = vi.spyOn(storage, "set");
    const usage = openFoodFactsUsage(storage, { now: AT_12_34 });

    await usage.record();

    expect(increment).toHaveBeenCalledTimes(1);
    expect(increment).toHaveBeenCalledWith("openfoodfacts-usage:2026-07-12T12:34");
    expect(set).not.toHaveBeenCalled();
  });

  it("NEVER touches the paid Go-UPC usage key, the UPCitemdb daily key, or the AI-lookup daily cap key", async () => {
    const storage = fileLadderStorage(dir);
    const usage = openFoodFactsUsage(storage, { now: AT_12_34 });
    await usage.record();
    expect(await storage.readUsage()).toEqual({ month: "2026-07", used: 0 }); // paid Go-UPC untouched
    expect(await storage.get("upcitemdb-usage:2026-07-12")).toBeNull();
    expect(await storage.get("ai-lookup-daily-cap")).toBeNull();
  });

  describe("OPENFOODFACTS_PER_MINUTE_LIMIT env override", () => {
    let saved: string | undefined;
    beforeEach(() => {
      saved = process.env.OPENFOODFACTS_PER_MINUTE_LIMIT;
      process.env.OPENFOODFACTS_PER_MINUTE_LIMIT = "2";
    });
    afterEach(() => {
      if (saved === undefined) delete process.env.OPENFOODFACTS_PER_MINUTE_LIMIT;
      else process.env.OPENFOODFACTS_PER_MINUTE_LIMIT = saved;
    });

    it("respects OPENFOODFACTS_PER_MINUTE_LIMIT=2", async () => {
      const storage = fileLadderStorage(dir);
      for (let i = 0; i < 2; i++) await storage.increment("openfoodfacts-usage:2026-07-12T12:34");
      const usage = openFoodFactsUsage(storage, { now: AT_12_34 });
      const gate = await usage.canSpend();
      expect(gate.limit).toBe(2);
      expect(gate.allowed).toBe(false);
    });
  });
});
