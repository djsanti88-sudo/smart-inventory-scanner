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

  // DC-1 (2026-08-13 money-leak remediation): a caller can pass an AbortSignal so a call still waiting
  // its turn in the shared queue when its owner gives up (e.g. the decode ladder's per-rung timeout)
  // never fires `fn` - closing the "queued call fires unmetered after abandonment" leak.
  describe("DC-1: abort-aware queued calls", () => {
    it("never invokes fn when the signal is already aborted by the time this call's turn arrives", async () => {
      const clock = makeClock();
      const gate = new GoUpcGate({ minGapMs: 500, now: clock.now });
      const controller = new AbortController();

      const fn = vi.fn(async () => "should-never-run");
      const p = gate.run("code-a", fn, controller.signal);
      const expectation = expect(p).rejects.toThrow(/aborted|dropped/i);

      // Abort before this call's slot is ever released.
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);

      await expectation;
      expect(fn).not.toHaveBeenCalled();
    });

    it("still invokes fn normally when the signal never aborts", async () => {
      const clock = makeClock();
      const gate = new GoUpcGate({ minGapMs: 0, now: clock.now });
      const controller = new AbortController();

      const fn = vi.fn(async () => "ran");
      const p = gate.run("code-b", fn, controller.signal);
      await vi.advanceTimersByTimeAsync(0);

      await expect(p).resolves.toBe("ran");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("preserves minGapMs spacing for a later caller even when an earlier queued call is dropped by abort", async () => {
      const clock = makeClock();
      const gate = new GoUpcGate({ minGapMs: 500, now: clock.now });
      const controller = new AbortController();
      controller.abort(); // already aborted before either call is queued

      const dropped = vi.fn(async () => "dropped");
      const second = vi.fn(async () => "second");
      const startTimes: number[] = [];

      const p1 = gate.run("code-c", dropped, controller.signal).catch(() => {});
      const p2 = gate.run("code-d", async () => {
        startTimes.push(clock.now());
        return second();
      });

      async function tick(ms: number) {
        clock.advance(ms);
        await vi.advanceTimersByTimeAsync(ms);
      }

      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await tick(500);

      await Promise.all([p1, p2]);

      expect(dropped).not.toHaveBeenCalled();
      // The second call still had to wait its own spacing slot behind the (dropped) first slot -
      // dropping fn does not collapse or skip the queue's timing for callers behind it.
      expect(startTimes[0]).toBeGreaterThanOrEqual(500);
    });
  });

  // DC-2 (2026-08-13, clean-room review follow-up): the dedup early-return used to hand every
  // concurrent caller the literal SAME promise, which closed over only the FIRST caller's abort
  // signal. If caller A aborted while queued, the shared promise rejected for EVERYONE, including
  // caller B whose own signal never aborted - forcing B to fall through to the more expensive
  // fetchv2/GPT rungs even though the cheap Go-UPC call it wanted was still perfectly viable.
  describe("DC-2: one caller's abort must never poison a different caller's shared result", () => {
    it("still resolves a second caller whose signal never aborts, even though the first caller aborted while queued", async () => {
      const clock = makeClock();
      const gate = new GoUpcGate({ minGapMs: 0, now: clock.now });
      const controllerA = new AbortController();
      const controllerB = new AbortController();

      const fn = vi.fn(async () => "shared-result");
      const pA = gate.run("same-key", fn, controllerA.signal);
      const pB = gate.run("same-key", fn, controllerB.signal);
      // Attach A's rejection expectation synchronously (before triggering the abort) so the rejection
      // is never momentarily unhandled when the microtask queue flushes - same pattern the existing
      // "rejects both waiters" test above uses.
      const eA = expect(pA).rejects.toThrow(/aborted|abandoned/i);

      // A gives up before its queued turn arrives; B never aborts.
      controllerA.abort();

      await vi.advanceTimersByTimeAsync(0);

      await expect(pB).resolves.toBe("shared-result");
      expect(fn).toHaveBeenCalledTimes(1);
      // A's own abort still rejects A specifically - it just must not take B down with it.
      await eA;
    });

    it("drops fn entirely only when EVERY registered caller for the key has aborted", async () => {
      const clock = makeClock();
      const gate = new GoUpcGate({ minGapMs: 0, now: clock.now });
      const controllerA = new AbortController();
      const controllerB = new AbortController();

      const fn = vi.fn(async () => "should-never-run");
      const pA = gate.run("both-abort", fn, controllerA.signal);
      const pB = gate.run("both-abort", fn, controllerB.signal);
      const eA = expect(pA).rejects.toThrow(/aborted|dropped|abandoned/i);
      const eB = expect(pB).rejects.toThrow(/aborted|dropped|abandoned/i);

      controllerA.abort();
      controllerB.abort();

      await vi.advanceTimersByTimeAsync(0);

      await eA;
      await eB;
      expect(fn).not.toHaveBeenCalled();
    });

    it("a caller with no signal at all keeps the shared call alive even if every signaled caller aborts", async () => {
      const clock = makeClock();
      const gate = new GoUpcGate({ minGapMs: 0, now: clock.now });
      const controllerA = new AbortController();

      const fn = vi.fn(async () => "kept-alive");
      const pA = gate.run("mixed", fn, controllerA.signal).catch(() => {}); // A's own abort is expected; not under test here
      const pB = gate.run("mixed", fn); // no signal - never voluntarily gives up
      void pA;

      controllerA.abort();

      await vi.advanceTimersByTimeAsync(0);

      await expect(pB).resolves.toBe("kept-alive");
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });
});
