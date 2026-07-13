// Characterization tests for tirePrefixHints.ts: the generated raw prefix->brand table itself.
// This is a GENERATED data file (see header comment in the source: "do not edit by hand"), so
// these tests pin STRUCTURE and CONTRACT invariants of the data, not any particular brand's
// presence (tirePrefixLookup.test.ts already covers the lookup/family logic and a few specific
// prefixes). Do not "fix" anything odd found here - note it in the task report instead.
import { describe, expect, test } from "vitest";
import { TIRE_PREFIX_HINTS, type PrefixHint } from "./tirePrefixHints";

describe("TIRE_PREFIX_HINTS: table shape contract", () => {
  test("is a non-empty plain object keyed by prefix string", () => {
    const keys = Object.keys(TIRE_PREFIX_HINTS);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(typeof k).toBe("string");
  });

  test("every entry is a non-empty array of PrefixHint objects with brand + weight", () => {
    for (const [prefix, hints] of Object.entries(TIRE_PREFIX_HINTS)) {
      expect(Array.isArray(hints), `prefix ${prefix} should map to an array`).toBe(true);
      expect(hints.length, `prefix ${prefix} should have at least one hint`).toBeGreaterThan(0);
      for (const h of hints) {
        expect(typeof h.brand, `prefix ${prefix} hint.brand`).toBe("string");
        expect(h.brand.length, `prefix ${prefix} hint.brand should be non-empty`).toBeGreaterThan(0);
        expect(["strong", "weak"]).toContain(h.weight);
      }
    }
  });

  test("every prefix key is purely numeric (digits only, no separators)", () => {
    for (const prefix of Object.keys(TIRE_PREFIX_HINTS)) {
      expect(prefix, `prefix "${prefix}" should be digits-only`).toMatch(/^\d+$/);
    }
  });

  test("optional 'source' field, when present, is a non-empty string", () => {
    for (const [prefix, hints] of Object.entries(TIRE_PREFIX_HINTS)) {
      for (const h of hints) {
        if (h.source !== undefined) {
          expect(typeof h.source, `prefix ${prefix} hint.source`).toBe("string");
          expect(h.source.length).toBeGreaterThan(0);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------- known prefix -> brand
describe("TIRE_PREFIX_HINTS: known prefix resolves to its documented brand(s)", () => {
  test("086699 (Michelin family) maps to Michelin, BFGoodrich, and Uniroyal (US) at strong weight", () => {
    const hints = TIRE_PREFIX_HINTS["086699"];
    const byBrand = (b: string) => hints.find((h) => h.brand === b);
    expect(byBrand("Michelin")?.weight).toBe("strong");
    expect(byBrand("BFGoodrich")?.weight).toBe("strong");
    expect(byBrand("Uniroyal (US)")?.weight).toBe("strong");
  });

  test("single-brand prefix 0191563 maps only to Nexen, strong", () => {
    expect(TIRE_PREFIX_HINTS["0191563"]).toEqual([{ brand: "Nexen", weight: "strong" }]);
  });

  test("a hint carrying a 'source' citation preserves the exact URL string", () => {
    const cooper = TIRE_PREFIX_HINTS["029142"].find((h) => h.brand === "Mastercraft");
    expect(cooper?.source).toBe("https://www.barcodespider.com/029142694212");
  });
});

// ---------------------------------------------------------------------------- unknown prefix -> null
describe("unknown prefix -> no entry (a direct lookup, not the fuzzy longest-prefix matcher)", () => {
  test("a prefix that does not appear in the table is simply absent from the object", () => {
    expect(TIRE_PREFIX_HINTS["999999999"]).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(TIRE_PREFIX_HINTS, "999999999")).toBe(false);
  });

  test("an empty-string key is not present", () => {
    expect(TIRE_PREFIX_HINTS[""]).toBeUndefined();
  });

  test("a non-numeric key is not present", () => {
    expect(TIRE_PREFIX_HINTS["ABCDEF"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------- ambiguous prefix never asserts a single brand
describe("ambiguous (multi-brand) prefixes expose every candidate; nothing collapses them to one", () => {
  test("069766 lists many brands (Dunlop/Kelly/Goodyear/etc.) at mixed weights - the table itself takes no side", () => {
    const hints = TIRE_PREFIX_HINTS["069766"];
    const brands = hints.map((h) => h.brand);
    expect(brands.length).toBeGreaterThan(3);
    expect(brands).toEqual(expect.arrayContaining(["Dunlop", "Kelly", "Goodyear"]));
    // Weak-weight siblings coexist with strong ones in the same array - the data does not prune.
    expect(hints.some((h) => h.weight === "weak")).toBe(true);
    expect(hints.some((h) => h.weight === "strong")).toBe(true);
  });

  test("multi-brand prefixes never dedupe to a single winner: array length matches distinct brand count", () => {
    const hints = TIRE_PREFIX_HINTS["029142"];
    const uniqueBrands = new Set(hints.map((h) => h.brand));
    // Every hint row is its own brand+weight+source combination; the table does not merge rows for
    // the same brand into one, so entries count and unique-brand count agree here.
    expect(hints.length).toBe(uniqueBrands.size);
  });

  test("029142 (Cooper family) never asserts ONLY one brand - both Cooper and Hercules are present", () => {
    const brands = TIRE_PREFIX_HINTS["029142"].map((h) => h.brand);
    expect(brands).toContain("Cooper");
    expect(brands).toContain("Hercules");
  });
});

// ---------------------------------------------------------------------------- exported type shape (compile-time + runtime sanity)
describe("PrefixHint type usage", () => {
  test("a hand-built PrefixHint literal matches the shape used throughout the table", () => {
    const h: PrefixHint = { brand: "Example", weight: "strong" };
    expect(h.brand).toBe("Example");
    expect(h.weight).toBe("strong");
    expect(h.source).toBeUndefined();
  });
});
