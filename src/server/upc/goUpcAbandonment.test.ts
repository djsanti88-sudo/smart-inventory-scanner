import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runLadder, type RunLadderContext, type RungOutcome } from "@/server/upc/ladder";
import { goUpcRung, type GoUpcRungDeps } from "@/server/upc/GoUpcProvider";
import { GoUpcGate } from "@/services/upc/goUpcThrottle";
import type { LadderStorage, UsageState, DecodeArchiveEntry } from "@/server/upc/storage";
import type { GoUpcUsage } from "@/server/upc/goUpcUsage";

// DC-1 (docs/superpowers/reports/2026-08-13-loop1-decode.md): the Go-UPC rung's real network egress is
// gated behind a MODULE-LEVEL, PROCESS-WIDE GoUpcGate that serializes every concurrent call at
// minGapMs spacing. The ladder abandons a rung after its per-rung budget (DECODE_LADDER_RUNG_MS) by
// racing it against a timeout and simply no longer awaiting the loser - but the abandoned rung's own
// promise chain (goUpcRung -> gate.run -> client()) keeps running server-side with NO cancellation.
// When the throttle finally releases that queued call, `client()` fires: it charges the daily cap
// slot THEN performs the real billed fetch - except by then the ladder-level `withPaidChargeArmed`
// has already disarmed the charge (its `run()` already resolved when the ladder gave up), so
// `chargeOnEgress()` is a silent no-op and the real fetch proceeds completely unmetered. This is the
// exact inverse of L12 (double-charge): a genuine paid compute charged ZERO times, so a burst of
// queued Go-UPC calls can blow past the daily spend cap with no accounting at all.
//
// This test reproduces the mechanism directly over the REAL runLadder + goUpcRung + GoUpcGate
// (the same composition pipeline.ts wires together for the live rung), with a fake clock so the
// throttle's queue delay and the ladder's abandonment timeout are both deterministic. No network layer
// is exercised at all - `client` stands in for "chargeOnEgress() + the real goUpcLookup fetch", and the
// assertion is that this stand-in must NEVER fire once the ladder has already abandoned the rung.

const CODE = "848983006257"; // valid GTIN (Falken), passes the GTIN + check-digit gate

function memStorage(): LadderStorage {
  const usage: UsageState = { month: "2026-08", used: 0 };
  const archives: DecodeArchiveEntry[] = [];
  const kv = new Map<string, string>();
  return {
    readUsage: async () => usage,
    writeUsage: async (s) => {
      Object.assign(usage, s);
    },
    incrementUsage: async (month) => {
      const used = usage.month === month ? usage.used + 1 : 1;
      Object.assign(usage, { month, used });
      return used;
    },
    appendArchive: async (entry) => {
      archives.push(entry);
    },
    appendOutcome: async () => {},
    get: async (key) => kv.get(key) ?? null,
    set: async (key, value) => {
      kv.set(key, value);
    },
    increment: async (key) => {
      const n = Number(kv.get(key) ?? "0") + 1;
      kv.set(key, String(n));
      return n;
    },
    incrementBy: async (key, delta) => {
      const n = Number(kv.get(key) ?? "0") + delta;
      kv.set(key, String(n));
      return n;
    },
    incrementIfBelow: async (key, limit) => {
      const current = Number(kv.get(key) ?? "0");
      if (!(current < limit)) return { value: current, granted: false };
      const next = current + 1;
      kv.set(key, String(next));
      return { value: next, granted: true };
    },
  };
}

function usageGate(): GoUpcUsage {
  return {
    canSpend: async () => ({ allowed: true, used: 0, limit: Infinity, warn: false }),
    record: async () => {},
  };
}

