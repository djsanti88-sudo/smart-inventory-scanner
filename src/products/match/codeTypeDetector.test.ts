import { describe, it, expect } from "vitest";
import { detectCodeType, codeTypeToAliasType, isVendorLabel } from "@/products/match/codeTypeDetector";

describe("detectCodeType", () => {
  it("detects UPC-A (12 digits)", () => {
    expect(detectCodeType("049000028904")).toBe("upc_a");
  });
  it("detects EAN/GTIN-13 (13 digits)", () => {
    expect(detectCodeType("6419440485331")).toBe("ean_13");
  });
  it("detects GTIN-14 (14 digits)", () => {
    expect(detectCodeType("00885911484047")).toBe("gtin_14");
  });
  it("detects short numeric internal codes", () => {
    expect(detectCodeType("7262")).toBe("numeric_sku");
  });
  it("detects alphanumeric SKUs", () => {
    expect(detectCodeType("T432119")).toBe("alpha_sku");
    expect(detectCodeType("DCF887B")).toBe("alpha_sku");
    expect(detectCodeType("2881-6861")).toBe("alpha_sku");
  });
  it("detects messy vendor strings", () => {
    expect(detectCodeType("T432119%RU1%")).toBe("messy");
  });
  it("detects empty input", () => {
    expect(detectCodeType("")).toBe("empty");
    expect(detectCodeType("   ")).toBe("empty");
  });
  it("detects Amazon FNSKU / ASIN vendor labels and does NOT call them SKUs/barcodes", () => {
    expect(detectCodeType("X004DY7YUT")).toBe("vendor_label");
    expect(detectCodeType("B07XYZ1234")).toBe("vendor_label");
    expect(isVendorLabel("X004DY7YUT")).toBe(true);
    expect(isVendorLabel("T432119")).toBe(false); // a real SKU is not a vendor label
    expect(isVendorLabel("6419440485331")).toBe(false); // a barcode is not a vendor label
  });
});

describe("codeTypeToAliasType", () => {
  it("maps barcodes and skus correctly", () => {
    expect(codeTypeToAliasType("upc_a")).toBe("barcode");
    expect(codeTypeToAliasType("ean_13")).toBe("barcode");
    expect(codeTypeToAliasType("alpha_sku")).toBe("sku");
    expect(codeTypeToAliasType("numeric_sku")).toBe("internal_code");
    expect(codeTypeToAliasType("messy")).toBe("messy_label");
  });
});
