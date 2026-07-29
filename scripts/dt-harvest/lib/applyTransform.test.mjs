import { describe, it, expect } from "vitest";
import { jsonlLinesToRows, toCorpusRow, barcodeTypeFor } from "./applyTransform.mjs";

function harvestedLine(overrides = {}) {
  return {
    gtin: "848983006257",
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

describe("jsonlLinesToRows", () => {
  it("parses well-formed JSONL lines with guard ok and a gtin", () => {
    const lines = [JSON.stringify(harvestedLine())];
    const rows = jsonlLinesToRows(lines);
    expect(rows).toHaveLength(1);
    expect(rows[0].gtin).toBe("848983006257");
  });

  it("skips blank lines without throwing", () => {
    const lines = ["", "   ", JSON.stringify(harvestedLine()), ""];
    const rows = jsonlLinesToRows(lines);
    expect(rows).toHaveLength(1);
  });

  it("skips lines that fail to parse as JSON without throwing", () => {
    const lines = ["{not json", JSON.stringify(harvestedLine())];
    expect(() => jsonlLinesToRows(lines)).not.toThrow();
    expect(jsonlLinesToRows(lines)).toHaveLength(1);
  });

  it("filters out lines whose guard is not ok", () => {
    const lines = [
      JSON.stringify(harvestedLine({ guard: "invalid_check_digit", gtin: "111111111117" })),
      JSON.stringify(harvestedLine({ guard: "prefix_conflict", gtin: "222222222224" })),
      JSON.stringify(harvestedLine()),
    ];
    const rows = jsonlLinesToRows(lines);
    expect(rows).toHaveLength(1);
    expect(rows[0].gtin).toBe("848983006257");
  });

  it("filters out lines with an empty or missing gtin", () => {
    const lines = [
      JSON.stringify(harvestedLine({ gtin: "" })),
      JSON.stringify({ ...harvestedLine(), gtin: undefined }),
      JSON.stringify(harvestedLine()),
    ];
    const rows = jsonlLinesToRows(lines);
    expect(rows).toHaveLength(1);
  });

  it("dedupes by gtin within the batch, keeping the more field-complete entry", () => {
    const sparse = harvestedLine({ model: "", loadIndex: "", speedRating: "", partNumber: "" });
    const rich = harvestedLine({ model: "wildpeak a t3w", loadIndex: "115", speedRating: "T", partNumber: "28034300" });
    const lines = [JSON.stringify(sparse), JSON.stringify(rich)];
    const rows = jsonlLinesToRows(lines);
    expect(rows).toHaveLength(1);
    expect(rows[0].model).toBe("wildpeak a t3w");
    expect(rows[0].loadIndex).toBe("115");
  });

  it("keeps the first-seen entry on a completeness tie", () => {
    const first = harvestedLine({ sourceUrl: "https://www.discounttire.com/first" });
    const second = harvestedLine({ sourceUrl: "https://www.discounttire.com/second" });
    const lines = [JSON.stringify(first), JSON.stringify(second)];
    const rows = jsonlLinesToRows(lines);
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceUrl).toBe("https://www.discounttire.com/first");
  });

  it("merges rows across multiple simulated worker files (rows concatenated before calling)", () => {
    const worker1 = [JSON.stringify(harvestedLine({ gtin: "848983006257" }))];
    const worker2 = [JSON.stringify(harvestedLine({ gtin: "848983007933", model: "rubitrek a t" }))];
    const rows = jsonlLinesToRows([...worker1, ...worker2]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.gtin).sort()).toEqual(["848983006257", "848983007933"]);
  });

  it("returns an empty array for empty input without throwing", () => {
    expect(jsonlLinesToRows([])).toEqual([]);
    expect(jsonlLinesToRows(undefined)).toEqual([]);
  });
});

describe("barcodeTypeFor", () => {
  it("maps 12 digits to upc", () => {
    expect(barcodeTypeFor("848983006257")).toBe("upc");
  });

  it("maps 13 digits to ean", () => {
    expect(barcodeTypeFor("5449000214911")).toBe("ean");
  });

  it("maps 14 digits to gtin14", () => {
    expect(barcodeTypeFor("10012345678902")).toBe("gtin14");
  });

  it("maps anything else to unknown", () => {
    expect(barcodeTypeFor("12345")).toBe("unknown");
    expect(barcodeTypeFor("")).toBe("unknown");
    expect(barcodeTypeFor(undefined)).toBe("unknown");
  });

  it("strips non-digit characters before measuring length", () => {
    expect(barcodeTypeFor("848-983-006257".replace(/-/g, ""))).toBe("upc");
    expect(barcodeTypeFor("8489 8300 6257")).toBe("upc");
  });
});

describe("toCorpusRow", () => {
  it("maps every TireRow field onto the real corpus row schema", () => {
    const row = toCorpusRow(harvestedLine());
    expect(row).toMatchObject({
      brand: "falken",
      brand_normalized: "falken",
      model: "wildpeak a t3w",
      model_normalized: "wildpeak a t3w",
      size: "265/70R17",
      raw_size_text: "265/70R17",
      load_index: "115",
      speed_rating: "T",
      manufacturer_part_number: "28034300",
      barcode: "848983006257",
      barcode_type: "upc",
      current_status: "active_retail",
      usable_for: "auto_count_candidate",
      source: "discounttire",
      source_count: 1,
    });
  });

  it("derives barcode_type from the gtin length", () => {
    expect(toCorpusRow(harvestedLine({ gtin: "5449000214911" })).barcode_type).toBe("ean");
    expect(toCorpusRow(harvestedLine({ gtin: "10012345678902" })).barcode_type).toBe("gtin14");
  });

  it("includes every real-schema column so a merged row is never missing a field", () => {
    const row = toCorpusRow(harvestedLine());
    const requiredColumns = [
      "canonical_product_uid", "brand", "brand_normalized", "model", "model_normalized",
      "size", "raw_size_text", "load_index", "speed_rating", "load_range", "type", "season",
      "manufacturer_part_number", "barcode", "barcode_type", "confidence", "current_status",
      "usable_for", "field_completeness_score", "missing_fields", "source_count",
    ];
    for (const col of requiredColumns) {
      expect(row).toHaveProperty(col);
    }
  });

  it("defaults missing optional fields to empty string rather than undefined", () => {
    const row = toCorpusRow({ gtin: "848983006257" });
    expect(row.model).toBe("");
    expect(row.load_index).toBe("");
    expect(row.speed_rating).toBe("");
    expect(row.manufacturer_part_number).toBe("");
  });

  it("does not mutate the input row", () => {
    const input = harvestedLine();
    const copy = JSON.parse(JSON.stringify(input));
    toCorpusRow(input);
    expect(input).toEqual(copy);
  });
});
