// @vitest-environment node
import { describe, it, expect } from "vitest";
import { isGarbledCorpusRow } from "./corpusGarbage";

describe("isGarbledCorpusRow - Task 5 corpus-poisoning firewall", () => {
  it("flags the live-poisoned row: run-on multi-brand tag list", () => {
    expect(
      isGarbledCorpusRow("Peanut Butter Crunch", "Fleischer, Selbst gemacht, The Wholesome Bar, Uberti"),
    ).toBe(true);
  });

  it("flags an over-length brand blob", () => {
    const blob = "A".repeat(90);
    expect(isGarbledCorpusRow("Some Product", blob)).toBe(true);
  });

  it("flags an ingredient/nutrition run-on NAME (many words)", () => {
    const name =
      "Ingredients sugar palm oil hazelnuts cocoa skimmed milk powder emulsifier lecithin storage keep cool dry";
    expect(isGarbledCorpusRow(name, "Somebrand")).toBe(true);
  });

  it("does NOT flag a clean real row", () => {
    expect(isGarbledCorpusRow("Pringles Scorchin Cheddar", "Pringles")).toBe(false);
    expect(isGarbledCorpusRow("Diet Coke 12 fl oz", "Coca-Cola")).toBe(false);
    expect(isGarbledCorpusRow("Michelin Defender", "Michelin")).toBe(false);
  });

  it("does NOT flag a clean name with an empty brand", () => {
    expect(isGarbledCorpusRow("Peanut Butter Crunch", "")).toBe(false);
  });
});