describe("DC-1: an abandoned Go-UPC ladder rung must never spend unmetered", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("drops the queued Go-UPC network call instead of firing it once the ladder has already given up", async () => {
    const gate = new GoUpcGate({ minGapMs: 5_000 });

    // Occupy the shared, process-wide queue with other in-flight calls FIRST (simulates a bulk-scan
    // burst where several other codes are already queued ahead of this one). Each occupant is spaced
    // minGapMs apart, so the 4th caller (our real target below) will not get its turn until ~15s in -
    // long after any reasonable per-rung ladder budget. Fire-and-forget: nothing awaits these directly,
    // mirroring how concurrent requests for OTHER codes queue on the same module-level gate.
    gate.run("occupant-1", async () => "x").catch(() => {});
    gate.run("occupant-2", async () => "x").catch(() => {});
    gate.run("occupant-3", async () => "x").catch(() => {});

    // Stands in for the real egress: "chargeOnEgress() + goUpcLookup()". Must NEVER fire once the
    // ladder rung has already been abandoned.
    const client = vi.fn(async (): Promise<{ kind: "miss" }> => ({ kind: "miss" }));

    const runGoUpc = async (ctx?: RunLadderContext): Promise<RungOutcome> => {
      const deps: GoUpcRungDeps = {
        apiKey: "test-key",
        client,
        gate,
        signal: ctx?.signal,
        usage: usageGate(),
        storage: memStorage(),
        prefixLookup: () => null,
      };
      const r = await goUpcRung(CODE, deps);
      return { settled: r.path === "goupc_exact", reason: r.reason };
    };

    // The ladder abandons this rung after 100ms - far sooner than the gate's 20s spacing will ever
    // release the queued call.
    const resultPromise = runLadder(CODE, [{ name: "goupc", run: runGoUpc }], { perRungTimeoutMs: 100 });

    await vi.advanceTimersByTimeAsync(100);
    const result = await resultPromise;
    expect(result.settledBy).toBeUndefined();
    expect(result.reasons[0]?.reason).toMatch(/aborted/);

    // Now let the gate's queue actually reach this call's turn (~15s in), well past the ladder's own
    // 100ms timeout.
    await vi.advanceTimersByTimeAsync(20_000);

    // THE MONEY ASSERTION: the queued call must be dropped before it can charge/fetch, never fired
    // after the ladder already gave up on it.
    expect(client).not.toHaveBeenCalled();
  });

  it("still fires the real call normally when the ladder does NOT abandon the rung (spacing preserved)", async () => {
    const gate = new GoUpcGate({ minGapMs: 0 });
    const client = vi.fn(async (): Promise<{ kind: "miss" }> => ({ kind: "miss" }));

    const runGoUpc = async (ctx?: RunLadderContext): Promise<RungOutcome> => {
      const deps: GoUpcRungDeps = {
        apiKey: "test-key",
        client,
        gate,
        signal: ctx?.signal,
        usage: usageGate(),
        storage: memStorage(),
        prefixLookup: () => null,
      };
      const r = await goUpcRung(CODE, deps);
      return { settled: r.path === "goupc_exact", reason: r.reason };
    };

    const resultPromise = runLadder(CODE, [{ name: "goupc", run: runGoUpc }], { perRungTimeoutMs: 5000 });
    await vi.advanceTimersByTimeAsync(0);
    await resultPromise;

    expect(client).toHaveBeenCalledTimes(1);
  });

  // Codex LOW finding (2026-08-13 xhigh review): the two tests above only stub an IMMEDIATE `client`
  // (it resolves in the very microtask it fires - `async () => ({ kind: "miss" })`). That can prove
  // "the call never fired" but it structurally CANNOT express the shape a real egress actually has:
  // `client` stands in for "chargeOnEgress() + the real network fetch", and chargeOnEgress() is itself
  // an async storage round-trip (chargeDailySlot/chargeDailySlotConditional) that can resolve - or
  // REJECT - strictly LATER than the ladder's own per-rung timeout. A harness that can only express
  // "fired vs never-fired" has a blind spot for exactly the race the pipeline-level money-leak bug
  // (DC-2, see pipeline.test.ts's "(e) a non-cap GLOBAL charge failure is STICKY..." test) lives in:
  // the window between a charge attempt STARTING and it actually SETTLING. This test decouples "fired"
  // from "settled" with a manually-releasable deferred promise, so a future test can drive that window
  // deterministically instead of being stuck with instant resolution.
  it("harness capability: a deferred client can fire and then settle strictly AFTER the ladder has already abandoned the rung, without corrupting the ladder's own result", async () => {
    const gate = new GoUpcGate({ minGapMs: 0 });
    let releaseClient: (() => void) | undefined;
    const clientStarted = vi.fn();
    // Fires immediately (proves the call happened) but its own promise does not SETTLE until the test
    // explicitly releases it - the deferred-settlement shape a real chargeOnEgress()+fetch call has.
    const client = vi.fn(async (): Promise<{ kind: "miss" }> => {
      clientStarted();
      await new Promise<void>((resolve) => {
        releaseClient = resolve;
      });
      return { kind: "miss" };
    });

    const runGoUpc = async (ctx?: RunLadderContext): Promise<RungOutcome> => {
      const deps: GoUpcRungDeps = {
        apiKey: "test-key",
        client,
        gate,
        signal: ctx?.signal,
        usage: usageGate(),
        storage: memStorage(),
        prefixLookup: () => null,
      };
      const r = await goUpcRung(CODE, deps);
      return { settled: r.path === "goupc_exact", reason: r.reason };
    };

    // A short per-rung budget so the LADDER gives up waiting well before `client` ever settles.
    const resultPromise = runLadder(CODE, [{ name: "goupc", run: runGoUpc }], { perRungTimeoutMs: 50 });

    // Let the gate release the call and let `client` actually START (fire) - the call genuinely happened.
    await vi.advanceTimersByTimeAsync(0);
    expect(clientStarted).toHaveBeenCalledTimes(1);

    // The ladder now gives up waiting (its 50ms budget elapses) WHILE client() is still pending - this
    // is the deferred-settlement window the immediate-client harness above could never express.
    await vi.advanceTimersByTimeAsync(50);
    const result = await resultPromise;
    expect(result.settledBy).toBeUndefined();
    expect(result.reasons[0]?.reason).toMatch(/aborted/);

    // The abandoned call's own promise is still pending server-side (exactly like a real
    // chargeOnEgress()+fetch chain would be after the ladder moves on). Releasing it now proves a LATE
    // resolve can never mutate the ladder's already-returned result (the "late-resolve guard" ladder.ts
    // documents) - the harness can express the race AND assert on its outcome.
    releaseClient?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(client).toHaveBeenCalledTimes(1);
    expect(result.settledBy).toBeUndefined();
  });
});
