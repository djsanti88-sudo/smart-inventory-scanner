import { beforeEach, describe, expect, test } from "vitest";
import {
  __resetForTest,
  checkGptLadderBudget,
  getGptLadderStatus,
  recordGptLadderCall,
  recordGptLadderSpend,
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
  };
}

describe("GPT ladder dollar guard (file/memory fallback, no storage)", () => {
  beforeEach(() => {
    __resetForTest();
  });

  test("allows while spent + worst case fits, then blocks", async () => {
    const file = tmpFile();
    expect((await checkGptLadderBudget({ capUsd: 1.0, file, dateKey: "allow-then-block" })).allowed).toBe(true);
    await recordGptLadderSpend(0.5, { file, dateKey: "allow-then-block" });
    expect((await checkGptLadderBudget({ capUsd: 1.0, file, dateKey: "allow-then-block" })).allowed).toBe(true); // 0.5 + 0.39 <= 1.0
    await recordGptLadderSpend(0.2, { file, dateKey: "allow-then-block" });
    const r = await checkGptLadderBudget({ capUsd: 1.0, file, dateKey: "allow-then-block" });
    expect(r.allowed).toBe(false); // 0.7 + 0.39 > 1.0
    expect(r.spentUsd).toBeCloseTo(0.7, 5);
  });

  test("a new day resets", async () => {
    const file = tmpFile();
    await recordGptLadderSpend(5, { file, dateKey: "reset-d1" });
    expect((await checkGptLadderBudget({ capUsd: 1.0, file, dateKey: "reset-d2" })).allowed).toBe(true);
  });

  test("survives process restart via the file (in-memory cleared, file is source of truth)", async () => {
    const file = tmpFile();
    await recordGptLadderSpend(0.9, { file, dateKey: "restart-d1" });
    __resetForTest(); // simulate a cold start: wipe in-memory state, only the file remains
    const r = await checkGptLadderBudget({ capUsd: 1.0, file, dateKey: "restart-d1" });
    expect(r.allowed).toBe(false);
  });

  test("exact boundary: spend + worst case exactly equal to cap is still allowed (<=, not <)", async () => {
    const file = tmpFile();
    await recordGptLadderSpend(0.61, { file, dateKey: "boundary-d1" });
    const r = await checkGptLadderBudget({ capUsd: 1.0, file, dateKey: "boundary-d1", worstCaseUsd: 0.39 });
    expect(r.spentUsd).toBeCloseTo(0.61, 5);
    expect(r.allowed).toBe(true); // 0.61 + 0.39 === 1.0, <= holds
  });

  test("accumulates sub-cent spend at 4-decimal (tenth-of-a-cent) precision instead of rounding to zero", async () => {
    const file = tmpFile();
    // A searchless GPT call can cost as little as ~$0.003; 2-decimal rounding would zero every one.
    await recordGptLadderSpend(0.003, { file, dateKey: "subcent-d1" });
    await recordGptLadderSpend(0.003, { file, dateKey: "subcent-d1" });
    await recordGptLadderSpend(0.003, { file, dateKey: "subcent-d1" });
    const r = await checkGptLadderBudget({ capUsd: 1.0, file, dateKey: "subcent-d1", worstCaseUsd: 0 });
    expect(r.spentUsd).toBeCloseTo(0.009, 6);
  });
});

