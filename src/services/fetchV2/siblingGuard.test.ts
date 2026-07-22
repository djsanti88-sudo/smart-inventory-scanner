// Characterization tests for siblingGuard.ts: same-brand-different-variant detection.
// These PIN current behavior exactly as written. Do not "fix" anything odd here - note it in
// the task report instead. engine.test.ts already covers most identityRelation/
// detectSiblingAmbiguity live-bug regressions; this file focuses on: empty/edge string inputs to
// sizesOf/canon (reached only indirectly through identityRelation, since neither is exported),
// mixed tire-size notation equivalence, brand-compatibility edge cases, and the exported
// IdentityCandidate/SiblingVerdict contract itself.
import { describe, expect, test } from "vitest";
import { identityRelation, detectSiblingAmbiguity, type IdentityCandidate } from "./siblingGuard";

// ---------------------------------------------------------------------------- empty / edge inputs
describe("identityRelation: empty and edge-case name/brand inputs", () => {
  test("two candidates with empty names are 'agree' (jaccard of two empty sets is defined as 1)", () => {
    expect(identityRelation({ name: "", brand: "" }, { name: "", brand: "" })).toBe("agree");
  });

  test("one empty name vs one real name: no size clash, low token overlap => unrelated", () => {
    expect(identityRelation({ name: "", brand: "" }, { name: "Michelin Pilot Sport 4 245/35R19", brand: "" })).toBe("unrelated");
  });

  test("whitespace-only name behaves the same as empty name", () => {
    expect(identityRelation({ name: "   ", brand: "" }, { name: "   ", brand: "" })).toBe("agree");
  });

  test("null/undefined-like brand values do not throw (guarded by ?? in canon/brandsCompatible)", () => {
    const a: IdentityCandidate = { name: "Doritos Cool Ranch 9.25 oz", brand: undefined as unknown as string };
    const b: IdentityCandidate = { name: "Doritos Cool Ranch 9.25 oz", brand: undefined as unknown as string };
    expect(() => identityRelation(a, b)).not.toThrow();
    expect(identityRelation(a, b)).toBe("agree");
  });

  test("identical names, identical brands => agree", () => {
    expect(identityRelation({ name: "Bridgestone Turanza 225/60R16", brand: "Bridgestone" }, { name: "Bridgestone Turanza 225/60R16", brand: "Bridgestone" })).toBe("agree");
  });
});

// ---------------------------------------------------------------------------- tire size notation equivalence
describe("identityRelation: mixed tire-size notation normalizes to the same size", () => {
  test("slash notation and X-separator notation agree on the same size", () => {
    expect(identityRelation(
      { name: "Falken Wildpeak A/T3W 265/70R17", brand: "Falken" },
      { name: "Falken Wildpeak A/T3W 265X70R17", brand: "Falken" },
    )).toBe("agree");
  });

  test("dash-notation motorcycle size matches R-notation of the same size", () => {
    expect(identityRelation(
      { name: "ContiGO 100/80-17 Tire", brand: "Continental" },
      { name: "ContiGO 100/80R17 Tire", brand: "Continental" },
    )).toBe("agree");
  });

  test("glued ST/LT/P service prefixes normalize away: ST225/75R15 === 225/75R15", () => {
    expect(identityRelation(
      { name: "Carlisle Trail ST225/75R15 Trailer Tire", brand: "Carlisle" },
      { name: "Carlisle Trail 225/75R15 Trailer Tire", brand: "Carlisle" },
    )).toBe("agree");
  });

  test("a Z-speed-rating prefix normalizes away: 255/45ZR18 === 255/45R18", () => {
    expect(identityRelation(
      { name: "Pirelli P Zero 255/45ZR18 Model", brand: "Pirelli" },
      { name: "Pirelli P Zero 255/45R18 Model", brand: "Pirelli" },
    )).toBe("agree");
  });

  test("decimal commercial rim sizes are preserved and must match exactly: 275/80R22.5 != 275/80R22", () => {
    // 275/80R22 is not a real size but pins that the decimal is NOT silently dropped by sizesOf.
    const rel = identityRelation(
      { name: "Michelin XZE2 275/80R22.5 Commercial", brand: "Michelin" },
      { name: "Michelin XZE2 275/80R22 Commercial", brand: "Michelin" },
    );
    expect(rel).not.toBe("agree");
  });

  test("spaced-out merchant-feed notation normalizes the same as glued notation", () => {
    expect(identityRelation(
      { name: "Toyo Extensa 225 /35 R20 90W", brand: "Toyo" },
      { name: "Toyo Extensa 225/35R20 90W", brand: "Toyo" },
    )).toBe("agree");
  });

  test("different tire sizes on the same model => sibling, not agree or unrelated", () => {
    expect(identityRelation(
      { name: "Falken Wildpeak A/T3W 265/70R17", brand: "Falken" },
      { name: "Falken Wildpeak A/T3W 275/65R18", brand: "Falken" },
    )).toBe("sibling");
  });
});

