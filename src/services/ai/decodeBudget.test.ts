import { describe, it, expect } from "vitest";
import {
  clampDecodeBudgetMs,
  DECODE_BUDGET_MIN_MS,
  DECODE_BUDGET_MAX_MS,
  DECODE_BUDGET_DEFAULT_MS,
} from "@/services/ai/decodeBudget";

describe("clampDecodeBudgetMs (server-side safety clamp)", () => {
  it("passes a valid in-range budget through", () => {
    expect(clampDecodeBudgetMs(8000)).toBe(8000);
  });

  it("clamps an abusive large budget to the max", () => {
    expect(clampDecodeBudgetMs(600_000)).toBe(DECODE_BUDGET_MAX_MS);
  });

  it("clamps a too-small budget to the min", () => {
    expect(clampDecodeBudgetMs(100)).toBe(DECODE_BUDGET_MIN_MS);
  });

  it("falls back to the default for missing or invalid input", () => {
    expect(clampDecodeBudgetMs(undefined)).toBe(DECODE_BUDGET_DEFAULT_MS);
    expect(clampDecodeBudgetMs("nonsense")).toBe(DECODE_BUDGET_DEFAULT_MS);
    expect(clampDecodeBudgetMs(0)).toBe(DECODE_BUDGET_DEFAULT_MS);
    expect(clampDecodeBudgetMs(-5)).toBe(DECODE_BUDGET_DEFAULT_MS);
  });

  it("clamps an out-of-range fallback too", () => {
    expect(clampDecodeBudgetMs(undefined, 999_999)).toBe(DECODE_BUDGET_MAX_MS);
  });

  it("caps live AI decode at 8s and defaults to 8s (owner cost rule)", () => {
    expect(DECODE_BUDGET_MAX_MS).toBe(8_000);
    expect(DECODE_BUDGET_DEFAULT_MS).toBe(8_000);
    expect(clampDecodeBudgetMs(13_000)).toBe(8_000); // a stale 13s client setting is clamped down
  });

  // B6 (2026-07-15): exact boundary assertions for the [5000, 8000] clamp range - the tests above cover
  // clearly-out-of-range values; these pin the exact edges so a future off-by-one in clampToRange trips
  // immediately.
  it("B6: clamp bounds are exactly [5000, 8000]", () => {
    expect(clampDecodeBudgetMs(1)).toBe(5000);
    expect(clampDecodeBudgetMs(4999)).toBe(5000);
    expect(clampDecodeBudgetMs(8001)).toBe(8000);
    expect(clampDecodeBudgetMs(20000)).toBe(8000);
    expect(clampDecodeBudgetMs(undefined)).toBe(8000);
    expect(clampDecodeBudgetMs("garbage")).toBe(8000);
  });
});
