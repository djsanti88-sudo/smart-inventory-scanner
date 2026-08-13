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

  it("treats lookup, undefined, and unrecognized strings as NOT decode-charge modes", () => {
    expect(isDecodeChargeMode("lookup")).toBe(false);
    expect(isDecodeChargeMode(undefined)).toBe(false);
    expect(isDecodeChargeMode("garbage")).toBe(false);
    expect(isDecodeChargeMode("")).toBe(false);
  });

  it("route.ts derives isDecodeMode from the shared predicate exactly once, with no second inline " +
     "body.mode comparison anywhere else in the file (the L12 drift shape)", () => {
    const routeSrc = fs.readFileSync(path.join(__dirname, "route.ts"), "utf8");

    // Exactly one computation of isDecodeMode, and it must call the shared predicate - not re-derive the
    // comparison inline. If a future change adds a second independent `body.mode === "decode"`-style
    // check anywhere in route.ts (instead of reusing isDecodeChargeMode/isDecodeMode), this fails.
    const inlineModeComparisons = routeSrc.match(/body\.mode\s*===\s*["']decode/g) ?? [];
    expect(inlineModeComparisons.length).toBe(0);

    const assignments = routeSrc.match(/const isDecodeMode = [^\n]+/g) ?? [];
    expect(assignments.length).toBe(1);
    expect(assignments[0]).toMatch(/^const isDecodeMode = isDecodeChargeMode\(body\.mode\);$/);

    // Both charge-relevant call sites still gate on that single shared boolean.
    expect(routeSrc).toMatch(/!e2eMode\(\) && !isDecodeMode/); // skip the legacy lookup-mode charge
    expect(routeSrc).toMatch(/if \(isDecodeMode\) \{/); // dispatch to the decode pipeline's own charge
  });
});
