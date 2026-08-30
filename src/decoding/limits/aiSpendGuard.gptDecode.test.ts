import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  __resetForTest,
  checkGptDecodeBudget,
  getGptDecodeStatus,
  recordGptDecodeCall,
  recordGptDecodeSpend,
} from "./aiSpendGuard";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpFile = () => join(mkdtempSync(join(tmpdir(), "gptguard-")), "usage.json");

/** In-memory StorageLike stub matching the ladder storage's minimal get/set/increment surface. */
function memStorage() {
  const m = new Map<string, string>();
  return {
    async get(k: string) { return m.get(k) ?? null; },
    async set(k: string, v: string) { m.set(k, v); },
    async increment(k: string) { const n = Number(m.get(k) ?? "0") + 1; m.set(k, String(n)); return n; },
    async incrementBy(k: string, delta: number) { const n = Number(m.get(k) ?? "0") + delta; m.set(k, String(n)); return n; },
  };
}

/**
 * Fix 2 (P6 ultra-review, $-guard race): a storage stub whose `incrementBy` is GENUINELY
 * serialized (mirrors the Turso adapter's atomic in-SQL `value = CAST(value AS INTEGER) + ?`),
 * unlike a naive get-then-set which would lose concurrent updates to a race. Used to prove
 * recordGptDecodeSpend correctly sums concurrent deltas instead of last-write-wins.
 */
function serializedIncrementByStorage() {
  const m = new Map<string, string>();
  let chain: Promise<unknown> = Promise.resolve();
  return {
    async get(k: string) { return m.get(k) ?? null; },
    async set(k: string, v: string) { m.set(k, v); },
    async increment(k: string): Promise<number> {
      const result = chain.then(() => {
        const n = Number(m.get(k) ?? "0") + 1;
        m.set(k, String(n));
        return n;
      });
      chain = result;
      return result;
    },
    async incrementBy(k: string, delta: number): Promise<number> {
      const result = chain.then(() => {
        const n = Number(m.get(k) ?? "0") + delta;
        m.set(k, String(n));
        return n;
      });
      chain = result;
      return result;
    },
  };
}

describe("GPT decode dollar guard (file/memory fallback, no storage)", () => {
  beforeEach(() => {
    __resetForTest();
  });

  test("allows while spent + worst case fits, then blocks", async () => {
    const file = tmpFile();
    expect((await checkGptDecodeBudget({ capUsd: 1.0, file, dateKey: "allow-then-block" })).allowed).toBe(true);
    await recordGptDecodeSpend(0.5, { file, dateKey: "allow-then-block" });
    expect((await checkGptDecodeBudget({ capUsd: 1.0, file, dateKey: "allow-then-block" })).allowed).toBe(true); // 0.5 + 0.39 <= 1.0
    await recordGptDecodeSpend(0.2, { file, dateKey: "allow-then-block" });
    const r = await checkGptDecodeBudget({ capUsd: 1.0, file, dateKey: "allow-then-block" });
    expect(r.allowed).toBe(false); // 0.7 + 0.39 > 1.0
    expect(r.spentUsd).toBeCloseTo(0.7, 5);
  });

  test("a new day resets", async () => {
    const file = tmpFile();
    await recordGptDecodeSpend(5, { file, dateKey: "reset-d1" });
    expect((await checkGptDecodeBudget({ capUsd: 1.0, file, dateKey: "reset-d2" })).allowed).toBe(true);
  });

  test("survives process restart via the file (in-memory cleared, file is source of truth)", async () => {
    const file = tmpFile();
    await recordGptDecodeSpend(0.9, { file, dateKey: "restart-d1" });
    __resetForTest(); // simulate a cold start: wipe in-memory state, only the file remains
    const r = await checkGptDecodeBudget({ capUsd: 1.0, file, dateKey: "restart-d1" });
    expect(r.allowed).toBe(false);
  });

  test("exact boundary: spend + worst case exactly equal to cap is still allowed (<=, not <)", async () => {
    const file = tmpFile();
    await recordGptDecodeSpend(0.61, { file, dateKey: "boundary-d1" });
    const r = await checkGptDecodeBudget({ capUsd: 1.0, file, dateKey: "boundary-d1", worstCaseUsd: 0.39 });
    expect(r.spentUsd).toBeCloseTo(0.61, 5);
    expect(r.allowed).toBe(true); // 0.61 + 0.39 === 1.0, <= holds
  });

  test("accumulates sub-cent spend at 4-decimal (tenth-of-a-cent) precision instead of rounding to zero", async () => {
    const file = tmpFile();
    // A searchless GPT call can cost as little as ~$0.003; 2-decimal rounding would zero every one.
    await recordGptDecodeSpend(0.003, { file, dateKey: "subcent-d1" });
    await recordGptDecodeSpend(0.003, { file, dateKey: "subcent-d1" });
    await recordGptDecodeSpend(0.003, { file, dateKey: "subcent-d1" });
    const r = await checkGptDecodeBudget({ capUsd: 1.0, file, dateKey: "subcent-d1", worstCaseUsd: 0 });
    expect(r.spentUsd).toBeCloseTo(0.009, 6);
  });
});

