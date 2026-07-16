// src/server/tire-knowledge/backfill.test.ts
// Vitest node project. Imports the pure .mjs lib directly (no server-only import boundary here -
// this is a build-time/offline maintenance lib, never used at request time).
import { describe, it, expect } from "vitest";
import { applyBackfill } from "../../../scripts/dt-harvest/lib/backfill.mjs";

// Shared aliases matching applyBackfill's JSDoc @param/@returns shape (backfill.mjs lines 36-44).
// One clean alias reused everywhere instead of per-call casts.
type Corpus = { barcodeIndex: Record<string, Record<string, unknown>>; partNumberIndex: Record<string, string> };
type BackfillReport = {
  filled: number;
  agreed: number;
  conflicts: Array<{ barcode: string; corpusPn: string; dtPn: string; brand: string; model: string; size: string }>;
  guardRejected: number;
  junkKeysDropped: number;
  junkFillsNotIndexed: number;
  noCorpusRow: number;
};
type BackfillResult = { corpus: Corpus; report: BackfillReport };

// Valid GS1 check-digit fixtures (reused from scripts/dt-harvest/lib/merge.test.mjs conventions).
const VALID_UPC = "848983006257"; // falken wildpeak sample, valid mod-10 check digit
const VALID_UPC_2 = "036000291452"; // well-known valid UPC-A check digit
const INVALID_UPC = "848983006258"; // tampered last digit -> invalid check digit

function harvestRow(overrides: Record<string, unknown> = {}) {
  return {
    gtin: VALID_UPC,
    brand: "falken",
    model: "wildpeak a t3w",
    size: "265/70R17",
    loadIndex: "115",
    speedRating: "T",
    partNumber: "28034300",
    imageUrl: "https://www.discounttire.com/img.jpg",
    sourceUrl: "https://www.discounttire.com/tires/falken/wildpeak-p1",
    fetchedAt: "2026-07-08T00:00:00.000Z",
    guard: "ok",
    ...overrides,
  };
}

function corpusRow(overrides: Record<string, unknown> = {}) {
  return {
    canonical_product_uid: "falken_wildpeak_a_t3w_265_70r17_115_t_28034300",
    brand: "falken",
    brand_normalized: "falken",
    model: "wildpeak_a_t3w",
    model_normalized: "wildpeak a t3w",
    size: "265/70R17",
    raw_size_text: "265/70R17",
    load_index: "115",
    speed_rating: "T",
    load_range: "",
    type: "light_truck",
    season: "all_terrain_as",
    manufacturer_part_number: "",
    barcode: VALID_UPC,
    barcode_type: "upc",
    confidence: "verified_1src_strong",
    current_status: "active_retail",
    usable_for: "auto_count_candidate",
    field_completeness_score: "100",
    missing_fields: "",
    source_count: 0,
    ...overrides,
  };
}

function makeCorpus(rows: Record<string, unknown>[], partNumberIndex: Record<string, string> = {}): Corpus {
  const barcodeIndex: Record<string, Record<string, unknown>> = {};
  for (const row of rows) barcodeIndex[(row as { barcode: string }).barcode] = row;
  return { barcodeIndex, partNumberIndex };
}

