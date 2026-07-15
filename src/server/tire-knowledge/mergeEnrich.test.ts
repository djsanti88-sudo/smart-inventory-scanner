// src/server/tire-knowledge/mergeEnrich.test.ts
// Vitest node project. Imports the pure .mjs lib directly (same pattern as backfill.test.ts) -
// this is a build-time/offline maintenance lib, never used at request time.
//
// Task 2 (Phase 1 root-cause fix + AM-R2): cross_source_duplicate must field-level ENRICH the
// existing row (fill its blank fields from the guarded incoming row, part number first) instead
// of discarding the incoming row wholesale. Existing non-blank fields always win. Enrichment must
// NOT perturb the completeness-based duplicate resolution used elsewhere in this file.
import { describe, it, expect } from "vitest";
import { mergeRows } from "../../../scripts/dt-harvest/lib/merge.mjs";

// Explicit alias matching mergeRows' JSDoc @param/@returns shape (merge.mjs toCorpusRow/mergeRows) -
// typed fixtures, no @ts-nocheck, per the type-safety trap already caught on Task 1.
type CorpusRow = {
  barcode: string;
  brand: string;
  model: string;
  size: string;
  load_index: string;
  speed_rating: string;
  barcode_type: string;
  source: string;
  current_status: string;
  manufacturer_part_number: string;
  canonical_product_uid: string;
  part_number_source?: string;
};
type TireRow = {
  gtin: string;
  brand?: string;
  model?: string;
  size?: string;
  loadIndex?: string;
  speedRating?: string;
  partNumber?: string;
  imageUrl?: string;
  sourceUrl?: string;
  fetchedAt?: string;
  canonicalProductUid?: string;
};
type MergeSkip = { row: TireRow; reason: string };
type MergeResult = { merged: CorpusRow[]; added: number; skipped: MergeSkip[] };

// Valid GS1 check-digit fixtures reused from merge.test.mjs conventions.
const VALID_UPC = "848983006257"; // real corpus UPC (falken), valid mod-10 check digit

function tireRow(overrides: Partial<TireRow> = {}): TireRow {
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
    ...overrides,
  };
}

function corpusRow(overrides: Partial<CorpusRow> = {}): CorpusRow {
  return {
    barcode: VALID_UPC,
    brand: "falken",
    model: "wildpeak a t3w",
    size: "265/70R17",
    load_index: "115",
    speed_rating: "T",
    barcode_type: "upc",
    source: "some-other-source",
    current_status: "active_retail",
    manufacturer_part_number: "",
    canonical_product_uid: "falken_wildpeak_a_t3w_265_70r17_115_t_28034300",
    ...overrides,
  };
}

function run(existing: CorpusRow[], incoming: TireRow[]): MergeResult {
  return mergeRows(existing, incoming, {}) as MergeResult;
}

