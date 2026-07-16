import { describe, it, expect } from "vitest";
import { buildProductImport } from "./csvImport";

const base = {
  existingProducts: [],
  existingAliases: [],
  businessId: "biz-1",
  now: () => "2026-07-15T00:00:00.000Z",
};
function idFactoryFrom(seed = 0) {
  let n = seed;
  return () => String(++n);
}

describe("CSV import trust gate (the csvImport back door, AM-4.1)", () => {
  it("drops a bad-check-digit gtin: no alias, field blanked, honest conflict", () => {
    const out = buildProductImport({
      ...base,
      idFactory: idFactoryFrom(),
      rows: [{ name: "Fake Tire", gtin: "8848111201762" }], // valid shape, WRONG check digit
    });
    expect(out.products).toHaveLength(0); // only code was rejected -> no product
    expect(out.aliases).toHaveLength(0);
    expect(out.conflicts.some((c) => c.reason.startsWith("barcode rejected:"))).toBe(true);
  });

  it("drops a placeholder barcode (0000000000000) the same way", () => {
    const out = buildProductImport({
      ...base,
      idFactory: idFactoryFrom(),
      rows: [{ name: "Junk", barcode: "0000000000000" }],
    });
    expect(out.aliases).toHaveLength(0);
    expect(out.conflicts.some((c) => c.reason.startsWith("barcode rejected:"))).toBe(true);
  });

  it("keeps a VALID barcode exactly as before (regression: 6959655468007 imports cleanly)", () => {
    const out = buildProductImport({
      ...base,
      idFactory: idFactoryFrom(),
      rows: [{ name: "Blackhawk Street-H HH11", sku: "5546800V", upc: "6959655468007" }],
    });
    expect(out.products).toHaveLength(1);
    expect(out.products[0].upc).toBe("6959655468007");
    // sku + upc both become aliases, as today
    expect(out.aliases.map((a) => a.cleanCode).sort()).toEqual(["5546800V", "6959655468007"].sort());
    expect(out.conflicts).toHaveLength(0);
  });

  it("does NOT grade sku/vendor codes (non-barcode columns are out of the gate's jurisdiction)", () => {
    const out = buildProductImport({
      ...base,
      idFactory: idFactoryFrom(),
      rows: [{ name: "Vendor thing", sku: "X0012ABCDE", vendor_codes: "V-99|K-77" }],
    });
    expect(out.products).toHaveLength(1);
    expect(out.aliases).toHaveLength(3);
    expect(out.conflicts).toHaveLength(0);
  });

  it("keeps a non-GTIN primary_barcode as a vendor-typed alias (physical labels may be code128)", () => {
    const out = buildProductImport({
      ...base,
      idFactory: idFactoryFrom(),
      rows: [{ name: "Shop-labeled", barcode: "SHOP-TAG-0042" }],
    });
    expect(out.products).toHaveLength(1);
    expect(out.aliases).toHaveLength(1);
  });

  it("a bad gtin does not kill the row when another code is valid - field blanked, rest imports", () => {
    const out = buildProductImport({
      ...base,
      idFactory: idFactoryFrom(),
      rows: [{ name: "Half-good", gtin: "8848111201762", upc: "6959655468007" }],
    });
    expect(out.products).toHaveLength(1);
    expect(out.products[0].gtin).toBe(""); // rejected field blanked, never stored as identity
    expect(out.products[0].upc).toBe("6959655468007");
    expect(out.conflicts.some((c) => c.reason.startsWith("barcode rejected:"))).toBe(true);
  });

  it("a row with an empty gtin and a valid upc produces zero barcode-rejected conflicts (audit finding M2)", () => {
    const out = buildProductImport({
      ...base,
      idFactory: idFactoryFrom(),
      rows: [{ name: "X", gtin: "", upc: "6959655468007" }],
    });
    expect(out.conflicts.filter((c) => c.reason.startsWith("barcode rejected:"))).toHaveLength(0);
  });
});
