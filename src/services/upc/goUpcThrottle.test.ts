import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GoUpcGate } from "./goUpcThrottle";

// A controllable clock so spacing assertions do not depend on wall time. The gate reads `now()`
// for its spacing math and schedules its waits with real timers, which vi.useFakeTimers() drives.
function makeClock() {
  let current = 0;
  return {
    now: () => current,
    set: (ms: number) => {
      current = ms;
    },
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe("GoUpcGate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("serializes calls at least minGapMs apart (2 req/s => 500ms)", async () => {
    const clock = makeClock();
    const gate = new GoUpcGate({ minGapMs: 500, now: clock.now });

    const startTimes: number[] = [];
    // Distinct keys so dedup never merges them; the only thing under test is spacing.
    const fn = (label: string) => async () => {
      startTimes.push(clock.now());
      return label;
    };

    const p1 = gate.run("a", fn("a"));
    const p2 = gate.run("b", fn("b"));
    const p3 = gate.run("c", fn("c"));

    // Drive fake timers + the controllable clock together. Each 500ms tick advances real (fake)
    // timers and the gate's clock so the queued tail releases the next call.
    async function tick(ms: number) {
      clock.advance(ms);
      await vi.advanceTimersByTimeAsync(ms);
    }

    // fn1 runs immediately at t=0.
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await tick(500);
    await tick(500);

    await Promise.all([p1, p2, p3]);

    expect(startTimes).toHaveLength(3);
    expect(startTimes[1] - startTimes[0]).toBeGreaterThanOrEqual(500);
    expect(startTimes[2] - startTimes[1]).toBeGreaterThanOrEqual(500);
  });

  it("dedupes concurrent run() with the same key into ONE fn invocation, both resolving to its value", async () => {
    const clock = makeClock();
    const gate = new GoUpcGate({ minGapMs: 0, now: clock.now });

    const spy = vi.fn(async () => "shared-value");

    const p1 = gate.run("same", spy);
    const p2 = gate.run("same", spy);

    await vi.advanceTimersByTimeAsync(0);
    const [v1, v2] = await Promise.all([p1, p2]);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(v1).toBe("shared-value");
    expect(v2).toBe("shared-value");
  });

  it("invokes fn again for a new call after the in-flight slot settles", async () => {
    const clock = makeClock();
    const gate = new GoUpcGate({ minGapMs: 0, now: clock.now });

    const spy = vi.fn(async () => "v");

    await gate.run("same", spy);
    await vi.advanceTimersByTimeAsync(0);
    await gate.run("same", spy);
    await vi.advanceTimersByTimeAsync(0);

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("rejects both waiters and clears the in-flight slot when fn rejects", async () => {
    const clock = makeClock();
    const gate = new GoUpcGate({ minGapMs: 0, now: clock.now });

    const boom = new Error("boom");
    const failing = vi.fn(async () => {
      throw boom;
    });

    const p1 = gate.run("same", failing);
    const p2 = gate.run("same", failing);
    // Attach rejection expectations synchronously (before advancing timers) so the shared rejection
    // is never momentarily unhandled when the microtask queue flushes.
    const e1 = expect(p1).rejects.toBe(boom);
    const e2 = expect(p2).rejects.toBe(boom);

    await vi.advanceTimersByTimeAsync(0);

    await e1;
    await e2;
    expect(failing).toHaveBeenCalledTimes(1);

    // Slot cleared: a subsequent call re-invokes rather than returning the rejected in-flight promise.
    const ok = vi.fn(async () => "recovered");
    const p3 = gate.run("same", ok);
    await vi.advanceTimersByTimeAsync(0);
    await expect(p3).resolves.toBe("recovered");
    expect(ok).toHaveBeenCalledTimes(1);
  });
});
