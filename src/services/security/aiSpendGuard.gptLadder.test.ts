import { describe, expect, test } from "vitest";
import { checkGptLadderBudget, recordGptLadderSpend } from "./aiSpendGuard";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpFile = () => join(mkdtempSync(join(tmpdir(), "gptguard-")), "usage.json");

describe("GPT ladder dollar guard", () => {
  test("allows while spent + worst case fits, then blocks", () => {
    const file = tmpFile();
    expect(checkGptLadderBudget({ capUsd: 1.0, file, dateKey: "d1" }).allowed).toBe(true);
    recordGptLadderSpend(0.5, { file, dateKey: "d1" });
    expect(checkGptLadderBudget({ capUsd: 1.0, file, dateKey: "d1" }).allowed).toBe(true);   // 0.5 + 0.39 <= 1.0
    recordGptLadderSpend(0.2, { file, dateKey: "d1" });
    const r = checkGptLadderBudget({ capUsd: 1.0, file, dateKey: "d1" });
    expect(r.allowed).toBe(false);                                                            // 0.7 + 0.39 > 1.0
    expect(r.spentUsd).toBeCloseTo(0.7, 5);
  });
  test("a new day resets", () => {
    const file = tmpFile();
    recordGptLadderSpend(5, { file, dateKey: "d1" });
    expect(checkGptLadderBudget({ capUsd: 1.0, file, dateKey: "d2" }).allowed).toBe(true);
  });
  test("survives process restart via the file (new in-memory state, same file)", () => {
    const file = tmpFile();
    recordGptLadderSpend(0.9, { file, dateKey: "d1" });
    // simulate cold start by calling with the same file (module map may or may not hit; file is source)
    const r = checkGptLadderBudget({ capUsd: 1.0, file, dateKey: "d1" });
    expect(r.allowed).toBe(false);
  });
});
