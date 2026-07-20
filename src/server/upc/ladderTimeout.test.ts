import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runLadder, type LadderRung, type RungOutcome } from "./ladder";

const settled = (reason: string): RungOutcome => ({ settled: true, payload: { hit: true }, reason });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("D7: per-rung hard timeout aborts an in-flight rung", () => {
  it("aborts a rung that never resolves, records an 'aborted' reason, and moves on", async () => {
    // A rung that never settles on its own; it must be aborted by the per-rung timeout.
    const hang: LadderRung = {
      name: "hang",
      run: ({ signal }) =>
        new Promise<RungOutcome>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    };
    const nextRung: LadderRung = { name: "next", run: async () => settled("next verified") };

    const p = runLadder("049000006346", [hang, nextRung], { perRungTimeoutMs: 5000, now: () => Date.now() });
    // Advance past the per-rung timeout so the AbortController fires.
    await vi.advanceTimersByTimeAsync(6000);
    const r = await p;

    expect(r.reasons[0].rung).toBe("hang");
    expect(r.reasons[0].reason).toMatch(/aborted/i);
    expect(r.settledBy).toBe("next");
  });

  it("bounds the ladder at the total wall-clock ceiling: an in-flight rung past deadlineAt is aborted (the ladder never waits on it)", async () => {
    const abortSpy = vi.fn();
    const hang: LadderRung = {
      name: "hang",
      run: ({ signal }) =>
        new Promise<RungOutcome>((_resolve, reject) => {
          signal.addEventListener("abort", () => { abortSpy(); reject(new Error("aborted")); });
        }),
    };
    const start = Date.now();
    const p = runLadder("049000006346", [hang], { deadlineAt: start + 4000, perRungTimeoutMs: 60000, now: () => Date.now() });
    await vi.advanceTimersByTimeAsync(5000);
    const r = await p;
    expect(abortSpy, "the in-flight rung was aborted at the wall-clock ceiling").toHaveBeenCalled();
    expect(r.settledBy).toBeUndefined();
    expect(r.reasons[0].reason).toMatch(/aborted/i);
  });

  it("a rung that settles before its timeout is unaffected (backward compatible)", async () => {
    const fast: LadderRung = { name: "fast", run: async () => settled("fast hit") };
    const p = runLadder("049000006346", [fast], { perRungTimeoutMs: 5000 });
    await vi.runAllTimersAsync();
    const r = await p;
    expect(r.settledBy).toBe("fast");
  });

  it("LATE-RESOLVE GUARD: a rung that answers AFTER the ladder moved on cannot mutate the returned result or reasons", async () => {
    let lateResolve: ((o: RungOutcome) => void) | undefined;
    const hang: LadderRung = {
      name: "hang",
      run: () => new Promise<RungOutcome>((resolve) => { lateResolve = resolve; }),
    };
    const nextRung: LadderRung = { name: "next", run: async () => settled("next verified") };
    const p = runLadder("049000006346", [hang, nextRung], { perRungTimeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1500);
    const r = await p;
    const reasonsSnapshot = JSON.stringify(r.reasons);
    const settledBySnapshot = r.settledBy;
    // The abandoned rung answers late - the returned result must not change.
    lateResolve?.({ settled: true, payload: { hijack: true }, reason: "late hijack" });
    await vi.runAllTimersAsync();
    expect(JSON.stringify(r.reasons)).toBe(reasonsSnapshot);
    expect(r.settledBy).toBe(settledBySnapshot);
  });
});
