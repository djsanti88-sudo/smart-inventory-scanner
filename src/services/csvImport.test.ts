import { describe, it, expect } from "vitest";
import { parseCsv, buildProductImport } from "@/services/csvImport";
import type { Alias, Product } from "@/types";

// Loop 5 proof (pure): CSV parsing + product/alias import plan with duplicate + conflict detection.

let n = 0;
const idFactory = () => `x${++n}`;
const now = () => "2026-06-15T10:00:00.000Z";
const build = (rows: Record<string, string>[], existingProducts: Product[] = [], existingAliases: Alias[] = []) =>
  buildProductImport({ rows, existingProducts, existingAliases, businessId: "biz-1", idFactory, now });

describe("parseCsv", () => {
  it("parses headers + rows, handling quotes, embedded commas, and CRLF", () => {
    const text = 'name,brand,notes\r\n"Widget, Deluxe","Acme","line one"\r\nGizmo,Beta,plain\r\n';
    const { headers, rows } = parseCsv(text);
    expect(headers).toEqual(["name", "brand", "notes"]);
    expect(rows).toHaveLength(2);
    expect(rows[0].name).toBe("Widget, Deluxe");
    expect(rows[0].brand).toBe("Acme");
    expect(rows[1].name).toBe("Gizmo");
  });

  it("handles escaped double-quotes and a missing trailing newline", () => {
    const text = 'name\n"He said ""hi"""';
    const { rows } = parseCsv(text);
    expect(rows[0].name).toBe('He said "hi"');
  });

  it("strips a UTF-8 BOM and skips blank lines", () => {
    const text = "﻿name\nA\n\nB\n";
    const { rows } = parseCsv(text);
    expect(rows.map((r) => r.name)).toEqual(["A", "B"]);
  });
});

describe("buildProductImport", () => {
  it("creates products + approved aliases from sku/barcode/gtin/upc/ean/vendor codes", () => {
    const rows = parseCsv(
      "name,sku,barcode,gtin,upc,ean,vendor_codes\nNokian Tire,T432119,6419440485331,,,,RU1|RU2\nCoke,,049000050103,,049000050103,,",
    ).rows;
    const plan = build(rows);
    expect(plan.products).toHaveLength(2);
    expect(plan.products[0].verified).toBe(true);
    expect(plan.products[0].source).toBe("manual");
    // Nokian: sku + barcode + 2 vendor codes = 4 aliases; Coke: barcode + upc (same code -> deduped to 1)
    const nokianAliases = plan.aliases.filter((a) => a.productId === plan.products[0].id);
    expect(nokianAliases.map((a) => a.cleanCode).sort()).toEqual(["6419440485331", "RU1", "RU2", "T432119"]);
    expect(nokianAliases.every((a) => a.approved)).toBe(true);
  });

  it("dedupes a code repeated within the same product (duplicate, not conflict)", () => {
    const rows = parseCsv("name,barcode,upc\nCoke,049000050103,049000050103").rows;
    const plan = build(rows);
    expect(plan.aliases.filter((a) => a.cleanCode === "049000050103")).toHaveLength(1);
    expect(plan.duplicates).toContain("049000050103");
    expect(plan.conflicts).toHaveLength(0);
  });

  it("flags a code that maps to two different products in the file as a conflict (not applied twice)", () => {
    const rows = parseCsv("name,barcode\nA,111222333\nB,111222333").rows;
    const plan = build(rows);
    expect(plan.aliases.filter((a) => a.cleanCode === "111222333")).toHaveLength(1); // applied once (product A)
    expect(plan.conflicts.some((c) => c.code === "111222333")).toBe(true);
  });

  it("does NOT reassign a code that already maps to an existing product (conflict, skipped)", () => {
    const existingAliases: Alias[] = [{
      id: "a-old", businessId: "biz-1", productId: "p-old", rawCodeExample: "999", cleanCode: "999",
      normalizedCode: "999", aliasType: "barcode", source: "human_review", confidence: 1, approved: true,
      createdAt: "t", updatedAt: "t", createdBy: "human", lastSeenAt: "t", syncStatus: "synced", idempotencyKey: "k",
    }];
    const rows = parseCsv("name,barcode\nClashing,999").rows;
    const plan = build(rows, [], existingAliases);
    expect(plan.aliases).toHaveLength(0);
    expect(plan.products).toHaveLength(0); // no usable new code -> no product created
    expect(plan.conflicts.some((c) => c.code === "999")).toBe(true);
  });

  it("reports a row with no scannable code as a conflict and skips it", () => {
    const rows = parseCsv("name,brand\nNo Codes Here,Acme").rows;
    const plan = build(rows);
    expect(plan.products).toHaveLength(0);
    expect(plan.conflicts.some((c) => /no scannable code/.test(c.reason))).toBe(true);
  });
});