describe("mergeRows cross_source_duplicate field-level enrichment (Task 2 / AM-R2)", () => {
  it("fills a blank partNumber on the existing row from the guarded incoming row and tags provenance", () => {
    const existing = [corpusRow({ manufacturer_part_number: "" })];
    const incoming = [tireRow({ partNumber: "28034300" })];
    const { merged, skipped } = run(existing, incoming);

    expect(merged).toHaveLength(1);
    expect(merged[0].manufacturer_part_number).toBe("28034300");
    expect(merged[0].part_number_source).toBe("discounttire");
    // still a cross_source_duplicate in spirit (existing row from another source), enrichment
    // happens alongside the skip record so the incoming row is never counted as "added".
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toBe("cross_source_duplicate");
  });

  it("never overwrites a non-blank existing field, even when the incoming value differs", () => {
    const existing = [
      corpusRow({
        manufacturer_part_number: "EXISTING-PN",
        model: "existing model",
        load_index: "999",
        speed_rating: "Z",
      }),
    ];
    const incoming = [
      tireRow({
        partNumber: "INCOMING-PN",
        model: "incoming model",
        loadIndex: "111",
        speedRating: "H",
      }),
    ];
    const { merged } = run(existing, incoming);

    expect(merged[0].manufacturer_part_number).toBe("EXISTING-PN");
    expect(merged[0].model).toBe("existing model");
    expect(merged[0].load_index).toBe("999");
    expect(merged[0].speed_rating).toBe("Z");
    // no provenance tag: the field was never touched
    expect(merged[0].part_number_source).toBeUndefined();
  });

  it("cross-contamination regression guard: an unrelated row's enrichment tag never leaks into a DIFFERENT barcode's completeness contest", () => {
    // NOTE: this is a cross-contamination regression guard, not the AM-R2 flip proof. It puts the
    // enriched row and the completeness contest on two DIFFERENT barcodes, so part_number_source
    // never actually enters the fieldCompleteness() call being asserted below. It is kept because
    // it is still a valid (if weaker) regression guard against a completely different bug class
    // (state leaking across unrelated rows during a single mergeRows call). See the next test for
    // the real AM-R2 proof that a SAME-barcode completeness contest is immune to the tag.
    const BARCODE_2 = "036000291452"; // distinct valid UPC-A
    const existingEnrichable = corpusRow({ barcode: VALID_UPC, manufacturer_part_number: "" });
    const existingDiscountTireDup = corpusRow({
      barcode: BARCODE_2,
      source: "discounttire",
      model: "",
      load_index: "",
      speed_rating: "",
      manufacturer_part_number: "",
    });

    const incomingEnrichSource = tireRow({ gtin: VALID_UPC, partNumber: "28034300" });
    const incomingDiscountTireDup = tireRow({
      gtin: BARCODE_2,
      model: "",
      loadIndex: "",
      speedRating: "",
      partNumber: "",
    });

    const { merged } = run([existingEnrichable, existingDiscountTireDup], [
      incomingEnrichSource,
      incomingDiscountTireDup,
    ]);

    const enrichedRow = merged.find((r) => r.barcode === VALID_UPC)!;
    const dupRow = merged.find((r) => r.barcode === BARCODE_2)!;

    // Enrichment happened as expected (proves the enrichment path ran and added a field this test
    // depends on to detect a completeness leak).
    expect(enrichedRow.manufacturer_part_number).toBe("28034300");
    expect(enrichedRow.part_number_source).toBe("discounttire");

    // The unrelated discounttire-vs-discounttire duplicate decision is untouched by the other
    // row's enrichment: since both sides here are equally blank, existing (never overwritten by
    // an equally-or-less-complete incoming candidate) still wins, exactly as the "existing wins
    // when not more complete" rule specifies elsewhere in this file.
    expect(dupRow).toEqual(existingDiscountTireDup);
  });

  it("AM-R2: a SAME-barcode completeness contest is decided identically whether or not the existing row carries part_number_source", () => {
    // This is the real AM-R2 proof (the previous test above does NOT prove this property - it
    // never puts part_number_source and a fieldCompleteness() contest on the same barcode).
    //
    // Setup: the EXISTING row already carries part_number_source (as if a prior harvest run had
    // enriched it - simulated directly here since the enrichment path itself is a separate,
    // already-covered branch). It is discounttire-sourced and fully complete on every business
    // field EXCEPT manufacturer_part_number, which is blank. The INCOMING discounttire candidate
    // ties the existing row on every business field except it also FILLS manufacturer_part_number
    // - i.e. the incoming candidate is objectively more complete BY EXACTLY ONE business field.
    //
    // Business-field count (excluding part_number_source, which is provenance-only):
    //   existing = 10 non-blank business fields (missing only manufacturer_part_number)
    //   candidate = 11 non-blank business fields (has manufacturer_part_number too)
    // So the correct, spec-mandated rule (part_number_source excluded) must let candidate win:
    // candidate (11) > existing (10) -> existing is replaced, added === 1.
    //
    // If part_number_source were WRONGLY counted (the mutation the reviewer tested), existing
    // would count as 11 (10 business fields + the tag) and candidate would still count as 11
    // (11 business fields, no tag) - a TIE. Since mergeRows uses a strict `>` comparison, a tie
    // means candidate does NOT win, so existing survives as the "more or equally complete" row
    // and the incoming candidate is skipped as less_complete_duplicate instead. That is a genuine
    // flip of the decision, entirely caused by whether the provenance tag counts - exactly what
    // this test must catch.
    const existingWithTag = corpusRow({
      barcode: VALID_UPC,
      source: "discounttire",
      model: "wildpeak a t3w",
      load_index: "115",
      speed_rating: "T",
      manufacturer_part_number: "", // the one field the incoming candidate will beat it on
      part_number_source: "discounttire", // provenance tag from a prior enrichment
    });
    const tyingCandidate = tireRow({
      gtin: VALID_UPC,
      model: "wildpeak a t3w",
      loadIndex: "115",
      speedRating: "T",
      partNumber: "28034300", // fills the field existing is missing -> objectively more complete
      canonicalProductUid: "uid", // toCorpusRow blanks this unless set; keeps counts exact and honest
    });

    const { merged, added, skipped } = run([existingWithTag], [tyingCandidate]);

    // The tag must NOT have tipped the contest: candidate is genuinely more complete on business
    // fields alone and must win, exactly as it would if part_number_source did not exist at all.
    expect(added).toBe(1);
    expect(skipped).toEqual([]);
    expect(merged).toHaveLength(1);
    expect(merged[0].manufacturer_part_number).toBe("28034300");
    // The winning row is the fresh candidate (toCorpusRow never sets part_number_source), so the
    // provenance tag from the replaced existing row is correctly gone, not merely "not counted".
    expect(merged[0].part_number_source).toBeUndefined();
  });

  it("existing merge suite stays green (no regression in add / guard / same-source-completeness paths)", () => {
    // Sanity re-check of the two behaviors merge.test.mjs already locks in, run here too so this
    // file alone proves the root scenarios untouched by Task 2 still hold.
    const { merged: added, skipped: addSkip } = run([], [tireRow()]);
    expect(added).toHaveLength(1);
    expect(addSkip).toEqual([]);

    const richExisting = corpusRow({
      source: "discounttire",
      model: "wildpeak a t3w",
      load_index: "115",
      speed_rating: "T",
      manufacturer_part_number: "28034300",
    });
    const sparseIncoming = tireRow({ model: "", loadIndex: "", speedRating: "", partNumber: "" });
    const { merged: kept, skipped: keptSkip } = run([richExisting], [sparseIncoming]);
    expect(kept[0]).toEqual(richExisting);
    expect(keptSkip[0].reason).toBe("less_complete_duplicate");
  });
});
