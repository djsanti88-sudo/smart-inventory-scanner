import { describe, it, expect, vi } from "vitest";
import { runLadder, buildLadderRungs, type LadderRung, type RungOutcome } from "./ladder";

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
