import { describe, it, expect } from "vitest";
import { findIdentityMerge, type IdentityCandidate } from "./identityMerge";

// Task 9 identity-merge trust rules:
//  - auto_link ONLY on canonical-GTIN equality (across encodings, via canonicalGtin).
//  - suggest_link on normalized-brand equality + name token-Jaccard >= 0.75.
//  - plus-generation guard: tokens differing only by a trailing "+" (R8 vs R8+) NEVER auto-link -> suggest.
//  - TIRE rule: when BOTH sides carry a parsed size, auto_link additionally requires size equality;
//    disagreement forces suggest_link even with matching brand+model.

function prod(over: Partial<IdentityCandidate> & { id: string }): IdentityCandidate {
  return { gtin: "", upc: "", ean: "", primaryBarcode: "", brand: "", name: "", ...over };
}

describe("findIdentityMerge", () => {
  it("auto_links on the SAME GTIN across different encodings (UPC-A vs zero-padded EAN-13)", () => {
    const existing = [prod({ id: "p1", name: "Something", gtin: "036000291452" })];
    // Same product, EAN-13 zero-padded encoding of the same GTIN.
    const r = findIdentityMerge(existing, { gtin: "0036000291452", name: "Something Else" });
    expect(r).toEqual({ kind: "auto_link", productId: "p1" });
  });

  it("auto_links when the decoded code matches an existing primaryBarcode (canonical equality)", () => {
    const existing = [prod({ id: "p1", name: "Widget", primaryBarcode: "848983006257" })];
    const r = findIdentityMerge(existing, { upc: "0848983006257", name: "Widget" });
    expect(r).toEqual({ kind: "auto_link", productId: "p1" });
  });

  it("does NOT collapse a case-pack GTIN-14 (indicator >= 1) into the unit GTIN -> none", () => {
    // 10016000507255 is the CASE of unit 016000507255 - different countable products, never auto-link.
    const existing = [prod({ id: "unit", name: "Cereal", gtin: "016000507255" })];
    const r = findIdentityMerge(existing, { gtin: "10016000507255", name: "Cereal Case" });
    expect(r).toEqual({ kind: "none" });
  });

  it("suggest_links on same brand + high name similarity, but never auto (no GTIN)", () => {
    const existing = [prod({ id: "p1", brand: "Falken", name: "Wildpeak AT3W" })];
    const r = findIdentityMerge(existing, { brand: "falken", name: "Wildpeak AT3W" });
    expect(r).toEqual({ kind: "suggest_link", productId: "p1" });
  });

  it("PLUS-GENERATION trap: 'Dimax R8' vs 'Dimax R8+' -> suggest_link, NEVER auto", () => {
    const existing = [prod({ id: "p1", brand: "Achilles", name: "Dimax R8" })];
    const r = findIdentityMerge(existing, { brand: "Achilles", name: "Dimax R8+" });
    expect(r).toEqual({ kind: "suggest_link", productId: "p1" });
  });

  it("PLUS-GENERATION trap generalizes: 'HDR' vs 'HDR+' -> suggest_link, never auto", () => {
    const existing = [prod({ id: "p1", brand: "Landsail", name: "Sentury HDR" })];
    const r = findIdentityMerge(existing, { brand: "Landsail", name: "Sentury HDR+" });
    expect(r).toEqual({ kind: "suggest_link", productId: "p1" });
  });

  it("different brands -> none even when names overlap", () => {
    const existing = [prod({ id: "p1", brand: "Michelin", name: "Defender LTX" })];
    const r = findIdentityMerge(existing, { brand: "Cooper", name: "Defender LTX" });
    expect(r).toEqual({ kind: "none" });
  });

  it("TIRE rule: same brand+model+size -> suggest (no GTIN); matching size does not block it", () => {
    const existing = [prod({ id: "p1", brand: "Toyo", name: "Open Country AT3 265/70R17" })];
    const r = findIdentityMerge(existing, { brand: "Toyo", name: "Open Country AT3 265/70R17" });
    expect(r).toEqual({ kind: "suggest_link", productId: "p1" });
  });

  it("TIRE rule: GTIN equal BUT tire sizes disagree (265/70R17 vs 245/70R17) -> suggest, never auto", () => {
    const existing = [prod({ id: "p1", brand: "Toyo", name: "Open Country AT3 265/70R17", gtin: "036000291452" })];
    // Same GTIN (data anomaly) but a different size in the decoded identity: must downgrade to suggest.
    const r = findIdentityMerge(existing, { brand: "Toyo", name: "Open Country AT3 245/70R17", gtin: "036000291452" });
    expect(r).toEqual({ kind: "suggest_link", productId: "p1" });
  });

  it("TIRE rule: same GTIN AND same size -> auto_link", () => {
    const existing = [prod({ id: "p1", brand: "Toyo", name: "Open Country AT3 265/70R17", gtin: "036000291452" })];
    const r = findIdentityMerge(existing, { brand: "Toyo", name: "Open Country AT3 265/70R17", gtin: "0036000291452" });
    expect(r).toEqual({ kind: "auto_link", productId: "p1" });
  });

  it("returns none for an empty catalog", () => {
    expect(findIdentityMerge([], { gtin: "036000291452", name: "X" })).toEqual({ kind: "none" });
  });

  it("prefers auto_link (GTIN match) over a competing fuzzy suggestion on another row", () => {
    const existing = [
      prod({ id: "fuzzy", brand: "Toyo", name: "Open Country AT3" }),
      prod({ id: "exact", gtin: "036000291452", name: "Unrelated Name" }),
    ];
    const r = findIdentityMerge(existing, { gtin: "0036000291452", brand: "Toyo", name: "Open Country AT3" });
    expect(r).toEqual({ kind: "auto_link", productId: "exact" });
  });
});

