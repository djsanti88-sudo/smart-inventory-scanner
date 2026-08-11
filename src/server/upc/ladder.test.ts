import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runLadder, buildLadderRungs, buildFreeLadderRungs, buildPaidLadderRungs, type LadderRung, type RungOutcome } from "./ladder";

// A tiny rung factory: names + a controllable outcome, with a call spy.
function rung(name: string, outcome: RungOutcome): LadderRung & { spy: ReturnType<typeof vi.fn> } {
  const spy = vi.fn(async () => outcome);
  return { name, run: spy, spy };
}

const settled = (reason: string, payload: unknown = { hit: true }): RungOutcome => ({ settled: true, payload, reason });
const miss = (reason: string): RungOutcome => ({ settled: false, reason });

describe("runLadder", () => {
  it("runs rungs in order and STOPS at the first settled outcome (later spies uncalled)", async () => {
    const a = rung("goupc", miss("goupc miss"));
    const b = rung("fetchv2", settled("fetchv2 verified"));
    const c = rung("gpt", miss("gpt not reached"));

    const res = await runLadder("111", [a, b, c]);

    expect(a.spy).toHaveBeenCalledTimes(1);
    expect(b.spy).toHaveBeenCalledTimes(1);
    expect(c.spy, "a settled rung must stop the ladder - later rungs never run").not.toHaveBeenCalled();
    expect(res.settledBy).toBe("fetchv2");
    expect(res.outcome?.payload).toEqual({ hit: true });
    // reasons accumulate for every rung that RAN (including the settling one).
    expect(res.reasons).toEqual([
      { rung: "goupc", reason: "goupc miss" },
      { rung: "fetchv2", reason: "fetchv2 verified" },
    ]);
  });

  it("goupc EXACT (first rung settled) stops the ladder - fetchv2 + gpt never run", async () => {
    const goupc = rung("goupc", settled("goupc exact", { path: "goupc_exact" }));
    const fetchv2 = rung("fetchv2", miss("fetchv2 unreached"));
    const gpt = rung("gpt", miss("gpt unreached"));

    const res = await runLadder("111", [goupc, fetchv2, gpt]);

    expect(goupc.spy).toHaveBeenCalledTimes(1);
    expect(fetchv2.spy).not.toHaveBeenCalled();
    expect(gpt.spy).not.toHaveBeenCalled();
    expect(res.settledBy).toBe("goupc");
    expect((res.outcome?.payload as { path: string }).path).toBe("goupc_exact");
  });

  it("goupc INFERRED (a settled suggestion) also stops the paid rungs below it", async () => {
    const goupc = rung("goupc", settled("goupc inferred -> suggestion", { path: "goupc_inferred" }));
    const fetchv2 = rung("fetchv2", miss("unreached"));
    const gpt = rung("gpt", miss("unreached"));

    const res = await runLadder("111", [goupc, fetchv2, gpt]);

    expect(res.settledBy).toBe("goupc");
    expect(fetchv2.spy).not.toHaveBeenCalled();
    expect(gpt.spy).not.toHaveBeenCalled();
  });

  it("goupc UNAVAILABLE falls through to fetchv2 with the reason threaded through", async () => {
    const goupc = rung("goupc", miss("Go-UPC monthly cap reached"));
    const fetchv2 = rung("fetchv2", settled("fetchv2 verified"));
    const gpt = rung("gpt", miss("unreached"));

    const res = await runLadder("111", [goupc, fetchv2, gpt]);

    expect(goupc.spy).toHaveBeenCalledTimes(1);
    expect(fetchv2.spy).toHaveBeenCalledTimes(1);
    expect(gpt.spy).not.toHaveBeenCalled();
    expect(res.settledBy).toBe("fetchv2");
    // the goupc unavailable reason is preserved in the accumulated reasons.
    expect(res.reasons[0]).toEqual({ rung: "goupc", reason: "Go-UPC monthly cap reached" });
  });

  it("fetchv2 verified/suggested stops GPT", async () => {
    const goupc = rung("goupc", miss("goupc miss"));
    const fetchv2 = rung("fetchv2", settled("fetchv2 suggested"));
    const gpt = rung("gpt", miss("unreached"));

    const res = await runLadder("111", [goupc, fetchv2, gpt]);

    expect(gpt.spy).not.toHaveBeenCalled();
    expect(res.settledBy).toBe("fetchv2");
  });

  it("ALL-MISS -> no settledBy; reasons list EVERY rung's reason (for the needs_review response)", async () => {
    const goupc = rung("goupc", miss("Go-UPC miss (negative-cached)"));
    const fetchv2 = rung("fetchv2", miss("fetchv2 unknown - all doors empty"));
    const gpt = rung("gpt", miss("gpt tier none"));

    const res = await runLadder("111", [goupc, fetchv2, gpt]);

    expect(res.settledBy).toBeUndefined();
    expect(res.outcome).toBeUndefined();
    expect(res.reasons).toEqual([
      { rung: "goupc", reason: "Go-UPC miss (negative-cached)" },
      { rung: "fetchv2", reason: "fetchv2 unknown - all doors empty" },
      { rung: "gpt", reason: "gpt tier none" },
    ]);
  });
});

