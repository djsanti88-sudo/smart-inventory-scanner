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
// family leader). Both are 7-digit prefixes padded to a 12-digit UPC-A-shaped code with any suffix.
describe("prefixFloorName (P5: family annotation)", () => {
  it("annotates the family leader when the floor brand is a family MEMBER", () => {
    const code = "5603344000017"; // prefix 5603344 -> dominant "general"
    const ct = detectCodeType(code);
    // Sanity: the anchor really does resolve to the family member we expect.
    expect((lookupPrefix(code)?.dominant?.name ?? "").toLowerCase()).toContain("general");
    const floor = prefixFloorName(code, ct);
    expect(floor).not.toBeNull();
    expect(floor!.brand).toBe("General");
    expect(floor!.familyLabel).toBe("Continental family");
    expect(floor!.name).toBe("General (Continental family) / product unconfirmed");
    expect(floor!.name).toMatch(/ \/ product unconfirmed$/);
  });

  it("keeps the plain floor name when the brand is a family LEADER (no annotation)", () => {
    const code = "8901036000009"; // prefix 8901036 -> dominant "continental" (leader)
    const ct = detectCodeType(code);
    const floor = prefixFloorName(code, ct);
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
