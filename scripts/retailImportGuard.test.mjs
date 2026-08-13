// Regression guard for TL-5 (2026-08-13): import-retail-turso.mjs --force DROPped the LIVE Turso
// retail table (~4.13M rows in production) and reimported from the local JSON with zero check that
// the local source was complete. A stale or truncated local file would silently destroy the
// production retail corpus. This mirrors build-tire-knowledge.mjs's shrinkguard tests, but tests the
// pure decision function directly (scripts/retailImportGuard.mjs) rather than executing the real
// script, since the real script always opens a live Turso connection and this suite must never touch
// a real database.

import { describe, it, expect } from "vitest";
import { evaluateShrinkGuard, MIN_RETAINED_FRACTION } from "./retailImportGuard.mjs";

describe("import-retail-turso pre-drop shrink guard (TL-5)", () => {
  it("refuses when the local source has materially fewer rows than the live table", () => {
    const result = evaluateShrinkGuard(1_000_000, 4_130_000, false);
    expect(result.refuse).toBe(true);
    expect(result.reason).toMatch(/1000000/);
    expect(result.reason).toMatch(/4130000/);
    expect(result.reason).toMatch(/force-shrink/i);
  });

  it("allows when the local source is at or above the retained fraction of the live table", () => {
    const atThreshold = evaluateShrinkGuard(Math.ceil(4_130_000 * MIN_RETAINED_FRACTION), 4_130_000, false);
    expect(atThreshold.refuse).toBe(false);

    const larger = evaluateShrinkGuard(5_000_000, 4_130_000, false);
    expect(larger.refuse).toBe(false);
  });

  it("allows a deliberate shrink when --force-shrink is passed", () => {
    const result = evaluateShrinkGuard(10, 4_130_000, true);
    expect(result.refuse).toBe(false);
    expect(result.reason).toBeNull();
  });

  it("never refuses when there is no live data to protect", () => {
    const result = evaluateShrinkGuard(0, 0, false);
    expect(result.refuse).toBe(false);
  });

  it("uses a custom retained fraction when provided", () => {
    // 50% threshold: 2M local rows against 4.13M live rows now passes.
    const result = evaluateShrinkGuard(2_000_000, 4_130_000, false, 0.4);
    expect(result.refuse).toBe(false);
  });
});
