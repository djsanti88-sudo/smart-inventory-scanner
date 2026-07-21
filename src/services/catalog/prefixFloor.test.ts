import { describe, it, expect } from "vitest";
import { prefixFloorName } from "@/services/catalog/prefixFloor";
import { detectCodeType } from "@/services/codeTypeDetector";
import { lookupPrefix } from "@/services/catalog/prefixIndex";

// P5 (Task 8): the prefix floor names an unresolved scan "<Brand> / product unconfirmed" from the GS1
// company prefix. When the resolved brand is a MEMBER of a curated corporate family (brandFamilies),
// the name gains a "(<Leader> family)" annotation so the row reads e.g.
// "General (Continental family) / product unconfirmed". A family LEADER (or an independent brand)
// keeps the plain "<Brand> / product unconfirmed" form. The PRODUCT stays explicitly unconfirmed and
// NO specific product/model is ever fabricated from the prefix alone.
//
// Anchors are REAL prefixIndex entries (verified live, 2026-07-15): GS1 prefix 5603344 has dominant
// "general" (a member of the Continental family); prefix 8901036 has dominant "continental" (the
// family leader). Both are 7-digit prefixes on a 13-digit EAN-13 with a VALID GS1 check digit (a real
// scanned code from that prefix would have one; QA round-2's misread guard now suppresses the floor for
// bad-check-digit GTINs, so these anchors must be genuinely valid to exercise the floor path).
describe("prefixFloorName (P5: family annotation)", () => {
  // F5 bundle-surgery (wave 2, 2026-07-20): the 5603344/"General (Continental family)" and
  // 8901036/"Continental" anchors are DERIVED-tier entries, and the 2.3MB derivedPrefixMap.json is
  // now SERVER-ONLY (never in the /scan client bundle). Those two full-index family tests moved
  // VERBATIM to src/server/catalog/prefixIndexServer.test.ts (prefixFloorNameFull). Client-side, the
  // same code honestly returns null (row keeps the safe "Unidentified item" fallback until the async
  // /api/prefix-floor enrichment upgrades it), and the family-annotation COMPOSITION logic is proven
  // here via the injectable lookupFn seam with a synthetic derived-tier entry.
  it("a DERIVED-tier-only prefix now returns null client-side (enrichment happens via /api/prefix-floor)", () => {
    const code = "5603344000016"; // derived-tier "general" - not in the client-safe SEED/LEARNED tiers
    expect(lookupPrefix(code)).toBeNull();
    expect(prefixFloorName(code, detectCodeType(code))).toBeNull();
  });

  it("annotates the corporate family when the injected lookup resolves a family MEMBER (composition logic)", () => {
    const code = "5603344000016";
    const ct = detectCodeType(code);
    const floor = prefixFloorName(code, ct, () => ({
      prefix: "5603344",
      candidates: [{ name: "general", kind: "manufacturer", productCount: 10, confidence: 0.9 }],
      dominant: { name: "general", kind: "manufacturer", productCount: 10, confidence: 0.9 },
      productCount: 10, categoryDist: {}, countryHints: [], confidence: 0.9, ambiguity: 0.1, source: "derived_catalog",
    }));
    expect(floor).not.toBeNull();
    expect(floor!.brand).toBe("General");
    expect(floor!.familyLabel).toBe("Continental family");
    expect(floor!.name).toBe("General (Continental family) / product unconfirmed");
    expect(floor!.name).toMatch(/ \/ product unconfirmed$/);
  });

  it("keeps the plain floor name when the injected lookup resolves a family LEADER (no annotation)", () => {
    const code = "8901036000007";
    const ct = detectCodeType(code);
    const floor = prefixFloorName(code, ct, () => ({
      prefix: "8901036",
      candidates: [{ name: "continental", kind: "manufacturer", productCount: 10, confidence: 0.9 }],
      dominant: { name: "continental", kind: "manufacturer", productCount: 10, confidence: 0.9 },
      productCount: 10, categoryDist: {}, countryHints: [], confidence: 0.9, ambiguity: 0.1, source: "derived_catalog",
    }));
    expect(floor).not.toBeNull();
    expect(floor!.brand).toBe("Continental");
    expect(floor!.familyLabel).toBeUndefined();
    expect(floor!.name).toBe("Continental / product unconfirmed");
  });

  it("returns null when the prefix has no confident dominant (caller keeps the Unidentified fallback)", () => {
    const code = "111000222333"; // no dominant in the prefix index
    const floor = prefixFloorName(code, detectCodeType(code));
    expect(floor).toBeNull();
  });
});

// QA ROUND-2 SEAM 3 (live-proven bypass, 2026-07-16): the prefix floor resolved a brand from the GS1
// company prefix with NO misread/example awareness, so a scanner-misread GTIN (bad GS1 check digit) or
// a textbook GS1 EXAMPLE barcode still got a confident fabricated brand ("Healthyholics / product
// unconfirmed"). Wrong identity is FAILURE; unknown is acceptable. The floor must give NO name to a
// misread/example code on ANY surface, while a LEGITIMATE code with a real prefix is untouched.
describe("prefixFloorName (QA round-2: no fabricated brand for misread/example codes)", () => {
  it("returns null for a scanner-misread GTIN (bad GS1 check digit) that shares a real brand prefix", () => {
    // 012345678900 is UPC-A-shaped, its prefix 012345 maps to the "Healthyholics" example brand, but
    // its GS1 check digit is INVALID -> a likely scanner misread. It must get no floor name.
    const code = "012345678900";
    expect(prefixFloorName(code, detectCodeType(code))).toBeNull();
  });

  it("returns null for a textbook GS1 EXAMPLE barcode even with a valid check digit and a real prefix", () => {
    // 0012345670121 is a documented Healthyholics EXAMPLE GTIN (valid check digit, on the blocklist).
    const code = "0012345670121";
    expect(prefixFloorName(code, detectCodeType(code))).toBeNull();
  });

  it("REGRESSION: a legitimate code with a real prefix still gets its floor name", () => {
    // 051596000004 is a valid UPC-A (mod-10 check digit passes), prefix -> United Solutions, and is
    // neither a misread nor an example - it must keep its confident floor brand.
    const code = "051596000004";
    const floor = prefixFloorName(code, detectCodeType(code));
    expect(floor).not.toBeNull();
    expect(floor!.brand).toBe("United Solutions");
    expect(floor!.name).toBe("United Solutions / product unconfirmed");
  });
});
