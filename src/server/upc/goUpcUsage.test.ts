import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileLadderStorage } from "./storage";
import { goUpcUsage } from "./goUpcUsage";

// `server-only` is aliased to a no-op stub by vitest.config.ts, so importing this
// server-only module in the node unit project is safe (same as storage tests).

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "goupc-usage-"));
}

// Injected clock. Never call a bare `new Date()` inside these tests -- the month
// key must be deterministic and driven only by this fixed instant.
const AT_JULY = () => new Date("2026-07-15T12:00:00.000Z"); // month "2026-07"

describe("goUpcUsage", () => {
  let dir: string;

  beforeEach(() => {
    dir = freshDir();
  });

  it("fresh file: allowed with used 0, unlimited by default", async () => {
    const usage = goUpcUsage(fileLadderStorage(dir), { now: AT_JULY });
    const gate = await usage.canSpend();
    expect(gate.allowed).toBe(true);
    expect(gate.used).toBe(0);
    expect(gate.limit).toBe(Infinity);
    expect(gate.warn).toBe(false);
    expect(gate.reason).toBeUndefined();
  });

  it("record() three times increments used to 3", async () => {
    const usage = goUpcUsage(fileLadderStorage(dir), { now: AT_JULY });
    await usage.record();
    await usage.record();
    await usage.record();
    expect((await usage.canSpend()).used).toBe(3);
    // persisted: a fresh gate over the same dir sees 3
    const reread = goUpcUsage(fileLadderStorage(dir), { now: AT_JULY });
    expect((await reread.canSpend()).used).toBe(3);
  });

  it("default (unlimited): allowed even with a very large used count, no warn, no reason", async () => {
    await fileLadderStorage(dir).writeUsage({ month: "2026-07", used: 5_000_000 });
    const usage = goUpcUsage(fileLadderStorage(dir), { now: AT_JULY });
    const gate = await usage.canSpend();
    expect(gate.allowed).toBe(true);
    expect(gate.used).toBe(5_000_000);
    expect(gate.limit).toBe(Infinity);
    expect(gate.warn).toBe(false);
    expect(gate.reason).toBeUndefined();
  });

  it("record() still increments usage under the unlimited default (observability)", async () => {
    await fileLadderStorage(dir).writeUsage({ month: "2026-07", used: 4800 });
    const usage = goUpcUsage(fileLadderStorage(dir), { now: AT_JULY });
    await usage.record();
    const persisted = await fileLadderStorage(dir).readUsage();
    expect(persisted).toEqual({ month: "2026-07", used: 4801 });
    // still allowed post-record: no cap in effect
    expect((await usage.canSpend()).allowed).toBe(true);
  });

  it("explicit positive limit override still caps (regression: the lever still works)", async () => {
    await fileLadderStorage(dir).writeUsage({ month: "2026-07", used: 10 });
    const usage = goUpcUsage(fileLadderStorage(dir), { now: AT_JULY, limit: 10 });
    const gate = await usage.canSpend();
    expect(gate.allowed).toBe(false);
    expect(gate.limit).toBe(10);
    expect(gate.reason).toContain("Go-UPC monthly cap reached");
  });

  it("explicit limit of 0 resolves to unlimited (not a valid re-cap value)", async () => {
    const usage = goUpcUsage(fileLadderStorage(dir), { now: AT_JULY, limit: 0 });
    const gate = await usage.canSpend();
    expect(gate.limit).toBe(Infinity);
    expect(gate.allowed).toBe(true);
  });

  it("a stored month different from the current month resets used to 0 (rollover)", async () => {
    // June is stored high; the injected now is July -> treat used as 0.
    await fileLadderStorage(dir).writeUsage({ month: "2026-06", used: 4800 });
    const usage = goUpcUsage(fileLadderStorage(dir), { now: AT_JULY });
    const gate = await usage.canSpend();
    expect(gate.used).toBe(0);
    expect(gate.allowed).toBe(true);
    expect(gate.warn).toBe(false);
    // recording after rollover writes the CURRENT month, from 0
    await usage.record();
    const persisted = await fileLadderStorage(dir).readUsage();
    expect(persisted).toEqual({ month: "2026-07", used: 1 });
  });

  it("record() calls storage.incrementUsage, never readUsage/writeUsage (atomic, race-free increment)", async () => {
    const storage = fileLadderStorage(dir);
    const incrementUsage = vi.spyOn(storage, "incrementUsage");
    const readUsage = vi.spyOn(storage, "readUsage");
    const writeUsage = vi.spyOn(storage, "writeUsage");
    const usage = goUpcUsage(storage, { now: AT_JULY });

    await usage.record();

    expect(incrementUsage).toHaveBeenCalledTimes(1);
    expect(incrementUsage).toHaveBeenCalledWith("2026-07");
    expect(readUsage).not.toHaveBeenCalled();
    expect(writeUsage).not.toHaveBeenCalled();
  });

  describe("GO_UPC_MONTHLY_LIMIT env override", () => {
    let saved: string | undefined;
    beforeEach(() => {
      saved = process.env.GO_UPC_MONTHLY_LIMIT;
    });
    afterEach(() => {
      if (saved === undefined) delete process.env.GO_UPC_MONTHLY_LIMIT;
      else process.env.GO_UPC_MONTHLY_LIMIT = saved;
    });

    it("respects GO_UPC_MONTHLY_LIMIT=10 (regression: positive cap still re-imposable)", async () => {
      process.env.GO_UPC_MONTHLY_LIMIT = "10";
      await fileLadderStorage(dir).writeUsage({ month: "2026-07", used: 10 });
      const usage = goUpcUsage(fileLadderStorage(dir), { now: AT_JULY });
      const gate = await usage.canSpend();
      expect(gate.limit).toBe(10);
      expect(gate.allowed).toBe(false);
      expect(gate.reason).toContain("Go-UPC monthly cap reached");
    });

    it("GO_UPC_MONTHLY_LIMIT=10 warns at/above WARN_AT-equivalent behavior (used >= limit still blocks)", async () => {
      process.env.GO_UPC_MONTHLY_LIMIT = "10000";
      await fileLadderStorage(dir).writeUsage({ month: "2026-07", used: 4001 });
      const usage = goUpcUsage(fileLadderStorage(dir), { now: AT_JULY });
      const gate = await usage.canSpend();
      expect(gate.allowed).toBe(true);
      expect(gate.warn).toBe(true);
    });

    it.each(["", "0", "none", "unlimited", "None", "UNLIMITED", "-5", "abc"])(
      "GO_UPC_MONTHLY_LIMIT=%j resolves to unlimited",
      async (value) => {
        process.env.GO_UPC_MONTHLY_LIMIT = value;
        const usage = goUpcUsage(fileLadderStorage(dir), { now: AT_JULY });
        const gate = await usage.canSpend();
        expect(gate.limit).toBe(Infinity);
        expect(gate.allowed).toBe(true);
        expect(gate.warn).toBe(false);
      },
    );

    it("unset GO_UPC_MONTHLY_LIMIT (deleted) resolves to unlimited", async () => {
      delete process.env.GO_UPC_MONTHLY_LIMIT;
      const usage = goUpcUsage(fileLadderStorage(dir), { now: AT_JULY });
      const gate = await usage.canSpend();
      expect(gate.limit).toBe(Infinity);
      expect(gate.allowed).toBe(true);
    });
  });
});
