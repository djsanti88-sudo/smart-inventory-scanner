import { describe, it, expect } from "vitest";
import { raceFinders, type Finder, type FinderHit } from "@/services/ai/fallbackRunner";
import type { AiLookupResult, EvidenceResult } from "@/types";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hit = (name: string): FinderHit => ({
  result: { productName: name } as AiLookupResult,
  evidence: { verified: true, strength: "fetched_source", matchedCode: "x", matchedSources: [], reason: "" } as EvidenceResult,
  providerName: name,
});

describe("raceFinders (deep fallback: parallel, first-usable-wins, abort losers, hard cap)", () => {
  it("runs finders CONCURRENTLY, not one after another", async () => {
    let active = 0;
    let maxActive = 0;
    const make = (name: string): Finder => ({
      name,
      run: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await delay(15);
        active--;
        return null; // both miss so we can observe overlap
      },
    });
    const out = await raceFinders([make("a"), make("b"), make("c")], { hardCapMs: 1000 });
    expect(out.hit).toBeNull();
    expect(maxActive).toBe(3); // all three were in flight at once (sequential would be 1)
  });

  it("returns the FIRST usable hit and ABORTS the losers", async () => {
    let loserAborted = false;
    const winner: Finder = { name: "fast", run: async () => hit("Winner Product") };
    const loser: Finder = {
      name: "slow",
      run: (signal) =>
        new Promise<FinderHit | null>((resolve) => {
          signal.addEventListener("abort", () => {
            loserAborted = true; // the race aborted us once the winner resolved
            resolve(null);
          });
        }),
    };
    const out = await raceFinders([winner, loser], { hardCapMs: 1000 });
    expect(out.hit?.result.productName).toBe("Winner Product");
    await delay(0);
    expect(loserAborted).toBe(true);
  });

  it("ignores null-returning finders and resolves the one real hit", async () => {
    const a: Finder = { name: "a", run: async () => { await delay(5); return null; } };
    const b: Finder = { name: "b", run: async () => { await delay(20); return hit("Real"); } };
    const out = await raceFinders([a, b], { hardCapMs: 1000 });
    expect(out.hit?.result.productName).toBe("Real");
  });

  it("resolves null when every finder misses", async () => {
    const out = await raceFinders(
      [
        { name: "a", run: async () => null },
        { name: "b", run: async () => null },
      ],
      { hardCapMs: 1000 },
    );
    expect(out.hit).toBeNull();
    expect(out.timedOut).toBe(false);
  });

  it("hits the hard cap and stops (never runs unbounded)", async () => {
    const hang: Finder = { name: "hang", run: () => new Promise(() => {}) }; // never resolves on its own
    const out = await raceFinders([hang], { hardCapMs: 30 });
    expect(out.hit).toBeNull();
    expect(out.timedOut).toBe(true);
  });

  it("a finder that throws does not reject the race", async () => {
    const boom: Finder = { name: "boom", run: async () => { throw new Error("kaboom"); } };
    const good: Finder = { name: "good", run: async () => hit("Survivor") };
    const out = await raceFinders([boom, good], { hardCapMs: 1000 });
    expect(out.hit?.result.productName).toBe("Survivor");
  });
});
