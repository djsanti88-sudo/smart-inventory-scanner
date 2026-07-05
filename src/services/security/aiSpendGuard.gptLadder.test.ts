import { beforeEach, describe, expect, test } from "vitest";
import {
  __resetForTest,
  checkAndIncrementDaily,
  checkGptLadderBudget,
  dailyUsage,
  getGptLadderStatus,
  recordGptLadderCall,
  recordGptLadderSpend,
} from "./aiSpendGuard";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpFile = () => join(mkdtempSync(join(tmpdir(), "gptguard-")), "usage.json");

describe("GPT ladder dollar guard", () => {
  beforeEach(() => {
    __resetForTest();
  });

  test("allows while spent + worst case fits, then blocks", () => {
    const file = tmpFile();
    expect(checkGptLadderBudget({ capUsd: 1.0, file, dateKey: "allow-then-block" }).allowed).toBe(true);
    recordGptLadderSpend(0.5, { file, dateKey: "allow-then-block" });
    expect(checkGptLadderBudget({ capUsd: 1.0, file, dateKey: "allow-then-block" }).allowed).toBe(true); // 0.5 + 0.39 <= 1.0
    recordGptLadderSpend(0.2, { file, dateKey: "allow-then-block" });
    const r = checkGptLadderBudget({ capUsd: 1.0, file, dateKey: "allow-then-block" });
    expect(r.allowed).toBe(false); // 0.7 + 0.39 > 1.0
    expect(r.spentUsd).toBeCloseTo(0.7, 5);
  });

  test("a new day resets", () => {
    const file = tmpFile();
    recordGptLadderSpend(5, { file, dateKey: "reset-d1" });
    expect(checkGptLadderBudget({ capUsd: 1.0, file, dateKey: "reset-d2" }).allowed).toBe(true);
  });

  test("survives process restart via the file (in-memory cleared, file is source of truth)", () => {
    const file = tmpFile();
    recordGptLadderSpend(0.9, { file, dateKey: "restart-d1" });
    __resetForTest(); // simulate a cold start: wipe in-memory state, only the file remains
    const r = checkGptLadderBudget({ capUsd: 1.0, file, dateKey: "restart-d1" });
    expect(r.allowed).toBe(false);
  });

  test("exact boundary: spend + worst case exactly equal to cap is still allowed (<=, not <)", () => {
    const file = tmpFile();
    recordGptLadderSpend(0.61, { file, dateKey: "boundary-d1" });
    const r = checkGptLadderBudget({ capUsd: 1.0, file, dateKey: "boundary-d1", worstCaseUsd: 0.39 });
    expect(r.spentUsd).toBeCloseTo(0.61, 5);
    expect(r.allowed).toBe(true); // 0.61 + 0.39 === 1.0, <= holds
  });

  test("accumulates sub-cent spend at 4-decimal (tenth-of-a-cent) precision instead of rounding to zero", () => {
    const file = tmpFile();
    // A searchless GPT call can cost as little as ~$0.003; 2-decimal rounding would zero every one.
    recordGptLadderSpend(0.003, { file, dateKey: "subcent-d1" });
    recordGptLadderSpend(0.003, { file, dateKey: "subcent-d1" });
    recordGptLadderSpend(0.003, { file, dateKey: "subcent-d1" });
    const r = checkGptLadderBudget({ capUsd: 1.0, file, dateKey: "subcent-d1", worstCaseUsd: 0 });
    expect(r.spentUsd).toBeCloseTo(0.009, 6);
  });
});

describe("GPT ladder call counter (Task 6: Settings spend panel + GET status)", () => {
  beforeEach(() => {
    __resetForTest();
  });

  test("recordGptLadderCall increments the day's call count", () => {
    const file = tmpFile();
    expect(getGptLadderStatus({ file, dateKey: "calls-d1" }).calls).toBe(0);
    recordGptLadderCall({ file, dateKey: "calls-d1" });
    expect(getGptLadderStatus({ file, dateKey: "calls-d1" }).calls).toBe(1);
    recordGptLadderCall({ file, dateKey: "calls-d1" });
    recordGptLadderCall({ file, dateKey: "calls-d1" });
    expect(getGptLadderStatus({ file, dateKey: "calls-d1" }).calls).toBe(3);
  });

  test("call count coexists with spend in the same file without clobbering either key", () => {
    const file = tmpFile(); // deliberately the SAME physical file both guards already share
    const dateKey = "calls-coexist-d1";
    recordGptLadderSpend(0.42, { file, dateKey });
    recordGptLadderCall({ file, dateKey });
    recordGptLadderCall({ file, dateKey });
    __resetForTest(); // simulate a cold start: only the file remains
    const status = getGptLadderStatus({ file, dateKey, capUsd: 1.0, worstCaseUsd: 0 });
    expect(status.spentUsd).toBeCloseTo(0.42, 5);
    expect(status.calls).toBe(2);
  });

  test("a new day resets the call count", () => {
    const file = tmpFile();
    recordGptLadderCall({ file, dateKey: "calls-reset-d1" });
    recordGptLadderCall({ file, dateKey: "calls-reset-d1" });
    expect(getGptLadderStatus({ file, dateKey: "calls-reset-d2" }).calls).toBe(0);
  });

  test("getGptLadderStatus reports allowed alongside spend/cap/calls", () => {
    const file = tmpFile();
    const before = getGptLadderStatus({ file, dateKey: "calls-allowed-d1", capUsd: 1.0, worstCaseUsd: 0.39 });
    expect(before.allowed).toBe(true);
    recordGptLadderSpend(0.7, { file, dateKey: "calls-allowed-d1" });
    const after = getGptLadderStatus({ file, dateKey: "calls-allowed-d1", capUsd: 1.0, worstCaseUsd: 0.39 });
    expect(after.allowed).toBe(false); // 0.7 + 0.39 > 1.0
  });
});

describe("checkAndIncrementDaily write path does not clobber the GPT ladder spend key (shared-file defense in depth)", () => {
  beforeEach(() => {
    __resetForTest();
  });

  test("daily counter merge-writes; ladder spend and daily count both survive a warm-memory increment + restart", () => {
    const file = tmpFile(); // deliberately the SAME physical file for both guards
    const dateKey = "shared-file-d1";

    // 1st daily increment (cold: file doesn't exist yet).
    const first = checkAndIncrementDaily({ limit: 200, file, dateKey });
    expect(first.allowed).toBe(true);
    expect(first.used).toBe(1);

    // The ladder guard records spend into the SAME file, under its own top-level key.
    recordGptLadderSpend(0.42, { file, dateKey });

    // 2nd daily increment with WARM in-memory state - this is exactly the call that clobbered the
    // ladder guard's key on disk before the fix (a plain JSON.stringify(state) overwrote the file).
    const second = checkAndIncrementDaily({ limit: 200, file, dateKey });
    expect(second.allowed).toBe(true);
    expect(second.used).toBe(2);

    // Simulate a process restart: wipe ALL in-memory state, the file is the only source of truth.
    __resetForTest();

    const spendAfterRestart = checkGptLadderBudget({ file, dateKey, capUsd: 1.0, worstCaseUsd: 0 });
    expect(spendAfterRestart.spentUsd).toBeCloseTo(0.42, 5);

    const dailyAfterRestart = dailyUsage({ file, dateKey });
    expect(dailyAfterRestart.count).toBe(2);
  });
});