describe("size-aware fuzzy merge (2026-07-10 same-model-different-size collapse)", () => {
  // Corpus products have SLUG names with no size; the size lives in specsShort ("245/70R16 107T").
  const existingSteadfast = {
    id: "p1",
    brand: "goodyear",
    name: "wrangler_steadfast_ht",
    specsShort: "265/45R20 105V",
    specsFull: "265/45R20 105V SL BSW",
  };

  it("same brand + identical slug name but DIFFERENT size -> none (mint a new product, no suggestion)", () => {
    const r = findIdentityMerge([existingSteadfast], {
      brand: "goodyear",
      name: "wrangler_steadfast_ht",
      specsShort: "255/55R20 110V",
    });
    expect(r.kind).toBe("none");
  });

  it("same brand + identical slug name and SAME size -> still suggest_link (possible real duplicate)", () => {
    const r = findIdentityMerge([existingSteadfast], {
      brand: "goodyear",
      name: "wrangler_steadfast_ht",
      specsShort: "265/45R20 105V",
    });
    expect(r).toEqual({ kind: "suggest_link", productId: "p1" });
  });

  it("size known on only ONE side -> unchanged: suggest_link (cannot prove distinct)", () => {
    const r = findIdentityMerge([existingSteadfast], {
      brand: "goodyear",
      name: "wrangler_steadfast_ht",
    });
    expect(r).toEqual({ kind: "suggest_link", productId: "p1" });
  });

  it("GTIN equality with size disagreement is unchanged: suggest_link, never auto", () => {
    const r = findIdentityMerge(
      [{ ...existingSteadfast, gtin: "0697662155102" }],
      { gtin: "697662155102", brand: "goodyear", name: "wrangler_steadfast_ht", specsShort: "255/55R20 110V" },
    );
    expect(r).toEqual({ kind: "suggest_link", productId: "p1" });
  });

  it("size in specsFull (not specsShort) also counts", () => {
    const r = findIdentityMerge(
      [{ id: "p2", brand: "michelin", name: "pilot_mxm4", specsFull: "P245/45R19 98V" }],
      { brand: "michelin", name: "pilot_mxm4", specsFull: "P235/45R18 94V" },
    );
    expect(r.kind).toBe("none");
  });

  it("size embedded in the NAME still works (pre-existing behavior preserved)", () => {
    const r = findIdentityMerge(
      [{ id: "p3", brand: "goodyear", name: "Eagle Touring 225/55R19 99V" }],
      { brand: "goodyear", name: "Eagle Touring 245/45R20 103V" },
    );
    expect(r.kind).toBe("none");
  });
});
