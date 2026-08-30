import { describe, it, expect } from "vitest";
import { levenshteinWithin } from "@/shared/text/textDistance";

// QA Task 8 (owner-approved 2026-07-15): pure, bounded Levenshtein distance used ONLY to power a
// review-only "Did you mean <X>?" suggestion for alpha_sku typos. This module does no matching by
// itself - it just measures edit distance with an early-exit bound so it never becomes a full O(n*m)
// scan cost across a large catalog.

describe("levenshteinWithin (bounded Levenshtein distance)", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshteinWithin("T432119", "T432119", 2)).toBe(0);
  });

  it("returns 1 for a single-character substitution (T432118 vs T432119)", () => {
    expect(levenshteinWithin("T432118", "T432119", 2)).toBe(1);
  });

  it("returns 1 for a single-character insertion", () => {
    expect(levenshteinWithin("ABC12", "ABC123", 2)).toBe(1);
  });

  it("returns 1 for a single-character deletion", () => {
    expect(levenshteinWithin("ABC123", "ABC12", 2)).toBe(1);
  });

  it("returns null (not computed) when the true distance exceeds the bound - never returns a misleading large number", () => {
    // "T432118" vs "Z999999" differs in every position - true distance is far beyond bound 1.
    expect(levenshteinWithin("T432118", "Z999999", 1)).toBeNull();
  });

  it("is case-insensitive (SKUs are typically compared case-insensitively)", () => {
    expect(levenshteinWithin("abc123", "ABC123", 2)).toBe(0);
  });

  it("returns null for empty strings (no meaningful distance)", () => {
    expect(levenshteinWithin("", "T432119", 2)).toBeNull();
    expect(levenshteinWithin("T432119", "", 2)).toBeNull();
  });
});
