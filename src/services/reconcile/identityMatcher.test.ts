import { describe, it, expect } from "vitest";
import { matchExpectedRow, type CorpusCandidate, type MatcherDeps } from "./identityMatcher";
import type { ExpectedInventoryRow } from "./types";
import { IDENTITY_JACCARD_THRESHOLD } from "@/services/catalog/identityMerge";

// Task 5 (AM-R4/AM-R5, spec 2026-07-15-shopware-reconcile-pn-fill-design.md, matcher section):
// resolution order per row:
//   1. PN hit -> matched ONLY with brand corroboration (equal or sameBrandFamily) when the row has a
//      brand, AND size equality when both sides have a parseable size. Failed corroboration or multiple
//      corpus hits -> ambiguous. No brand + no size but a unique PN hit -> ambiguous (nothing corroborates).
//   2. Identity match: tireSizeToken exact + brand equal/family + jaccard >= 0.75 + plusGenerationDiff
//      guard -> matched iff exactly ONE candidate.
//   3. No parseable size, no tire signals -> non_tire.
//   4. Otherwise -> unmatched.
// Trust rule: wrong identity is FAILURE, unmatched/ambiguous is ACCEPTABLE. When in doubt, ambiguous.

function row(over: Partial<ExpectedInventoryRow> & { externalId: string; partNumbers: string[] }): ExpectedInventoryRow {
  return { qty: 1, raw: {}, ...over };
}

function candidate(over: Partial<CorpusCandidate> & { uid: string; brand: string; name: string }): CorpusCandidate {
  return { ...over };
}

function deps(over: Partial<MatcherDeps> = {}): MatcherDeps {
  return {
    lookupByPartNumber: () => [],
    candidatesByBrandSize: () => [],
    ...over,
  };
}

