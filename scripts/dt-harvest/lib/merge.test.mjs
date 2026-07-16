import { describe, it, expect } from "vitest";
import { guardRow, mergeRows } from "./merge.mjs";

// Valid GS1 check digit fixtures (verified by mod-10 calculation):
// 848983006257 - real corpus UPC (falken) - valid
// 036000291452 - well-known valid UPC-A check digit
const VALID_UPC = "848983006257";
const INVALID_UPC = "848983006258"; // last digit tampered -> invalid check digit

function tireRow(overrides = {}) {
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

function corpusRow(overrides = {}) {
  return {
    barcode: VALID_UPC,
    brand: "falken",
    model: "wildpeak a t3w",
    size: "265/70R17",
    load_index: "115",
    speed_rating: "T",
    barcode_type: "upc",
    source: "existing-source",
    current_status: "active_retail",
    manufacturer_part_number: "28034300",
    canonical_product_uid: "falken_wildpeak_a_t3w_265_70r17_115_t_28034300",
    ...overrides,
  };
}

describe("guardRow", () => {
  it("accepts a row with a valid GS1 check digit and no prefix conflict", () => {
    const result = guardRow(tireRow(), {});
    expect(result).toEqual({ ok: true });
  });

  it("rejects a row with an invalid GS1 check digit", () => {
    const result = guardRow(tireRow({ gtin: INVALID_UPC }), {});
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_check_digit");
  });

  it("rejects a non-GTIN-shaped code as invalid check digit", () => {
    const result = guardRow(tireRow({ gtin: "not-a-barcode" }), {});
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_check_digit");
  });

  it("rejects when the barcode prefix maps to a conflicting brand", () => {
    const prefixMap = { [VALID_UPC.slice(0, 7)]: ["michelin"] };
    const result = guardRow(tireRow({ brand: "falken" }), prefixMap);
    expect(result).toEqual({ ok: false, reason: "prefix_conflict" });
  });

  it("accepts when the barcode prefix maps to the same brand", () => {
    const prefixMap = { [VALID_UPC.slice(0, 7)]: ["falken"] };
    const result = guardRow(tireRow({ brand: "falken" }), prefixMap);
    expect(result).toEqual({ ok: true });
  });

  it("accepts when the prefix is unmapped (unknown prefix never conflicts)", () => {
    const result = guardRow(tireRow(), { "9999999": ["someotherbrand"] });
    expect(result).toEqual({ ok: true });
  });

  it("is tolerant of brand casing/whitespace when comparing against the prefix map", () => {
    const prefixMap = { [VALID_UPC.slice(0, 7)]: ["Falken"] };
    const result = guardRow(tireRow({ brand: "  FALKEN  " }), prefixMap);
    expect(result).toEqual({ ok: true });
  });

  it("rejects an all-zeros GTIN as a placeholder barcode, not a valid check digit (AM-11.4)", () => {
    // "0000000000000" PASSES the GS1 mod-10 check digit (sum 0, check 0) - the placeholder
    // blocklist is the only thing that stops this junk value from entering the corpus.
    const result = guardRow(tireRow({ gtin: "0000000000000" }), {});
    expect(result).toEqual({ ok: false, reason: "placeholder_barcode" });
  });
});

describe("mergeRows", () => {
  it("adds a new row not present in the existing corpus", () => {
    const existing = [];
    const incoming = [tireRow()];
    const { merged, added, skipped } = mergeRows(existing, incoming, {});
    expect(added).toBe(1);
    expect(skipped).toEqual([]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      barcode: VALID_UPC,
      brand: "falken",
      model: "wildpeak a t3w",
      size: "265/70R17",
      load_index: "115",
      speed_rating: "T",
      barcode_type: "upc",
      source: "discounttire",
      current_status: "active_retail",
      manufacturer_part_number: "28034300",
    });
  });

  it("derives barcode_type from GTIN length: 12 -> upc, 13 -> ean, 14 -> gtin14", () => {
    const upc12 = "848983006257"; // 12 digits, valid check digit
    const ean13 = "5449000214911"; // 13 digits, valid check digit (Coca-Cola EAN sample)
    const gtin14 = "10012345678902"; // 14 digits, valid check digit

    const { merged: m12 } = mergeRows([], [tireRow({ gtin: upc12 })], {});
    expect(m12[0].barcode_type).toBe("upc");

    const { merged: m13 } = mergeRows([], [tireRow({ gtin: ean13 })], {});
    expect(m13[0].barcode_type).toBe("ean");

    const { merged: m14 } = mergeRows([], [tireRow({ gtin: gtin14 })], {});
    expect(m14[0].barcode_type).toBe("gtin14");
  });

  it("rejects rows that fail the poison guard and records the skip reason", () => {
    const incoming = [tireRow({ gtin: INVALID_UPC })];
    const { merged, added, skipped } = mergeRows([], incoming, {});
    expect(added).toBe(0);
    expect(merged).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toBe("invalid_check_digit");
    expect(skipped[0].row).toEqual(incoming[0]);
  });

  it("rejects rows that conflict with the prefix map and records prefix_conflict", () => {
    const prefixMap = { [VALID_UPC.slice(0, 7)]: ["michelin"] };
    const incoming = [tireRow({ brand: "falken" })];
    const { merged, added, skipped } = mergeRows([], incoming, prefixMap);
    expect(added).toBe(0);
    expect(merged).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toBe("prefix_conflict");
  });

  it("keeps the existing row when the same GTIN already exists from ANOTHER source, skip cross_source_duplicate", () => {
    const existing = [corpusRow({ source: "some-other-source", brand: "falken" })];
    const incoming = [tireRow({ brand: "falken" })];
    const { merged, added, skipped } = mergeRows(existing, incoming, {});
    expect(added).toBe(0);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual(existing[0]); // untouched, existing wins
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toBe("cross_source_duplicate");
    expect(skipped[0].row).toEqual(incoming[0]);
  });

  it("does NOT flag cross_source_duplicate when the existing row is already discounttire-sourced", () => {
    const existing = [corpusRow({ source: "discounttire", model: "old model" })];
    const incoming = [tireRow({ model: "wildpeak a t3w" })]; // more complete than existing's sparse row
    const { merged, added, skipped } = mergeRows(existing, incoming, {});
    // same-source duplicate goes through the completeness comparison, not cross_source_duplicate
    expect(skipped.some((s) => s.reason === "cross_source_duplicate")).toBe(false);
  });

  it("within discounttire source: higher field-completeness wins over existing discounttire row", () => {
    const sparseExisting = corpusRow({
      source: "discounttire",
      model: "",
      load_index: "",
      speed_rating: "",
      manufacturer_part_number: "",
    });
    const richIncoming = tireRow({
      model: "wildpeak a t3w",
      loadIndex: "115",
      speedRating: "T",
      partNumber: "28034300",
    });
    const { merged, added, skipped } = mergeRows([sparseExisting], [richIncoming], {});
    expect(added).toBe(1);
    expect(merged).toHaveLength(1);
    expect(merged[0].model).toBe("wildpeak a t3w");
    expect(merged[0].load_index).toBe("115");
    expect(skipped).toEqual([]);
  });

  it("within discounttire source: existing row wins and incoming is skipped when it is less complete", () => {
    const richExisting = corpusRow({
      source: "discounttire",
      model: "wildpeak a t3w",
      load_index: "115",
      speed_rating: "T",
      manufacturer_part_number: "28034300",
    });
    const sparseIncoming = tireRow({
      model: "",
      loadIndex: "",
      speedRating: "",
      partNumber: "",
    });
    const { merged, added, skipped } = mergeRows([richExisting], [sparseIncoming], {});
    expect(added).toBe(0);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual(richExisting);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toBe("less_complete_duplicate");
  });

  it("added rows always carry source discounttire and current_status active_retail", () => {
    const { merged } = mergeRows([], [tireRow()], {});
    expect(merged[0].source).toBe("discounttire");
    expect(merged[0].current_status).toBe("active_retail");
  });

  it("processes multiple incoming rows independently (mixed accept/reject)", () => {
    const existing = [];
    const incoming = [tireRow({ gtin: VALID_UPC }), tireRow({ gtin: INVALID_UPC, sourceUrl: "u2" })];
    const { merged, added, skipped } = mergeRows(existing, incoming, {});
    expect(added).toBe(1);
    expect(merged).toHaveLength(1);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toBe("invalid_check_digit");
  });

  it("does not mutate the existing or incoming arrays", () => {
    const existing = [corpusRow()];
    const incoming = [tireRow({ gtin: "111111111117" })]; // distinct valid-shaped code, will be checked for digit validity separately
    const existingCopy = JSON.parse(JSON.stringify(existing));
    const incomingCopy = JSON.parse(JSON.stringify(incoming));
    mergeRows(existing, incoming, {});
    expect(existing).toEqual(existingCopy);
    expect(incoming).toEqual(incomingCopy);
  });
});