describe("buildLadderRungs (caller-side gate)", () => {
  // Minimal stubbed rung runners; buildLadderRungs only decides WHICH rungs exist + their order.
  const deps = {
    runUpcItemDb: async (): Promise<RungOutcome> => miss("upcitemdb"),
    runOpenFoodFacts: async (): Promise<RungOutcome> => miss("openfoodfacts"),
    runGoUpc: async (): Promise<RungOutcome> => miss("goupc"),
    runFetchV2: async (): Promise<RungOutcome> => miss("fetchv2"),
    runGpt: async (): Promise<RungOutcome> => miss("gpt"),
  };

  it("a GTIN-shaped code gets the full upcitemdb -> openfoodfacts -> goupc -> fetchv2 -> gpt ladder, in that order", () => {
    const rungs = buildLadderRungs("848983006257", deps); // valid UPC-A
    expect(rungs.map((r) => r.name)).toEqual(["upcitemdb", "openfoodfacts", "goupc", "fetchv2", "gpt"]);
  });

  it("a VENDOR-shaped (non-GTIN) code SKIPS all three GTIN-gated rungs: only fetchv2 -> gpt", () => {
    const rungs = buildLadderRungs("X004DY7YUT", deps); // ASIN/FNSKU-style, not a GTIN
    expect(rungs.map((r) => r.name)).toEqual(["fetchv2", "gpt"]);
  });

  it("a GTIN-shaped code with a BAD check digit still skips all three GTIN-gated rungs (the gate needs a real GTIN)", () => {
    // 036000291453 = valid-length UPC-A but last digit is off by one (bad GS1 check digit).
    const rungs = buildLadderRungs("036000291453", deps);
    expect(rungs.map((r) => r.name)).toEqual(["fetchv2", "gpt"]);
  });
});

describe("buildFreeLadderRungs / buildPaidLadderRungs (two-phase split, cap-charge bug fix)", () => {
  // Minimal stubbed rung runners; the builders only decide WHICH rungs exist + their order.
  const deps = {
    runUpcItemDb: async (): Promise<RungOutcome> => miss("upcitemdb"),
    runOpenFoodFacts: async (): Promise<RungOutcome> => miss("openfoodfacts"),
    runGoUpc: async (): Promise<RungOutcome> => miss("goupc"),
    runFetchV2: async (): Promise<RungOutcome> => miss("fetchv2"),
    runGpt: async (): Promise<RungOutcome> => miss("gpt"),
  };

  it("buildFreeLadderRungs: a GTIN-shaped code gets upcitemdb -> openfoodfacts only (no paid rungs)", () => {
    const rungs = buildFreeLadderRungs("848983006257", deps); // valid UPC-A
    expect(rungs.map((r) => r.name)).toEqual(["upcitemdb", "openfoodfacts"]);
  });

  it("buildFreeLadderRungs: a non-GTIN code gets NO free rungs at all", () => {
    const rungs = buildFreeLadderRungs("X004DY7YUT", deps);
    expect(rungs.map((r) => r.name)).toEqual([]);
  });

  it("buildFreeLadderRungs: a GTIN-shaped code with a bad check digit gets NO free rungs", () => {
    const rungs = buildFreeLadderRungs("036000291453", deps);
    expect(rungs.map((r) => r.name)).toEqual([]);
  });

  it("buildPaidLadderRungs: a GTIN-shaped code gets goupc -> fetchv2 -> gpt", () => {
    const rungs = buildPaidLadderRungs("848983006257", deps);
    expect(rungs.map((r) => r.name)).toEqual(["goupc", "fetchv2", "gpt"]);
  });

  it("buildPaidLadderRungs: a non-GTIN code skips goupc: fetchv2 -> gpt only", () => {
    const rungs = buildPaidLadderRungs("X004DY7YUT", deps);
    expect(rungs.map((r) => r.name)).toEqual(["fetchv2", "gpt"]);
  });

  it("concatenating buildFreeLadderRungs + buildPaidLadderRungs reproduces buildLadderRungs's combined order exactly", () => {
    for (const code of ["848983006257", "X004DY7YUT", "036000291453"]) {
      const combined = [...buildFreeLadderRungs(code, deps), ...buildPaidLadderRungs(code, deps)].map((r) => r.name);
      const legacy = buildLadderRungs(code, deps).map((r) => r.name);
      expect(combined).toEqual(legacy);
    }
  });
});