describe("GPT ladder call counter (file/memory fallback, no storage)", () => {
  beforeEach(() => {
    __resetForTest();
  });

  test("recordGptLadderCall increments the day's call count", async () => {
    const file = tmpFile();
    expect((await getGptLadderStatus({ file, dateKey: "calls-d1" })).calls).toBe(0);
    await recordGptLadderCall({ file, dateKey: "calls-d1" });
    expect((await getGptLadderStatus({ file, dateKey: "calls-d1" })).calls).toBe(1);
    await recordGptLadderCall({ file, dateKey: "calls-d1" });
    await recordGptLadderCall({ file, dateKey: "calls-d1" });
    expect((await getGptLadderStatus({ file, dateKey: "calls-d1" })).calls).toBe(3);
  });

  test("call count coexists with spend in the same file without clobbering either key", async () => {
    const file = tmpFile(); // deliberately the SAME physical file both guards already share
    const dateKey = "calls-coexist-d1";
    await recordGptLadderSpend(0.42, { file, dateKey });
    await recordGptLadderCall({ file, dateKey });
    await recordGptLadderCall({ file, dateKey });
    __resetForTest(); // simulate a cold start: only the file remains
    const status = await getGptLadderStatus({ file, dateKey, capUsd: 1.0, worstCaseUsd: 0 });
    expect(status.spentUsd).toBeCloseTo(0.42, 5);
    expect(status.calls).toBe(2);
  });

  test("a new day resets the call count", async () => {
    const file = tmpFile();
    await recordGptLadderCall({ file, dateKey: "calls-reset-d1" });
    await recordGptLadderCall({ file, dateKey: "calls-reset-d1" });
    expect((await getGptLadderStatus({ file, dateKey: "calls-reset-d2" })).calls).toBe(0);
  });

  test("getGptLadderStatus reports allowed alongside spend/cap/calls", async () => {
    const file = tmpFile();
    const before = await getGptLadderStatus({ file, dateKey: "calls-allowed-d1", capUsd: 1.0, worstCaseUsd: 0.39 });
    expect(before.allowed).toBe(true);
    await recordGptLadderSpend(0.7, { file, dateKey: "calls-allowed-d1" });
    const after = await getGptLadderStatus({ file, dateKey: "calls-allowed-d1", capUsd: 1.0, worstCaseUsd: 0.39 });
    expect(after.allowed).toBe(false); // 0.7 + 0.39 > 1.0
  });
});

// B1 (2026-07-20): the GPT ladder $-guard migrated onto the durable LadderStorage KV seam (the same
// injected get/set/increment shape chargeDailySlot uses). Dollar amounts are stored as integer
// tenth-of-a-cent units so sub-cent spend never rounds to zero and the persisted value stays exact.
describe("GPT ladder dollar guard (durable, storage-backed)", () => {
  beforeEach(() => {
    __resetForTest();
  });

  test("allows while spent + worst case fits, then blocks", async () => {
    const storage = memStorage();
    expect((await checkGptLadderBudget({ capUsd: 1.0, dateKey: "d1", storage })).allowed).toBe(true);
    await recordGptLadderSpend(0.5, { dateKey: "d1", storage });
    expect((await checkGptLadderBudget({ capUsd: 1.0, dateKey: "d1", storage })).allowed).toBe(true);
    await recordGptLadderSpend(0.2, { dateKey: "d1", storage });
    const r = await checkGptLadderBudget({ capUsd: 1.0, dateKey: "d1", storage });
    expect(r.allowed).toBe(false);
    expect(r.spentUsd).toBeCloseTo(0.7, 5);
  });

  // TDD: two independent "instances" (e.g. two warm serverless lambdas, no shared process memory)
  // must see the SAME accumulated spend when they share one storage handle - the entire point of B1.
  test("two independent instances sharing one storage handle see the SAME accumulated spend", async () => {
    const sharedStorage = memStorage();
    const dateKey = "shared-instances-d1";
    // "Instance A" records spend.
    await recordGptLadderSpend(0.3, { dateKey, storage: sharedStorage });
    // "Instance B" (a fresh call, no shared in-memory state beyond the storage handle) sees it.
    const seenByB = await checkGptLadderBudget({ capUsd: 1.0, dateKey, storage: sharedStorage, worstCaseUsd: 0 });
    expect(seenByB.spentUsd).toBeCloseTo(0.3, 5);
    // Instance B also records spend; Instance A's next read must see the combined total.
    await recordGptLadderSpend(0.4, { dateKey, storage: sharedStorage });
    const seenByA = await checkGptLadderBudget({ capUsd: 1.0, dateKey, storage: sharedStorage, worstCaseUsd: 0 });
    expect(seenByA.spentUsd).toBeCloseTo(0.7, 5);
  });

  test("cents math: accumulates sub-cent spend without rounding to zero", async () => {
    const storage = memStorage();
    await recordGptLadderSpend(0.003, { dateKey: "subcent-d1", storage });
    await recordGptLadderSpend(0.003, { dateKey: "subcent-d1", storage });
    await recordGptLadderSpend(0.003, { dateKey: "subcent-d1", storage });
    const r = await checkGptLadderBudget({ capUsd: 1.0, dateKey: "subcent-d1", storage, worstCaseUsd: 0 });
    expect(r.spentUsd).toBeCloseTo(0.009, 6);
  });

  test("exact boundary: spend + worst case exactly equal to cap is still allowed (<=, not <)", async () => {
    const storage = memStorage();
    await recordGptLadderSpend(0.61, { dateKey: "boundary-d1", storage });
    const r = await checkGptLadderBudget({ capUsd: 1.0, dateKey: "boundary-d1", storage, worstCaseUsd: 0.39 });
    expect(r.spentUsd).toBeCloseTo(0.61, 5);
    expect(r.allowed).toBe(true);
  });

  test("a new date key resets", async () => {
    const storage = memStorage();
    await recordGptLadderSpend(5, { dateKey: "reset-d1", storage });
    expect((await checkGptLadderBudget({ capUsd: 1.0, dateKey: "reset-d2", storage })).allowed).toBe(true);
  });

  // TDD: a storage error must fail OPEN to the file/memory fallback, never fail-closed (a Turso
  // hiccup must not brick the paid rung's budget check for the whole app).
  test("falls back to file/memory when storage.get throws on a read", async () => {
    const file = tmpFile();
    const brokenStorage = {
      async get(): Promise<string | null> { throw new Error("storage unavailable"); },
      async set() {},
      async increment() { return 1; },
    };
    const r = await checkGptLadderBudget({ capUsd: 1.0, dateKey: "broken-d1", file, storage: brokenStorage });
    expect(r.allowed).toBe(true); // fails OPEN: file/memory fallback reports 0 spent
    expect(r.spentUsd).toBe(0);
  });

  test("falls back to file/memory when storage.get throws on a write (recordGptLadderSpend)", async () => {
    const file = tmpFile();
    const brokenStorage = {
      async get(): Promise<string | null> { throw new Error("storage unavailable"); },
      async set() {},
      async increment() { return 1; },
    };
    await recordGptLadderSpend(0.5, { dateKey: "broken-write-d1", file, storage: brokenStorage });
    // The write fell through to the file adapter - a plain file-only read confirms it landed.
    const r = await checkGptLadderBudget({ capUsd: 1.0, dateKey: "broken-write-d1", file });
    expect(r.spentUsd).toBeCloseTo(0.5, 5);
  });
});