describe("applyBackfill", () => {
  it("fills a blank PN and sets part_number_source", () => {
    const corpus = makeCorpus([corpusRow({ manufacturer_part_number: "" })]);
    const { corpus: result, report } = applyBackfill(corpus, [harvestRow()], { prefixMap: {} }) as BackfillResult;

    const row = result.barcodeIndex[VALID_UPC];
    expect(row.manufacturer_part_number).toBe("28034300");
    expect(row.part_number_source).toBe("discounttire");
    expect(report.filled).toBe(1);
  });

  it("never overwrites a non-blank PN (agree case counted in agreed)", () => {
    const corpus = makeCorpus([corpusRow({ manufacturer_part_number: "28034300" })]);
    const { corpus: result, report } = applyBackfill(corpus, [harvestRow({ partNumber: "28034300" })], { prefixMap: {} }) as BackfillResult;

    const row = result.barcodeIndex[VALID_UPC];
    expect(row.manufacturer_part_number).toBe("28034300");
    expect(row.part_number_source).toBeUndefined();
    expect(report.agreed).toBe(1);
    expect(report.filled).toBe(0);
  });

  it("emits a conflict with all five fields and leaves the corpus unchanged", () => {
    const existingRow = corpusRow({ manufacturer_part_number: "DIFFERENT-PN" });
    const corpus = makeCorpus([existingRow]);
    const { corpus: result, report } = applyBackfill(corpus, [harvestRow({ partNumber: "28034300" })], { prefixMap: {} }) as BackfillResult;

    expect(result.barcodeIndex[VALID_UPC]).toEqual(existingRow); // unchanged
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0]).toEqual({
      barcode: VALID_UPC,
      corpusPn: "DIFFERENT-PN",
      dtPn: "28034300",
      brand: "falken",
      model: "wildpeak a t3w",
      size: "265/70R17",
    });
  });

  it("skips a guard-rejected harvest row and counts it", () => {
    const corpus = makeCorpus([corpusRow({ manufacturer_part_number: "" })]);
    const { corpus: result, report } = applyBackfill(corpus, [harvestRow({ gtin: INVALID_UPC })], { prefixMap: {} }) as BackfillResult;

    expect(report.guardRejected).toBe(1);
    expect(report.filled).toBe(0);
    // untouched corpus row from the valid-gtin fixture is absent since we passed only the bad row
    expect(result.barcodeIndex[INVALID_UPC]).toBeUndefined();
  });

  it("forwards sameBrandFamily so a same-family prefix conflict FILLS instead of guard-rejecting", () => {
    // The Westlake recovery seam: prefix 8489830 is registered to a different brand ("registered"),
    // but the harvest row's brand ("sibling") is in the SAME family. Without the family fn this is a
    // prefix_conflict (guard-rejected); with it, the row is admitted and its blank PN is filled.
    const prefixMap = { [VALID_UPC.slice(0, 7)]: ["registered"] };
    const sameBrandFamily = (a: string, b: string) => {
      const fam = new Set(["registered", "sibling"]);
      const na = (a || "").toLowerCase();
      const nb = (b || "").toLowerCase();
      return na === nb || (fam.has(na) && fam.has(nb));
    };
    const corpus = makeCorpus([corpusRow({ manufacturer_part_number: "", brand: "sibling" })]);
    const siblingRow = harvestRow({ brand: "sibling" });

    // Without the family fn: the differing brand is a prefix conflict -> guard-rejected, no fill.
    const rejected = applyBackfill(corpus, [siblingRow], { prefixMap }) as BackfillResult;
    expect(rejected.report.guardRejected).toBe(1);
    expect(rejected.report.filled).toBe(0);

    // With the family fn: same family clears the conflict -> the blank PN is filled.
    const recovered = applyBackfill(corpus, [siblingRow], { prefixMap, sameBrandFamily }) as BackfillResult;
    expect(recovered.report.guardRejected).toBe(0);
    expect(recovered.report.filled).toBe(1);
    expect(recovered.corpus.barcodeIndex[VALID_UPC].manufacturer_part_number).toBe("28034300");
    expect(recovered.corpus.barcodeIndex[VALID_UPC].part_number_source).toBe("discounttire");
  });

  it("fills the row but never indexes a normPartKey with length <= 4 (AM-R1)", () => {
    const corpus = makeCorpus([corpusRow({ manufacturer_part_number: "" })]);
    const { corpus: result, report } = applyBackfill(corpus, [harvestRow({ partNumber: "AB12" })], { prefixMap: {} }) as BackfillResult;

    const row = result.barcodeIndex[VALID_UPC];
    expect(row.manufacturer_part_number).toBe("AB12");
    expect(row.part_number_source).toBe("discounttire");
    expect(report.filled).toBe(1);
    expect(report.junkFillsNotIndexed).toBe(1);
    expect(Object.values(result.partNumberIndex)).not.toContain(row.canonical_product_uid);
  });

  it("drops pre-existing junk index keys (normalized length <= 4)", () => {
    const corpus = makeCorpus(
      [corpusRow({ manufacturer_part_number: "9999", canonical_product_uid: "junk-uid" })],
      { "9999": "junk-uid", "LONGKEY123": "some-other-uid" }
    );
    const { corpus: result, report } = applyBackfill(corpus, [], { prefixMap: {} }) as BackfillResult;

    expect(result.partNumberIndex["9999"]).toBeUndefined();
    expect(result.partNumberIndex["LONGKEY123"]).toBe("some-other-uid");
    expect(report.junkKeysDropped).toBe(1);
  });

  it("is idempotent: applying twice yields deep-equal corpus and zero new fills", () => {
    const corpus = makeCorpus([corpusRow({ manufacturer_part_number: "" })]);
    const first = applyBackfill(corpus, [harvestRow()], { prefixMap: {} }) as BackfillResult;
    const second = applyBackfill(first.corpus, [harvestRow()], { prefixMap: {} }) as BackfillResult;

    expect(second.corpus).toEqual(first.corpus);
    expect(second.report.filled).toBe(0);
  });

  it("counts a harvest gtin missing from the corpus as noCorpusRow and adds nothing", () => {
    const corpus = makeCorpus([]);
    const { corpus: result, report } = applyBackfill(corpus, [harvestRow()], { prefixMap: {} }) as BackfillResult;

    expect(report.noCorpusRow).toBe(1);
    expect(Object.keys(result.barcodeIndex)).toHaveLength(0);
  });

  it("dedupes harvest rows by gtin, later rows winning", () => {
    const corpus = makeCorpus([corpusRow({ manufacturer_part_number: "" })]);
    const { corpus: result, report } = applyBackfill(
      corpus,
      [harvestRow({ partNumber: "OLDPN0001" }), harvestRow({ partNumber: "NEWPN0002" })],
      { prefixMap: {} }
    ) as BackfillResult;

    expect(result.barcodeIndex[VALID_UPC].manufacturer_part_number).toBe("NEWPN0002");
    expect(report.filled).toBe(1);
  });

  it("processes multiple independent rows and totals report counts correctly", () => {
    const corpus = makeCorpus([
      corpusRow({ manufacturer_part_number: "" }),
      corpusRow({ barcode: VALID_UPC_2, canonical_product_uid: "other-uid", manufacturer_part_number: "EXISTING-PN" }),
    ]);
    const { report } = applyBackfill(
      corpus,
      [harvestRow({ gtin: VALID_UPC, partNumber: "NEWFILL01" }), harvestRow({ gtin: VALID_UPC_2, partNumber: "CONFLICTPN" })],
      { prefixMap: {} }
    ) as BackfillResult;

    expect(report.filled).toBe(1);
    expect(report.conflicts).toHaveLength(1);
  });
});