describe("matchExpectedRow", () => {
  it("reports exact PN confidence and the canonical token threshold", () => {
    const exact = matchExpectedRow(row({ externalId: "E-conf1", partNumbers: ["ABC-1"], brand: "Acme", sizeText: "225/45R18" }), {
      lookupByPartNumber: () => [{ uid: "a", brand: "Acme", name: "Road", sizeToken: "225/45R18" }],
      candidatesByBrandSize: () => [],
    });
    expect(exact.confidence).toBe(1);
    expect(exact.matchBasis).toBe("part_number_exact");

    // "Road Sport Elite Touring XL" vs "Road Sport Elite Touring": intersection 4 / union 5 = 0.8,
    // clearing IDENTITY_JACCARD_THRESHOLD (0.75) without tripping the plusGenerationDiff guard.
    const token = matchExpectedRow(row({ externalId: "E-conf2", partNumbers: ["MISS"], brand: "Acme", model: "Road Sport Elite Touring XL", sizeText: "225/45R18" }), {
      lookupByPartNumber: () => [],
      candidatesByBrandSize: () => [{ uid: "b", brand: "Acme", name: "Road Sport Elite Touring", sizeToken: "225/45R18" }],
    });
    expect(token.status).toBe("matched");
    expect(token.matchBasis).toBe("identity_jaccard");
    expect(token.confidence).toBeGreaterThanOrEqual(IDENTITY_JACCARD_THRESHOLD);
  });

  it("case 1: unique PN hit + brand equal + size equal -> matched", () => {
    const r = row({
      externalId: "E1",
      partNumbers: ["ABC123"],
      brand: "Michelin",
      sizeText: "245/65R17",
    });
    const cand = candidate({ uid: "u1", brand: "Michelin", name: "Defender LTX", sizeToken: "245/65R17", partNumber: "ABC123" });
    const d = deps({
      lookupByPartNumber: (pn) => (pn === "ABC123" ? [cand] : []),
    });
    const result = matchExpectedRow(r, d);
    expect(result.status).toBe("matched");
    expect(result.candidate).toEqual(cand);
    expect(result.reason).toBeTruthy();
  });

  it("case 2: PN hit with DIFFERENT brand (not same family) -> ambiguous, never matched (AM-R10a)", () => {
    const r = row({
      externalId: "E2",
      partNumbers: ["XYZ999"],
      brand: "Pirelli",
      sizeText: "245/65R17",
    });
    const cand = candidate({ uid: "u2", brand: "Bridgestone", name: "Turanza", sizeToken: "245/65R17", partNumber: "XYZ999" });
    const d = deps({
      lookupByPartNumber: (pn) => (pn === "XYZ999" ? [cand] : []),
    });
    const result = matchExpectedRow(r, d);
    expect(result.status).toBe("ambiguous");
    expect(result.candidate).toBeUndefined();
    expect(result.reason).toMatch(/brand/i);
  });

  it("case 3: PN hit, same brandFamilies family (Michelin/BFGoodrich) -> matched", () => {
    const r = row({
      externalId: "E3",
      partNumbers: ["FAM001"],
      brand: "BFGoodrich",
      sizeText: "265/70R17",
    });
    const cand = candidate({ uid: "u3", brand: "Michelin", name: "LTX A/T2", sizeToken: "265/70R17", partNumber: "FAM001" });
    const d = deps({
      lookupByPartNumber: (pn) => (pn === "FAM001" ? [cand] : []),
    });
    const result = matchExpectedRow(r, d);
    expect(result.status).toBe("matched");
    expect(result.candidate).toEqual(cand);
  });

  it("case 4: PN hit resolving to 2 corpus rows -> ambiguous with both candidates", () => {
    const r = row({
      externalId: "E4",
      partNumbers: ["DUP1"],
      brand: "Goodyear",
      sizeText: "225/55R18",
    });
    const cand1 = candidate({ uid: "u4a", brand: "Goodyear", name: "Assurance", sizeToken: "225/55R18", partNumber: "DUP1" });
    const cand2 = candidate({ uid: "u4b", brand: "Goodyear", name: "Eagle Sport", sizeToken: "225/55R18", partNumber: "DUP1" });
    const d = deps({
      lookupByPartNumber: (pn) => (pn === "DUP1" ? [cand1, cand2] : []),
    });
    const result = matchExpectedRow(r, d);
    expect(result.status).toBe("ambiguous");
    expect(result.candidates).toEqual([cand1, cand2]);
    expect(result.reason).toBeTruthy();
  });

  it("case 5: PN hit, sizes differ -> ambiguous", () => {
    const r = row({
      externalId: "E5",
      partNumbers: ["SZ1"],
      brand: "Continental",
      sizeText: "225/55R18",
    });
    const cand = candidate({ uid: "u5", brand: "Continental", name: "TrueContact", sizeToken: "245/65R17", partNumber: "SZ1" });
    const d = deps({
      lookupByPartNumber: (pn) => (pn === "SZ1" ? [cand] : []),
    });
    const result = matchExpectedRow(r, d);
    expect(result.status).toBe("ambiguous");
    expect(result.reason).toMatch(/size/i);
  });

  it("case 6: PN hit, row has no brand/size -> ambiguous (no corroboration)", () => {
    const r = row({
      externalId: "E6",
      partNumbers: ["NOBRAND1"],
    });
    const cand = candidate({ uid: "u6", brand: "Hankook", name: "Kinergy", partNumber: "NOBRAND1" });
    const d = deps({
      lookupByPartNumber: (pn) => (pn === "NOBRAND1" ? [cand] : []),
    });
    const result = matchExpectedRow(r, d);
    expect(result.status).toBe("ambiguous");
    expect(result.candidate).toBeUndefined();
    expect(result.reason).toBeTruthy();
  });

  it("PN hit, row has a size but no brand, and the corpus hit itself carries no size -> ambiguous (size never actually compared, so it does not count as corroboration)", () => {
    const r = row({
      externalId: "E6b",
      partNumbers: ["SIZEONLY1"],
      sizeText: "245/65R17",
      // deliberately no brand
    });
    const cand = candidate({ uid: "u6b", brand: "Hankook", name: "Kinergy", partNumber: "SIZEONLY1" }); // no sizeToken
    const d = deps({
      lookupByPartNumber: (pn) => (pn === "SIZEONLY1" ? [cand] : []),
    });
    const result = matchExpectedRow(r, d);
    expect(result.status).toBe("ambiguous");
    expect(result.candidate).toBeUndefined();
  });

  it("case 7: identity path: single size+family+jaccard candidate -> matched (no PN hit)", () => {
    const r = row({
      externalId: "E7",
      partNumbers: ["NOPNHIT"],
      brand: "Falken",
      model: "Wildpeak AT3W",
      sizeText: "265/70R17",
    });
    const cand = candidate({ uid: "u7", brand: "Falken", name: "Wildpeak AT3W", sizeToken: "265/70R17" });
    const d = deps({
      lookupByPartNumber: () => [],
      candidatesByBrandSize: (brand, sizeToken) => (brand === "Falken" && sizeToken === "265/70R17" ? [cand] : []),
    });
    const result = matchExpectedRow(r, d);
    expect(result.status).toBe("matched");
    expect(result.candidate).toEqual(cand);
  });

  it("case 8: identity path: R8 vs R8+ (plusGenerationDiff) -> not matched, isolated from the jaccard gate", () => {
    // Long, mostly-shared model names so raw jaccard over the two token sets is 7/9 = 0.778 (clears the
    // 0.75 threshold on its own) - the ONLY difference is the trailing "+" on one token ("r8" vs "r8+").
    // If plusGenerationDiff did not fire, this would incorrectly auto-match two different generations.
    const modelText = "Hakkapeliitta 10 Suv R8 Studded Winter Tire Model";
    const modelTextPlus = "Hakkapeliitta 10 Suv R8+ Studded Winter Tire Model";
    const r = row({
      externalId: "E8",
      partNumbers: ["NOPNHIT2"],
      brand: "Nokian",
      model: modelText,
      sizeText: "205/55R16",
    });
    const cand = candidate({ uid: "u8", brand: "Nokian", name: modelTextPlus, sizeToken: "205/55R16" });
    const d = deps({
      lookupByPartNumber: () => [],
      candidatesByBrandSize: (brand, sizeToken) => (brand === "Nokian" && sizeToken === "205/55R16" ? [cand] : []),
    });
    const result = matchExpectedRow(r, d);
    expect(result.status).not.toBe("matched");
    expect(result.reason).toBeTruthy();
  });

  it("case 9: identity path: two candidates -> ambiguous", () => {
    const r = row({
      externalId: "E9",
      partNumbers: ["NOPNHIT3"],
      brand: "Toyo",
      model: "Open Country AT3",
      sizeText: "265/70R16",
    });
    const cand1 = candidate({ uid: "u9a", brand: "Toyo", name: "Open Country AT3", sizeToken: "265/70R16" });
    const cand2 = candidate({ uid: "u9b", brand: "Toyo", name: "Open Country AT3 XL", sizeToken: "265/70R16" });
    const d = deps({
      lookupByPartNumber: () => [],
      candidatesByBrandSize: (brand, sizeToken) => (brand === "Toyo" && sizeToken === "265/70R16" ? [cand1, cand2] : []),
    });
    const result = matchExpectedRow(r, d);
    expect(result.status).toBe("ambiguous");
    expect(result.candidates).toEqual([cand1, cand2]);
  });

  it("case 10: no size, no tire signals -> non_tire", () => {
    const r = row({
      externalId: "E10",
      partNumbers: ["WIDGET1"],
      brand: "Acme",
      model: "Widget",
    });
    const d = deps({
      lookupByPartNumber: () => [],
      candidatesByBrandSize: () => [],
    });
    const result = matchExpectedRow(r, d);
    expect(result.status).toBe("non_tire");
    expect(result.reason).toBeTruthy();
  });

  it("case 11: every result has a non-empty reason (spot-check unmatched path)", () => {
    const r = row({
      externalId: "E11",
      partNumbers: ["NOHITATALL"],
      brand: "Yokohama",
      model: "Geolandar",
      sizeText: "275/60R20",
    });
    const d = deps({
      lookupByPartNumber: () => [],
      candidatesByBrandSize: () => [],
    });
    const result = matchExpectedRow(r, d);
    expect(result.status).toBe("unmatched");
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it("matched row with a corpus barcode emits a linkageSuggestion (AM-R6, data only)", () => {
    const r = row({
      externalId: "E12",
      partNumbers: ["LINK1"],
      brand: "Michelin",
      sizeText: "245/65R17",
    });
    const cand = candidate({ uid: "u12", brand: "Michelin", name: "Defender LTX", sizeToken: "245/65R17", partNumber: "LINK1", barcode: "0123456789012" });
    const d = deps({
      lookupByPartNumber: (pn) => (pn === "LINK1" ? [cand] : []),
    });
    const result = matchExpectedRow(r, d);
    expect(result.status).toBe("matched");
    expect(result.linkageSuggestion).toEqual({ barcode: "0123456789012", partNumber: "LINK1" });
  });

  it("normalizes part numbers (strip spaces/hyphens, uppercase) before lookup, mirroring normPartKey", () => {
    const r = row({
      externalId: "E13",
      partNumbers: ["abc-123 456"],
      brand: "Michelin",
      sizeText: "245/65R17",
    });
    const cand = candidate({ uid: "u13", brand: "Michelin", name: "Defender LTX", sizeToken: "245/65R17", partNumber: "ABC123456" });
    // "abc-123 456" also has a numeric-core shape (3-letter prefix + 6-digit core "123456"), so the
    // matcher's affix-core fan-out (Task A2) queries a second key. Record every key queried instead of
    // only the last, so this still proves the base key is normalized exactly like normPartKey.
    const receivedKeys: string[] = [];
    const d = deps({
      lookupByPartNumber: (pn) => {
        receivedKeys.push(pn);
        return pn === "ABC123456" ? [cand] : [];
      },
    });
    const result = matchExpectedRow(r, d);
    expect(receivedKeys).toContain("ABC123456");
    expect(result.status).toBe("matched");
  });

  it("affix core: row PN NX18773 discovers a corpus core-18773 candidate, tagged viaAffixCore, suggestion-only", () => {
    const r = row({ externalId: "E-affix", partNumbers: ["NX18773"], brand: "Nexen", sizeText: "265/70R17" });
    const cand = candidate({ uid: "u-core", brand: "Nexen", name: "Roadian ATX", sizeToken: "265/70R17", partNumber: "18773", barcode: "0000000001" });
    const d = deps({
      // dep is a direct keyed map: only the CORE key "18773" is present, not the raw "NX18773".
      lookupByPartNumber: (pn) => (pn === "18773" ? [cand] : []),
    });
    const result = matchExpectedRow(r, d);
    expect(result.status).toBe("matched"); // matched == a candidate to confirm, never an attach
    expect(result.viaAffixCore).toBe(true);
    expect(result.reason).toMatch(/affix core|confirm the exact product/i);
  });

  it("exact base PN hit is NOT flagged viaAffixCore", () => {
    const r = row({ externalId: "E-base", partNumbers: ["ABC123"], brand: "Michelin", sizeText: "245/65R17" });
    const cand = candidate({ uid: "u1", brand: "Michelin", name: "Defender LTX", sizeToken: "245/65R17", partNumber: "ABC123" });
    const d = deps({ lookupByPartNumber: (pn) => (pn === "ABC123" ? [cand] : []) });
    const result = matchExpectedRow(r, d);
    expect(result.status).toBe("matched");
    expect(result.viaAffixCore).toBeFalsy();
  });

  it("affix core hit with CONFLICTING size stays ambiguous (core alone is not trusted)", () => {
    const r = row({ externalId: "E-conf", partNumbers: ["15405N"], brand: "Nexen", sizeText: "205/75R15" });
    const cand = candidate({ uid: "u-x", brand: "Michelin", name: "Primacy", sizeToken: "225/55R17", partNumber: "15405" });
    const d = deps({ lookupByPartNumber: (pn) => (pn === "15405" ? [cand] : []) });
    const result = matchExpectedRow(r, d);
    expect(result.status).toBe("ambiguous");
    expect(result.candidate).toBeUndefined();
  });

  it("exposes a typo candidate as identity_fuzzy data only", () => {
    const result = matchExpectedRow(row({
      externalId: "E-fuzzy",
      partNumbers: [],
      brand: "Micheln",
      model: "Defendr T H",
      sizeText: "225-65-17",
    }), {
      lookupByPartNumber: () => [],
      candidatesByBrandSize: () => [],
      candidatesForFuzzy: () => [
        { uid: "one", brand: "Michelin", name: "Defender T H", sizeToken: "225/65R17" },
      ],
    });
    expect(result.status).toBe("matched");
    expect(result.matchBasis).toBe("identity_fuzzy");
    expect(result.confidence).toBeGreaterThanOrEqual(0.75);
  });
});
