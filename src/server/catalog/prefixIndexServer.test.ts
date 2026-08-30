import { describe, it, expect } from "vitest";
import { lookupPrefixFull, lookupDerivedPrefix, candidateKnownPrefixesFull, prefixFloorNameFull } from "@/server/catalog/prefixIndexServer";
import { detectCodeType } from "@/products/match/codeTypeDetector";

// F5 bundle-surgery (wave 2, 2026-07-20): the FULL prefix index (SEED + DERIVED_CATALOG + LEARNED) now
// lives server-only here. These are the DERIVED-tier assertions that used to live in the client-safe
// prefixIndex.test.ts / prefixFloor.test.ts before the 2.3MB derivedPrefixMap.json moved out of the
// client bundle - moved here verbatim (same anchors, same expectations) so full-index behavior stays
// covered with zero regression.

describe("prefixIndexServer (full merged index: SEED + DERIVED + LEARNED)", () => {
  it("loads the derived (OFF) map: a known food prefix resolves to its dominant brand", () => {
    const e = lookupPrefixFull("0029700016315"); // prefix 0029700 - recovered from OFF enrichment
    expect(e).not.toBeNull();
    expect(e?.source).toBe("derived_catalog");
    expect(e?.dominant?.name.toLowerCase()).toContain("idahoan");
  });

  it("lookupDerivedPrefix resolves the DERIVED tier directly (used by the /api/prefix-floor route)", () => {
    const e = lookupDerivedPrefix("0029700016315");
    expect(e).not.toBeNull();
    expect(e?.dominant?.name.toLowerCase()).toContain("idahoan");
  });

  it("SEED still wins over DERIVED for a seed-owned prefix (curated seed is authoritative)", () => {
    const e = lookupPrefixFull("051596320812"); // United Solutions, curated seed
    expect(e?.source).toBe("curated_seed");
    expect(e?.dominant?.name.toLowerCase()).toContain("united solutions");
  });
});

describe("prefixFloorNameFull (P5: family annotation, full index)", () => {
  // Anchors are REAL derived-tier prefixIndex entries (verified live, 2026-07-15): GS1 prefix 5603344
  // has dominant "general" (a member of the Continental family); prefix 8901036 has dominant
  // "continental" (the family leader). Both moved here from prefixFloor.test.ts since they require the
  // DERIVED tier, which is server-only after the bundle-surgery split.
  it("annotates the family leader when the floor brand is a family MEMBER", () => {
    const code = "5603344000016";
    const ct = detectCodeType(code);
    expect((lookupPrefixFull(code)?.dominant?.name ?? "").toLowerCase()).toContain("general");
    const floor = prefixFloorNameFull(code, ct);
    expect(floor).not.toBeNull();
    expect(floor!.brand).toBe("General");
    expect(floor!.familyLabel).toBe("Continental family");
    expect(floor!.name).toBe("General (Continental family) / product unconfirmed");
    expect(floor!.name).toMatch(/ \/ product unconfirmed$/);
  });

  it("keeps the plain floor name when the brand is a family LEADER (no annotation)", () => {
    const code = "8901036000007";
    const ct = detectCodeType(code);
    const floor = prefixFloorNameFull(code, ct);
    expect(floor).not.toBeNull();
    expect(floor!.brand).toBe("Continental");
    expect(floor!.familyLabel).toBeUndefined();
    expect(floor!.name).toBe("Continental / product unconfirmed");
  });

  it("returns null when the prefix has no confident dominant (caller keeps the Unidentified fallback)", () => {
    const code = "111000222333";
    const floor = prefixFloorNameFull(code, detectCodeType(code));
    expect(floor).toBeNull();
  });
});

describe("candidateKnownPrefixesFull", () => {
  it("includes a DERIVED-tier prefix for a brand known only in the derived map", () => {
    // Exact normalized-key match (same rule as the pre-split candidateKnownPrefixes): "idahoan" is an
    // exact candidate name under derived prefix 0297000 in the generated map (the 0029700 entry's
    // dominant is a longer variant name, so exact-match footprints resolve to 0297000).
    const prefixes = candidateKnownPrefixesFull("idahoan");
    expect(prefixes.length).toBeGreaterThan(0);
    expect(prefixes).toContain("0297000");
  });

  it("still includes SEED-tier prefixes (United Solutions)", () => {
    const prefixes = candidateKnownPrefixesFull("united solutions");
    expect(prefixes).toContain("0051596");
  });
});
