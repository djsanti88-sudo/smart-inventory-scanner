// src/services/columnIntelligence.test.ts
import { describe, expect, it } from "vitest";
import {
  inferColumnMapping,
  normalizeImportHeader,
  validateManualMapping,
} from "@/services/columnIntelligence";

describe("columnIntelligence", () => {
  it("normalizes the boss-export header examples without fuzzy product matching", () => {
    expect(normalizeImportHeader("Part #")).toBe("part number");
    expect(normalizeImportHeader(" PN ")).toBe("pn");
    expect(normalizeImportHeader("Item No.")).toBe("item no");
    expect(normalizeImportHeader("Mfg Part Number")).toBe("mfg part number");
  });

  it("finds a header after blank and title rows and maps PN / Make / Model / Tire Size / QOH", () => {
    const result = inferColumnMapping([
      ["", "", "", "", ""],
      ["Inventory export", "", "", "", ""],
      ["PN", "Make", "Model", "Tire Size", "QOH"],
      ["ABC-1", "Acme", "Road", "225/45R18", "7"],
    ]);
    expect(result.headerRowIndex).toBe(2);
    expect(result.mapping).toEqual({
      partNumber: 0,
      brand: 1,
      model: 2,
      size: 3,
      quantity: 4,
    });
    expect(result.confidence).toBe("high");
    expect(result.source).toBe("header");
  });

  it("uses conservative content inference but keeps nonsense headers low confidence", () => {
    const result = inferColumnMapping([
      ["Alpha", "Beta", "Gamma"],
      ["012345678905", "225/45R18", "7"],
      ["036000291452", "235/45R18", "8"],
    ]);
    expect(result.mapping).toMatchObject({ barcode: 0, size: 1, quantity: 2 });
    expect(result.confidence).toBe("low");
    expect(result.source).toBe("content");
  });

  it("rejects duplicate manual assignments and requires identity plus quantity", () => {
    expect(validateManualMapping(["A", "B"], { partNumber: 0, quantity: 0 })).toEqual({
      ok: false,
      errors: ["One source column cannot be assigned to more than one field."],
    });
    expect(validateManualMapping(["A", "B"], { brand: 0, quantity: 1 })).toEqual({
      ok: false,
      errors: ["Map at least one identity field: part number, barcode, or name."],
    });
  });

  // --- New: fuzzy header text matching ---

  it("maps a foreign part-number header ('Mfr Code') to partNumber via fuzzy header text", () => {
    const result = inferColumnMapping([
      ["Mfr Code", "Make", "Tire Size", "Qty On Hand"],
      ["MT-2657017", "Acme", "225/45R18", "7"],
      ["DEF-LTX-01", "Acme", "235/45R18", "8"],
    ]);
    expect(result.mapping.partNumber).toBe(0);
    expect(result.tiers?.partNumber).toBe("high");
  });

  it("maps 'Item Description' to name via fuzzy header text", () => {
    const result = inferColumnMapping([
      ["SKU", "Item Description", "Qty"],
      ["ABC-1", "Acme Road Touring Tire", "7"],
      ["ABC-2", "Acme Highway Cruiser Tire", "8"],
    ]);
    expect(result.mapping.name).toBe(1);
    expect(result.mapping.partNumber).toBe(0);
  });

  it("also recognizes 'Vendor Item #' and 'Stock SKU' as partNumber via fuzzy header", () => {
    const vendor = inferColumnMapping([
      ["Vendor Item #", "Qty"],
      ["MT-2657017", "3"],
    ]);
    expect(vendor.mapping.partNumber).toBe(0);
    const stock = inferColumnMapping([
      ["Stock SKU", "Qty"],
      ["MT-2657017", "3"],
    ]);
    expect(stock.mapping.partNumber).toBe(0);
  });

  // --- New: content inference for partNumber and name ---

  it("infers a partNumber column from SKU-shaped values under a cryptic header", () => {
    const result = inferColumnMapping([
      ["Col7", "Zzz", "Qcol"],
      ["MT-2657017", "Acme Road Touring Tire", "7"],
      ["DEF-LTX-01", "Acme Highway Cruiser Tire", "8"],
      ["8291A", "Acme Winter Grip Tire", "5"],
    ]);
    expect(result.mapping.partNumber).toBe(0);
    expect(result.tiers?.partNumber).toBe("medium");
  });

  it("infers a name column from free-text values under a cryptic header", () => {
    const result = inferColumnMapping([
      ["Col7", "Zzz", "Qcol"],
      ["MT-2657017", "Acme Road Touring Tire", "7"],
      ["DEF-LTX-01", "Acme Highway Cruiser Tire", "8"],
      ["8291A", "Acme Winter Grip Tire", "5"],
    ]);
    expect(result.mapping.name).toBe(1);
    expect(result.tiers?.name).toBe("medium");
  });

  it("does not mis-infer a mixed column that lacks a strong majority", () => {
    // Column 0 is a jumble: no consistent shape reaches the >=70% majority for any field.
    const result = inferColumnMapping([
      ["Col1", "Qcol"],
      ["MT-2657017", "7"],
      ["a whole sentence of free text here", "8"],
      ["225/45R18", "5"],
      ["012345678905", "6"],
    ]);
    expect(result.mapping.partNumber).toBeUndefined();
    expect(result.mapping.name).toBeUndefined();
  });

  it("never maps two columns to the same field; the stronger signal wins", () => {
    // Both column 0 (exact header 'SKU') and column 1 (SKU-shaped values, cryptic header)
    // could look like partNumber; the exact-synonym header column must win, and column 1
    // must NOT also be assigned partNumber.
    const result = inferColumnMapping([
      ["SKU", "Col2", "Qty"],
      ["ABC-1", "MT-2657017", "7"],
      ["ABC-2", "DEF-LTX-01", "8"],
    ]);
    expect(result.mapping.partNumber).toBe(0);
    const assigned = Object.values(result.mapping).filter((v) => v !== undefined);
    expect(new Set(assigned).size).toBe(assigned.length);
  });

  it("tiers: exact synonym is HIGH auto, a single fuzzy-header signal is MEDIUM confirm", () => {
    const exact = inferColumnMapping([
      ["Part Number", "Qty"],
      ["ABC-1", "7"],
    ]);
    expect(exact.tiers?.partNumber).toBe("high");

    // 'Manufacturer Ref' is close to the partNumber synonym set by text (cue "ref") but not an exact
    // member, and its plain-word values are NOT SKU-shaped (no digit, no separator), so content does
    // not corroborate -> single (header-only) signal -> MEDIUM confirm.
    const fuzzy = inferColumnMapping([
      ["Manufacturer Ref", "Qty"],
      ["widget", "7"],
      ["gadget", "8"],
    ]);
    expect(fuzzy.mapping.partNumber).toBe(0);
    expect(fuzzy.tiers?.partNumber).toBe("medium");
  });
});
