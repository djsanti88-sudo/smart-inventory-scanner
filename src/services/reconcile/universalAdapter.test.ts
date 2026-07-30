import { describe, it, expect } from "vitest";
import { mapUniversalSheetToAdapterResult, extractUniversalUnitCosts } from "@/services/reconcile/universalAdapter";
import type { UniversalSheet } from "@/services/importSchema";

// Reconcile M3 (XLSX/TSV intake, H1): converts an already-parsed universal sheet (readUniversalFile
// + inferColumnMapping, both reused read-only from the Universal Import stack) into the SAME
// AdapterResult/ExpectedInventoryRow shape shopwareCsvAdapter.ts produces, so any spreadsheet a shop
// exports (CSV/TSV/XLSX/XLS) runs the compare-vs-counted loop, not just Shop-Ware's own CSV export.

function sheet(headers: string[], rows: string[][], headerRowIndex = 0): UniversalSheet {
  return {
    fileName: "test.xlsx",
    kind: "xlsx",
    headers,
    rows,
    headerRowIndex,
    sourceSignature: "sig",
  };
}

describe("mapUniversalSheetToAdapterResult", () => {
  it("maps a generic spreadsheet row into an ExpectedInventoryRow using the resolved mapping", () => {
    const s = sheet(
      ["Part Number", "Brand", "Model", "Size", "Quantity"],
      [["ABC-1", "Acme", "Road", "225/45R18", "7"]],
    );
    const result = mapUniversalSheetToAdapterResult(s, { partNumber: 0, brand: 1, model: 2, size: 3, quantity: 4 });
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row.externalId).toBe("ABC-1");
    expect(row.partNumbers).toEqual(["ABC-1"]);
    expect(row.brand).toBe("Acme");
    expect(row.model).toBe("Road");
    expect(row.sizeText).toBe("225/45R18");
    expect(row.qty).toBe(7);
  });

  it("falls back to barcode then name for identity when no part number column is mapped", () => {
    const s = sheet(["Name", "Barcode", "Quantity"], [["Widget", "012345678905", "3"]]);
    const result = mapUniversalSheetToAdapterResult(s, { name: 0, barcode: 1, quantity: 2 });
    expect(result.rows[0].externalId).toBe("012345678905");
    expect(result.rows[0].name).toBe("Widget");
  });

  it("routes a non-each UOM row to uomReview, not rows", () => {
    const s = sheet(
      ["Part Number", "Quantity", "Unit"],
      [["ABC-1", "3", "case"]],
    );
    const result = mapUniversalSheetToAdapterResult(s, { partNumber: 0, quantity: 1, uom: 2 });
    expect(result.rows).toHaveLength(0);
    expect(result.uomReview).toHaveLength(1);
    expect(result.uomReview[0].externalId).toBe("ABC-1");
  });

  it("routes a row with no identity or a blank quantity to unparseable, never throwing", () => {
    const s = sheet(
      ["Part Number", "Quantity"],
      [["", "3"], ["ABC-2", ""]],
    );
    const result = mapUniversalSheetToAdapterResult(s, { partNumber: 0, quantity: 1 });
    expect(result.rows).toHaveLength(0);
    expect(result.unparseable).toHaveLength(2);
  });

  it("adds an assumption when no unit column is mapped", () => {
    const s = sheet(["Part Number", "Quantity"], [["ABC-1", "3"]]);
    const result = mapUniversalSheetToAdapterResult(s, { partNumber: 0, quantity: 1 });
    expect(result.assumptions.some((a) => /each/i.test(a))).toBe(true);
  });

  it("drops any cost/price-shaped header from `raw` entirely, even when it is not mapped to a field", () => {
    const s = sheet(
      ["Part Number", "Quantity", "Cost", "Retail"],
      [["ABC-1", "3", "12.50", "19.99"]],
    );
    const result = mapUniversalSheetToAdapterResult(s, { partNumber: 0, quantity: 1 });
    const row = result.rows[0];
    expect(row.raw.Cost).toBeUndefined();
    expect(row.raw.Retail).toBeUndefined();
    expect(Object.keys(row.raw).some((k) => /cost|retail|price|msrp|margin/i.test(k))).toBe(false);
  });
});

describe("extractUniversalUnitCosts (opt-in, LOCAL-ONLY dollar variance)", () => {
  it("parses a recognized unit-cost column keyed by the same externalId the adapter assigns", () => {
    const s = sheet(
      ["Part Number", "Quantity", "Unit Cost"],
      [["ABC-1", "3", "$12.50"], ["ABC-2", "1", "8"]],
    );
    const unitCosts = extractUniversalUnitCosts(s, { partNumber: 0, quantity: 1 });
    expect(unitCosts["ABC-1"]).toBe(12.5);
    expect(unitCosts["ABC-2"]).toBe(8);
  });

  it("returns an empty map when no cost-shaped column is present", () => {
    const s = sheet(["Part Number", "Quantity"], [["ABC-1", "3"]]);
    expect(extractUniversalUnitCosts(s, { partNumber: 0, quantity: 1 })).toEqual({});
  });

  it("skips rows with no identity or an unparseable cost value", () => {
    const s = sheet(
      ["Part Number", "Quantity", "Unit Cost"],
      [["", "3", "5"], ["ABC-1", "3", "n/a"]],
    );
    expect(extractUniversalUnitCosts(s, { partNumber: 0, quantity: 1 })).toEqual({});
  });
});