// ---------------------------------------------------------------------------- pack-size unit isolation
describe("identityRelation: pack-size units only clash within the same unit", () => {
  test("same product name, different weight units (oz vs g) is NOT treated as a conflicting size", () => {
    expect(identityRelation(
      { name: "Squire Boone Village Rainbow Cherry 0.75 oz", brand: "" },
      { name: "Squire Boone Village Rainbow Cherry 22 g", brand: "" },
    )).not.toBe("sibling");
  });

  test("same product name, same unit, DIFFERENT value is a sibling (real size variant)", () => {
    expect(identityRelation(
      { name: "Lays Classic Potato Chips 8 oz Bag", brand: "Lays" },
      { name: "Lays Classic Potato Chips 13 oz Bag", brand: "Lays" },
    )).toBe("sibling");
  });
});

// ---------------------------------------------------------------------------- brand compatibility
describe("identityRelation: brand compatibility gate", () => {
  test("clearly incompatible brands are unrelated even with high name overlap", () => {
    expect(identityRelation({ name: "Chips Ahoy Cookies", brand: "Nabisco" }, { name: "Chips Ahoy Cookies", brand: "Kroger" })).toBe("unrelated");
  });

  test("one brand name containing the other (multi-word corporate form) is compatible", () => {
    expect(identityRelation({ name: "Beef Chunks", brand: "Grabill" }, { name: "Grabill Country Meats Beef Chunks, 27 oz", brand: "Grabill Country Meats" })).not.toBe("unrelated");
  });

  test("case and whitespace differences in brand do not create a false conflict", () => {
    expect(identityRelation({ name: "Doritos Cool Ranch", brand: "  DORITOS " }, { name: "Doritos Cool Ranch", brand: "doritos" })).toBe("agree");
  });
});

// ---------------------------------------------------------------------------- detectSiblingAmbiguity contract
describe("detectSiblingAmbiguity: pairwise scan over the candidate list", () => {
  test("empty candidate list is never ambiguous", () => {
    expect(detectSiblingAmbiguity([])).toEqual({ ambiguous: false, reason: "" });
  });

  test("candidates with blank names are filtered out before pairwise comparison", () => {
    const v = detectSiblingAmbiguity([
      { name: "", brand: "X" },
      { name: "   ", brand: "Y" },
    ]);
    expect(v.ambiguous).toBe(false);
  });

  test("ANY sibling pair in a larger set poisons the whole set, even if most pairs agree", () => {
    const v = detectSiblingAmbiguity([
      { name: "Doritos Cool Ranch Tortilla Chips 9.25 oz", brand: "Doritos" },
      { name: "Doritos Cool Ranch Tortilla Chips 9.25oz", brand: "Doritos" }, // agrees with #1
      { name: "Doritos Cool Ranch Tortilla Chips 15.5 oz", brand: "Doritos" }, // sibling of #1/#2
    ]);
    expect(v.ambiguous).toBe(true);
  });

  test("unrelated (not sibling) pairs alone do not trip the sibling guard", () => {
    const v = detectSiblingAmbiguity([
      { name: "Member's Mark Purified Water", brand: "" },
      { name: "Charmin Ultra Soft Toilet Paper", brand: "" },
    ]);
    expect(v.ambiguous).toBe(false);
  });

  test("reason string names both conflicting product names when ambiguous", () => {
    const v = detectSiblingAmbiguity([
      { name: "Doritos Cool Ranch Tortilla Chips 9.25 oz", brand: "Doritos" },
      { name: "Doritos Nacho Cheese Tortilla Chips 9.25 oz", brand: "Doritos" },
    ]);
    expect(v.reason).toContain("Doritos Cool Ranch");
    expect(v.reason).toContain("Doritos Nacho Cheese");
  });
});
