// @vitest-environment node
//
// Regression coverage for the 2026-08-12 invariant audit finding #2 (daily-cap charge-mode predicate).
// See decodeMode.ts for the full rationale and LESSONS_LEARNED L12 (232 vs ~27 double-charge incident).
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { isDecodeChargeMode } from "./decodeMode";

describe("isDecodeChargeMode (shared daily-cap charge-mode predicate)", () => {
  it("treats decode and decode-deep as decode-charge modes", () => {
    expect(isDecodeChargeMode("decode")).toBe(true);
    expect(isDecodeChargeMode("decode-deep")).toBe(true);
  });

  it("treats the deleted legacy 'lookup' mode, undefined, and unrecognized strings as NOT decode-charge modes", () => {
    expect(isDecodeChargeMode("lookup")).toBe(false);
    expect(isDecodeChargeMode(undefined)).toBe(false);
    expect(isDecodeChargeMode("garbage")).toBe(false);
    expect(isDecodeChargeMode("")).toBe(false);
  });

  it("route.ts decides 'is this a decode request' ONLY through the shared predicate, exactly once, " +
     "with no inline body.mode comparison anywhere in the file (the L12 drift shape)", () => {
    const routeSrc = fs.readFileSync(path.join(__dirname, "route.ts"), "utf8");

    // No route-local re-derivation of the comparison. If a future change adds an independent
    // `body.mode === "decode"`-style check instead of reusing isDecodeChargeMode, this fails.
    const inlineModeComparisons = routeSrc.match(/body\.mode\s*===\s*["']decode/g) ?? [];
    expect(inlineModeComparisons.length).toBe(0);

    // Exactly one call site: the admission gate that 400s every non-decode request before any auth,
    // counter read, or storage touch. Nothing downstream re-checks the mode.
    const predicateCalls = routeSrc.match(/isDecodeChargeMode\(body\.mode\)/g) ?? [];
    expect(predicateCalls.length).toBe(1);
    expect(routeSrc).toMatch(/if \(!isDecodeChargeMode\(body\.mode\)\) \{/);
    expect(routeSrc).toMatch(/reasonCode: "unsupported_mode"/);
  });
});