describe("GPT ladder call counter (durable, storage-backed)", () => {
  beforeEach(() => {
    __resetForTest();
  });

  test("recordGptLadderCall increments the day's call count via storage.increment", async () => {
    const storage = memStorage();
    expect((await getGptLadderStatus({ dateKey: "calls-d1", storage })).calls).toBe(0);
    await recordGptLadderCall({ dateKey: "calls-d1", storage });
    expect((await getGptLadderStatus({ dateKey: "calls-d1", storage })).calls).toBe(1);
    await recordGptLadderCall({ dateKey: "calls-d1", storage });
    await recordGptLadderCall({ dateKey: "calls-d1", storage });
    expect((await getGptLadderStatus({ dateKey: "calls-d1", storage })).calls).toBe(3);
  });

  test("call count and spend coexist under the same storage handle without clobbering either key", async () => {
    const storage = memStorage();
    const dateKey = "calls-coexist-d1";
    await recordGptLadderSpend(0.42, { dateKey, storage });
    await recordGptLadderCall({ dateKey, storage });
    await recordGptLadderCall({ dateKey, storage });
    const status = await getGptLadderStatus({ dateKey, storage, capUsd: 1.0, worstCaseUsd: 0 });
    expect(status.spentUsd).toBeCloseTo(0.42, 5);
    expect(status.calls).toBe(2);
  });

  test("20 concurrent calls land on exactly 20 (atomicity contract, same seam as chargeDailySlot)", async () => {
    const storage = memStorage();
    const dateKey = "concurrent-calls-d1";
    await Promise.all(Array.from({ length: 20 }, () => recordGptLadderCall({ dateKey, storage })));
    expect((await getGptLadderStatus({ dateKey, storage })).calls).toBe(20);
  });
});