describe("GPT decode call counter (file/memory fallback, no storage)", () => {
  beforeEach(() => {
    __resetForTest();
  });

  test("recordGptDecodeCall increments the day's call count", async () => {
    const file = tmpFile();
    expect((await getGptDecodeStatus({ file, dateKey: "calls-d1" })).calls).toBe(0);
    await recordGptDecodeCall({ file, dateKey: "calls-d1" });
    expect((await getGptDecodeStatus({ file, dateKey: "calls-d1" })).calls).toBe(1);
    await recordGptDecodeCall({ file, dateKey: "calls-d1" });
    await recordGptDecodeCall({ file, dateKey: "calls-d1" });
    expect((await getGptDecodeStatus({ file, dateKey: "calls-d1" })).calls).toBe(3);
  });

  test("call count coexists with spend in the same file without clobbering either key", async () => {
    const file = tmpFile(); // deliberately the SAME physical file both guards already share
    const dateKey = "calls-coexist-d1";
    await recordGptDecodeSpend(0.42, { file, dateKey });
    await recordGptDecodeCall({ file, dateKey });
    await recordGptDecodeCall({ file, dateKey });
    __resetForTest(); // simulate a cold start: only the file remains
    const status = await getGptDecodeStatus({ file, dateKey, capUsd: 1.0, worstCaseUsd: 0 });
    expect(status.spentUsd).toBeCloseTo(0.42, 5);
    expect(status.calls).toBe(2);
  });

  test("a new day resets the call count", async () => {
    const file = tmpFile();
    await recordGptDecodeCall({ file, dateKey: "calls-reset-d1" });
    await recordGptDecodeCall({ file, dateKey: "calls-reset-d1" });
    expect((await getGptDecodeStatus({ file, dateKey: "calls-reset-d2" })).calls).toBe(0);
  });

  test("getGptDecodeStatus reports allowed alongside spend/cap/calls", async () => {
    const file = tmpFile();
    const before = await getGptDecodeStatus({ file, dateKey: "calls-allowed-d1", capUsd: 1.0, worstCaseUsd: 0.39 });
    expect(before.allowed).toBe(true);
    await recordGptDecodeSpend(0.7, { file, dateKey: "calls-allowed-d1" });
    const after = await getGptDecodeStatus({ file, dateKey: "calls-allowed-d1", capUsd: 1.0, worstCaseUsd: 0.39 });
    expect(after.allowed).toBe(false); // 0.7 + 0.39 > 1.0
  });
});

