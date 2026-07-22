import { describe, it, expect, beforeEach } from "vitest";
import { lookupPrefix, recordLearnedPrefix, clearLearnedPrefixes, setDerivedPrefixes, type PrefixEntry } from "@/services/catalog/prefixIndex";

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

  // F5 bundle-surgery (wave 2, 2026-07-20): the DERIVED_CATALOG tier (2.3MB derivedPrefixMap.json) no
  // longer loads into this CLIENT-SAFE module (see prefixIndexServer.test.ts for the full-index
  // coverage of this exact prefix, "0029700 -> idahoan"). This module's own DERIVED map stays an empty
  // {} in production; setDerivedPrefixes exists only as a test seam.
  it("the derived tier is empty by default (moved server-only; see prefixIndexServer.test.ts)", () => {
    expect(lookupPrefix("0029700016315")).toBeNull();
  });

  it("setDerivedPrefixes (test seam) can inject a derived entry without the 2.3MB file", () => {
    setDerivedPrefixes({
      "0029700": {
        prefix: "0029700",
        candidates: [{ name: "idahoan", kind: "manufacturer", productCount: 10, confidence: 0.9 }],
        dominant: { name: "idahoan", kind: "manufacturer", productCount: 10, confidence: 0.9 },
        productCount: 10, categoryDist: {}, countryHints: [], confidence: 0.9, ambiguity: 0.1, source: "derived_catalog",
      },
    });
    try {
      const e = lookupPrefix("0029700016315");
      expect(e).not.toBeNull();
      expect(e?.source).toBe("derived_catalog");
      expect(e?.dominant?.name.toLowerCase()).toContain("idahoan");
    } finally {
      setDerivedPrefixes({}); // never leak test state into other tests
    }
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

describe("self-learning flywheel (recordLearnedPrefix)", () => {
  beforeEach(() => clearLearnedPrefixes());

  it("learns a NEW prefix from a verified decode (fills a gap seed/derived don't cover)", () => {
    const code = "9999990000000"; // prefix 9999990 - not in seed or the OFF-derived map
    expect(lookupPrefix(code)).toBeNull(); // unknown before learning
    recordLearnedPrefix(code, "Test Brand", "test category");
    const e = lookupPrefix(code);
    expect(e?.source).toBe("learned_flywheel");
    expect(e?.dominant?.name).toBe("test brand");
  });

  it("accumulates repeated verified decodes (confidence reflects dominance)", () => {
    const code = "9999991000000";
    recordLearnedPrefix(code, "Acme", "snacks");
    recordLearnedPrefix(code, "Acme", "snacks");
    recordLearnedPrefix(code, "Other", "snacks");
    const e = lookupPrefix(code);
    expect(e?.dominant?.name).toBe("acme");
    expect(e?.confidence).toBeCloseTo(0.667, 1); // 2 of 3
    expect(e?.productCount).toBe(3);
  });

  it("NEVER overrides the curated seed (learned is lowest precedence)", () => {
    recordLearnedPrefix("051596320812", "Imposter Brand", "snacks"); // same prefix as United Solutions seed
    expect(lookupPrefix("051596320812")?.dominant?.name.toLowerCase()).toContain("united solutions");
  });
});
