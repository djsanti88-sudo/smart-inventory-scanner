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
});