describe("L2 total ladder deadline (owner-reported 36-70s blocking decodes, AM-1)", () => {
  it("skips rungs whose start time is past the deadline, with an honest reason", async () => {
    let t = 0;
    const now = () => t;
    const slowRung: LadderRung = {
      name: "slow",
      run: async () => {
        t += 50_000;
        return { settled: false, reason: "miss after 50s" };
      },
    };
    const second = rung("second", miss("second miss"));
    const third = rung("third", miss("third miss"));

    const r = await runLadder("049000006346", [slowRung, second, third], { deadlineAt: 40_000, now });

    expect(r.settledBy).toBeUndefined();
    expect(r.reasons.map((x) => x.rung)).toEqual(["slow", "second", "third"]);
    expect(r.reasons[1].reason).toContain("skipped: ladder deadline reached (DECODE_LADDER_TOTAL_MS)");
    expect(r.reasons[2].reason).toContain("skipped: ladder deadline reached (DECODE_LADDER_TOTAL_MS)");
    // D7: an in-flight rung now races an abort timer, but "slow" settles synchronously (real time)
    // well inside its budget (deadlineAt - now = 40_000ms of real wall-clock), so it still runs to
    // completion here - only a rung that genuinely outlives its budget gets aborted (see
    // ladderTimeout.test.ts).
    expect(r.reasons[0]).toEqual({ rung: "slow", reason: "miss after 50s" });
  });

  it("a rung that settles BEFORE the deadline still stops the ladder normally, even with opts passed", async () => {
    const t = 0;
    const now = () => t;
    const a = rung("a", miss("a miss"));
    const b = rung("b", settled("b hit"));
    const c = rung("c", miss("c unreached"));

    const r = await runLadder("049000006346", [a, b, c], { deadlineAt: 1_000_000, now });

    expect(r.settledBy).toBe("b");
    expect(c.spy).not.toHaveBeenCalled();
  });

  it("no deadline passed = identical behavior to today (fully backward compatible)", async () => {
    const a = rung("a", miss("a miss"));
    const b = rung("b", settled("b hit"));

    const r = await runLadder("049000006346", [a, b]);

    expect(r.settledBy).toBe("b");
  });

  it("no now() passed = defaults to Date.now (never throws, opts.deadlineAt alone works)", async () => {
    const a = rung("a", settled("a hit"));
    const r = await runLadder("049000006346", [a], { deadlineAt: Date.now() + 60_000 });
    expect(r.settledBy).toBe("a");
  });
});

describe("wave-3: per-rung budgetMs override (2026-07-20 owner-ratified)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a rung's own budgetMs overrides opts.perRungTimeoutMs when it is LARGER", async () => {
    const t = 0;
    const now = () => t;
    const hang: LadderRung = {
      name: "fetchv2",
      budgetMs: 27_000,
      run: ({ signal }) =>
        new Promise<RungOutcome>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    };
    const p = runLadder("049000006346", [hang], { perRungTimeoutMs: 8_000, now });
    // The rung's own 27s budget must still be running at 20s (would already be aborted under the old
    // uniform 8s perRungTimeoutMs).
    await vi.advanceTimersByTimeAsync(20_000);
    // The promise is still pending - resolve it manually to end the test cleanly.
    let resolved = false;
    p.then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);
    // Let it run out to its real 27s budget so the ladder settles and the test can finish.
    await vi.advanceTimersByTimeAsync(8_000);
    const r = await p;
    expect(r.reasons[0].reason).toMatch(/aborted/i);
  });

  it("a rung's budgetMs is used INSTEAD of opts.perRungTimeoutMs when no deadlineAt is set (shorter budgetMs still aborts sooner)", async () => {
    const t = 0;
    const now = () => t;
    const hang: LadderRung = {
      name: "goupc",
      budgetMs: 3_000,
      run: ({ signal }) =>
        new Promise<RungOutcome>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    };
    const p = runLadder("049000006346", [hang], { perRungTimeoutMs: 8_000, now });
    await vi.advanceTimersByTimeAsync(3_100);
    const r = await p;
    expect(r.reasons[0].reason).toMatch(/aborted/i);
  });

  it("deadlineAt still caps budgetMs as an outer ceiling (a rung's budgetMs cannot outlive the total deadline)", async () => {
    const t = 0;
    const now = () => t;
    const hang: LadderRung = {
      name: "gpt",
      budgetMs: 40_000,
      run: ({ signal }) =>
        new Promise<RungOutcome>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    };
    // Only 5s remains to the total deadline - far less than the rung's own 40s budget.
    const p = runLadder("049000006346", [hang], { perRungTimeoutMs: 8_000, deadlineAt: 5_000, now });
    await vi.advanceTimersByTimeAsync(5_100);
    const r = await p;
    expect(r.reasons[0].reason).toMatch(/aborted/i);
  });

  it("a rung with NO budgetMs behaves byte-identically to before (falls back to opts.perRungTimeoutMs)", async () => {
    const t = 0;
    const now = () => t;
    const hang: LadderRung = {
      name: "upcitemdb",
      run: ({ signal }) =>
        new Promise<RungOutcome>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    };
    const p = runLadder("049000006346", [hang], { perRungTimeoutMs: 8_000, now });
    await vi.advanceTimersByTimeAsync(8_100);
    const r = await p;
    expect(r.reasons[0].reason).toMatch(/aborted/i);
  });
});
