import { describe, it, expect } from "vitest";
import { clampConfidenceThreshold, DEFAULT_THRESHOLD, MIN_THRESHOLD, MAX_THRESHOLD } from "./decodePolicy";

describe("clampConfidenceThreshold", () => {
  it("defaults when the value is missing or not a number", () => {
    expect(clampConfidenceThreshold(undefined)).toBe(DEFAULT_THRESHOLD);
    expect(clampConfidenceThreshold("0.9" as unknown)).toBe(DEFAULT_THRESHOLD);
    expect(clampConfidenceThreshold(NaN)).toBe(DEFAULT_THRESHOLD);
  });
  it("clamps a too-low value up to the floor (blocks force-verify)", () => {
    expect(clampConfidenceThreshold(0)).toBe(MIN_THRESHOLD);
    expect(clampConfidenceThreshold(-5)).toBe(MIN_THRESHOLD);
  });
  it("clamps a too-high value down to the ceiling (blocks force-review)", () => {
    expect(clampConfidenceThreshold(2)).toBe(MAX_THRESHOLD);
  });
  it("passes a valid in-range value through", () => {
    expect(clampConfidenceThreshold(0.85)).toBe(0.85);
  });
});