// B1 (2026-07-20): the GPT decode $-guard migrated onto the durable DecodeStorage KV seam (the same
// injected get/set/increment shape chargeDailySlot uses). Dollar amounts are stored as integer
// tenth-of-a-cent units so sub-cent spend never rounds to zero and the persisted value stays exact.
describe("GPT decode dollar guard (durable, storage-backed)", () => {
  beforeEach(() => {
    __resetForTest();
  });

  test("allows while spent + worst case fits, then blocks", async () => {
    const storage = memStorage();
    expect((await checkGptDecodeBudget({ capUsd: 1.0, dateKey: "d1", storage })).allowed).toBe(true);
    await recordGptDecodeSpend(0.5, { dateKey: "d1", storage });
    expect((await checkGptDecodeBudget({ capUsd: 1.0, dateKey: "d1", storage })).allowed).toBe(true);
    await recordGptDecodeSpend(0.2, { dateKey: "d1", storage });
    const r = await checkGptDecodeBudget({ capUsd: 1.0, dateKey: "d1", storage });
    expect(r.allowed).toBe(false);
    expect(r.spentUsd).toBeCloseTo(0.7, 5);
  });

  // TDD: two independent "instances" (e.g. two warm serverless lambdas, no shared process memory)
  // must see the SAME accumulated spend when they share one storage handle - the entire point of B1.
  test("two independent instances sharing one storage handle see the SAME accumulated spend", async () => {
    const sharedStorage = memStorage();
    const dateKey = "shared-instances-d1";
    // "Instance A" records spend.
    await recordGptDecodeSpend(0.3, { dateKey, storage: sharedStorage });
    // "Instance B" (a fresh call, no shared in-memory state beyond the storage handle) sees it.
    const seenByB = await checkGptDecodeBudget({ capUsd: 1.0, dateKey, storage: sharedStorage, worstCaseUsd: 0 });
    expect(seenByB.spentUsd).toBeCloseTo(0.3, 5);
    // Instance B also records spend; Instance A's next read must see the combined total.
    await recordGptDecodeSpend(0.4, { dateKey, storage: sharedStorage });
    const seenByA = await checkGptDecodeBudget({ capUsd: 1.0, dateKey, storage: sharedStorage, worstCaseUsd: 0 });
    expect(seenByA.spentUsd).toBeCloseTo(0.7, 5);
  });

  test("cents math: accumulates sub-cent spend without rounding to zero", async () => {
    const storage = memStorage();
    await recordGptDecodeSpend(0.003, { dateKey: "subcent-d1", storage });
    await recordGptDecodeSpend(0.003, { dateKey: "subcent-d1", storage });
    await recordGptDecodeSpend(0.003, { dateKey: "subcent-d1", storage });
    const r = await checkGptDecodeBudget({ capUsd: 1.0, dateKey: "subcent-d1", storage, worstCaseUsd: 0 });
    expect(r.spentUsd).toBeCloseTo(0.009, 6);
  });

  test("exact boundary: spend + worst case exactly equal to cap is still allowed (<=, not <)", async () => {
    const storage = memStorage();
    await recordGptDecodeSpend(0.61, { dateKey: "boundary-d1", storage });
    const r = await checkGptDecodeBudget({ capUsd: 1.0, dateKey: "boundary-d1", storage, worstCaseUsd: 0.39 });
    expect(r.spentUsd).toBeCloseTo(0.61, 5);
    expect(r.allowed).toBe(true);
  });

  test("a new date key resets", async () => {
    const storage = memStorage();
    await recordGptDecodeSpend(5, { dateKey: "reset-d1", storage });
    expect((await checkGptDecodeBudget({ capUsd: 1.0, dateKey: "reset-d2", storage })).allowed).toBe(true);
  });

  // TDD: a storage error must fail OPEN to the file/memory fallback, never fail-closed (a Turso
  // hiccup must not brick the paid rung's budget check for the whole app).
  test("falls back to file/memory when storage.get throws on a read", async () => {
    const file = tmpFile();
    const brokenStorage = {
      async get(): Promise<string | null> { throw new Error("storage unavailable"); },
      async set() {},
      async increment() { return 1; },
      async incrementBy(): Promise<number> { throw new Error("storage unavailable"); },
    };
    const r = await checkGptDecodeBudget({ capUsd: 1.0, dateKey: "broken-d1", file, storage: brokenStorage });
    expect(r.allowed).toBe(true); // fails OPEN: file/memory fallback reports 0 spent
    expect(r.spentUsd).toBe(0);
  });

  test("falls back to file/memory when storage.get throws on a write (recordGptDecodeSpend)", async () => {
    const file = tmpFile();
    const brokenStorage = {
      async get(): Promise<string | null> { throw new Error("storage unavailable"); },
      async set() {},
      async increment() { return 1; },
      async incrementBy(): Promise<number> { throw new Error("storage unavailable"); },
    };
    await recordGptDecodeSpend(0.5, { dateKey: "broken-write-d1", file, storage: brokenStorage });
    // The write fell through to the file adapter - a plain file-only read confirms it landed.
    const r = await checkGptDecodeBudget({ capUsd: 1.0, dateKey: "broken-write-d1", file });
    expect(r.spentUsd).toBeCloseTo(0.5, 5);
  });

  // Fix 2 (P6 ultra-review): recordGptDecodeSpend previously did storage.get then storage.set -
  // two concurrent calls racing on the SAME key can both read the same base value and the loser's
  // write clobbers the winner's, silently undercounting spend by one call's worth. The fix uses an
  // atomic incrementBy (in-SQL `value = value + ?` on Turso) instead of get-then-set.
  test("two concurrent recordGptDecodeSpend calls on the same key both land (sum, not last-write-wins)", async () => {
    const storage = serializedIncrementByStorage();
    const dateKey = "race-d1";
    await Promise.all([
      recordGptDecodeSpend(0.1, { dateKey, storage }),
      recordGptDecodeSpend(0.25, { dateKey, storage }),
    ]);
    const r = await checkGptDecodeBudget({ capUsd: 10, dateKey, storage, worstCaseUsd: 0 });
    // 0.1 + 0.25 = 0.35, NOT just 0.25 (or 0.1) from a lost-update race.
    expect(r.spentUsd).toBeCloseTo(0.35, 5);
  });

  test("twenty concurrent small spends on the same key all land (no lost updates)", async () => {
    const storage = serializedIncrementByStorage();
    const dateKey = "race-d2";
    await Promise.all(Array.from({ length: 20 }, () => recordGptDecodeSpend(0.01, { dateKey, storage })));
    const r = await checkGptDecodeBudget({ capUsd: 10, dateKey, storage, worstCaseUsd: 0 });
    expect(r.spentUsd).toBeCloseTo(0.2, 5);
  });
});

