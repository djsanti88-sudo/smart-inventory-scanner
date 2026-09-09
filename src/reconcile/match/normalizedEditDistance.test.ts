// src/reconcile/match/normalizedEditDistance.test.ts
import { describe, expect, it } from "vitest";
import { normalizedEditSimilarity } from "@/reconcile/match/normalizedEditDistance";

describe("normalizedEditSimilarity", () => {
  it("handles exact, empty, and unrelated strings", () => {
    expect(normalizedEditSimilarity("Michelin", "michelin")).toBe(1);
    expect(normalizedEditSimilarity("", "")).toBe(1);
    expect(normalizedEditSimilarity("", "road")).toBe(0);
    expect(normalizedEditSimilarity("abc", "xyz")).toBe(0);
  });

  it("scores a one-character typo at or above 0.75", () => {
    expect(normalizedEditSimilarity("Michelin", "Micheln")).toBeGreaterThanOrEqual(0.75);
  });

  it("is symmetric", () => {
    expect(normalizedEditSimilarity("Defender", "Defendr")).toBe(
      normalizedEditSimilarity("Defendr", "Defender"),
    );
  });
});
