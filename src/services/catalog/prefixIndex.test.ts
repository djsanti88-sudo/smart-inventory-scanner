import { describe, it, expect } from "vitest";
import { lookupPrefix, type PrefixEntry } from "@/services/catalog/prefixIndex";

// The prefix index is MANY-TO-MANY and statistical, NOT official GS1 truth: one prefix can carry
// several candidate brand/manufacturer/OEM names with confidence weights, and the same owner can hold
// many prefixes. It feeds the anti-hallucination firewall as a weighted hint, never as identity truth.

describe("prefixIndex (curated seed, many-to-many)", () => {
  it("maps the bucket prefix 051596 -> United Solutions (manufacturer, housewares)", () => {
    const e = lookupPrefix("051596320812") as PrefixEntry;
    expect(e).not.toBeNull();
    expect(e.dominant?.name.toLowerCase()).toContain("united solutions");
    expect(e.dominant?.kind).toBe("manufacturer");
    expect(Object.keys(e.categoryDist).join(" ").toLowerCase()).toMatch(/housewares|bucket|storage/);
    expect(e.source).toBe("curated_seed");
    expect(e.confidence).toBeGreaterThan(0.5);
  });

  it("maps the fan prefix 792145 -> King of Fans, and carries MULTIPLE candidates (OEM + retail brand)", () => {
    const e = lookupPrefix("792145369783") as PrefixEntry;
    expect(e).not.toBeNull();
    expect(e.dominant?.name.toLowerCase()).toContain("king of fans");
    // many-to-many: the same prefix also lists the retail brand it manufactures for (Hampton Bay)
    expect(e.candidates.length).toBeGreaterThanOrEqual(2);
    expect(e.candidates.some((c) => c.name.toLowerCase().includes("hampton bay"))).toBe(true);
    expect(Object.keys(e.categoryDist).join(" ").toLowerCase()).toMatch(/fan|lighting/);
  });

  it("returns null for an unknown prefix (so non-cataloged products are unaffected)", () => {
    expect(lookupPrefix("000000000000")).toBeNull();
  });

  it("loads the derived (OFF) map: a known food prefix resolves to its dominant brand", () => {
    const e = lookupPrefix("0029700016315"); // prefix 0029700 - recovered from OFF enrichment
    expect(e).not.toBeNull();
    expect(e?.source).toBe("derived_catalog");
    expect(e?.dominant?.name.toLowerCase()).toContain("idahoan");
  });

  it("matches the SAME company for a UPC-12 and its GTIN-13 form (normalization)", () => {
    // OFF/derived keys are GTIN-13 normalized; a raw 12-digit UPC-A scan must still resolve.
    const upc12 = lookupPrefix("051596320812");
    const gtin13 = lookupPrefix("0051596320812");
    expect(upc12?.dominant?.name.toLowerCase()).toContain("united solutions");
    expect(gtin13?.dominant?.name.toLowerCase()).toContain("united solutions");
  });

  it("ignores non-digits and short codes", () => {
    expect(lookupPrefix("05-1596-320812")?.dominant?.name.toLowerCase()).toContain("united solutions");
    expect(lookupPrefix("123")).toBeNull();
  });
});