// FINDING A (P6 fix wave): recordGptDecodeSpend (write) and checkGptDecodeBudget (read) each
// independently caught their own storage error and fell back to the file guard. A transient error on
// ONLY the write silently rerouted that call's spend to the file (a documented no-op on Vercel's
// read-only FS) while subsequent reads saw only the durable Turso counter -> real spend permanently
// undercounted with only a warn. The fix: on a write failure, RETRY the atomic incrementBy ONCE; if it
// STILL fails, do the file fallback AND emit a structured "spend_write_diverged" event (single-line
// JSON via console.error) carrying the tenth-cent delta, so divergence is owner-visible, not silent.
describe("GPT decode $-guard write divergence (Finding A)", () => {
  beforeEach(() => {
    __resetForTest();
  });

  /** incrementBy that throws the first `failTimes` calls, then succeeds (serialized counter). */
  function flakyIncrementByStorage(failTimes: number) {
    const m = new Map<string, string>();
    let calls = 0;
    return {
      attempts: () => calls,
      async get(k: string) { return m.get(k) ?? null; },
      async set(k: string, v: string) { m.set(k, v); },
      async increment(k: string) { const n = Number(m.get(k) ?? "0") + 1; m.set(k, String(n)); return n; },
      async incrementBy(k: string, delta: number): Promise<number> {
        calls += 1;
        if (calls <= failTimes) throw new Error("storage write unavailable");
        const n = Number(m.get(k) ?? "0") + delta;
        m.set(k, String(n));
        return n;
      },
    };
  }

  test("write fails once then succeeds on retry: durable counter correct, NO divergence event", async () => {
    const storage = flakyIncrementByStorage(1);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await recordGptDecodeSpend(0.5, { dateKey: "retry-ok-d1", storage });
      // Two incrementBy attempts: one failure, one success (the retry landed durably).
      expect(storage.attempts()).toBe(2);
      const r = await checkGptDecodeBudget({ capUsd: 10, dateKey: "retry-ok-d1", storage, worstCaseUsd: 0 });
      expect(r.spentUsd).toBeCloseTo(0.5, 5); // durable counter has the spend
      const diverged = errSpy.mock.calls.some((c) => String(c[0]).includes("spend_write_diverged"));
      expect(diverged).toBe(false); // retry succeeded -> no divergence
    } finally {
      errSpy.mockRestore();
    }
  });

  test("write fails twice: retry attempted, file fallback fires, structured divergence event emitted", async () => {
    const file = tmpFile();
    const storage = flakyIncrementByStorage(2); // both the initial write and the single retry fail
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await recordGptDecodeSpend(0.5, { dateKey: "diverge-d1", file, storage });
      // Exactly two durable attempts: the initial write + ONE retry (never a third).
      expect(storage.attempts()).toBe(2);
      // Fell back to the file adapter - a plain file-only read confirms the spend landed there.
      const r = await checkGptDecodeBudget({ capUsd: 10, dateKey: "diverge-d1", file, worstCaseUsd: 0 });
      expect(r.spentUsd).toBeCloseTo(0.5, 5);
      // A structured, single-line JSON divergence event was emitted carrying the tenth-cent delta (500).
      const divergedCall = errSpy.mock.calls.find((c) => String(c[0]).includes("spend_write_diverged"));
      expect(divergedCall).toBeDefined();
      const payload = JSON.parse(String(divergedCall![0]));
      expect(payload.event).toBe("spend_write_diverged");
      expect(payload.tenthCentsDelta).toBe(500); // 0.5 USD -> 500 tenth-of-a-cent units
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("GPT decode call counter (durable, storage-backed)", () => {
  beforeEach(() => {
    __resetForTest();
  });

  test("recordGptDecodeCall increments the day's call count via storage.increment", async () => {
    const storage = memStorage();
    expect((await getGptDecodeStatus({ dateKey: "calls-d1", storage })).calls).toBe(0);
    await recordGptDecodeCall({ dateKey: "calls-d1", storage });
    expect((await getGptDecodeStatus({ dateKey: "calls-d1", storage })).calls).toBe(1);
    await recordGptDecodeCall({ dateKey: "calls-d1", storage });
    await recordGptDecodeCall({ dateKey: "calls-d1", storage });
    expect((await getGptDecodeStatus({ dateKey: "calls-d1", storage })).calls).toBe(3);
  });

  test("call count and spend coexist under the same storage handle without clobbering either key", async () => {
    const storage = memStorage();
    const dateKey = "calls-coexist-d1";
    await recordGptDecodeSpend(0.42, { dateKey, storage });
    await recordGptDecodeCall({ dateKey, storage });
    await recordGptDecodeCall({ dateKey, storage });
    const status = await getGptDecodeStatus({ dateKey, storage, capUsd: 1.0, worstCaseUsd: 0 });
    expect(status.spentUsd).toBeCloseTo(0.42, 5);
    expect(status.calls).toBe(2);
  });

  test("20 concurrent calls land on exactly 20 (atomicity contract, same seam as chargeDailySlot)", async () => {
    const storage = memStorage();
    const dateKey = "concurrent-calls-d1";
    await Promise.all(Array.from({ length: 20 }, () => recordGptDecodeCall({ dateKey, storage })));
    expect((await getGptDecodeStatus({ dateKey, storage })).calls).toBe(20);
  });
});
