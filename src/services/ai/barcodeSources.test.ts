import { describe, it, expect } from "vitest";
import { classifyGtin, selectBarcodeUrls, BARCODE_SOURCES } from "@/services/ai/barcodeSources";

describe("classifyGtin", () => {
  it("classifies 12-digit as US UPC", () => expect(classifyGtin("078742051451".slice(1))).toBe("upc_us"));
  it("classifies 13-digit starting 0 as US UPC", () => expect(classifyGtin("0078742051451".slice(0, 13))).toBe("upc_us"));
  it("classifies 13-digit non-0 prefix as international EAN", () => expect(classifyGtin("3017620422003")).toBe("ean_intl"));
  it("classifies 14-digit as GTIN-14", () => expect(classifyGtin("10019320009355")).toBe("gtin14"));
  it("classifies vendor-style codes as other", () => expect(classifyGtin("DCB205")).toBe("other"));
});

describe("selectBarcodeUrls", () => {
  it("caps at 8 URLs and dedupes", () => {
    const urls = selectBarcodeUrls("3017620422003");
    expect(urls.length).toBeLessThanOrEqual(8);
    expect(new Set(urls).size).toBe(urls.length);
  });
  it("prioritizes international sources for a foreign EAN", () => {
    const urls = selectBarcodeUrls("3017620422003").join(" ");
    expect(urls).toMatch(/ean-search\.org|opengtindb\.org|eandata\.com|openfoodfacts\.org/);
  });
  it("prioritizes US sources for a UPC-A", () => {
    const urls = selectBarcodeUrls("078742051451").join(" ");
    expect(urls).toMatch(/upcitemdb\.com|go-upc\.com|barcodelookup\.com/);
  });
  it("includes GTIN-14-aware sources for a case code", () => {
    const urls = selectBarcodeUrls("10019320009355").join(" ");
    expect(urls).toMatch(/go-upc\.com|upcitemdb\.com|openfoodfacts\.org/);
  });
  it("returns [] for empty code", () => expect(selectBarcodeUrls("")).toEqual([]));
  it("every source in the pool has a host and at least one tier", () => {
    for (const s of BARCODE_SOURCES) {
      expect(s.host.length).toBeGreaterThan(3);
      expect(s.tiers.length).toBeGreaterThan(0);
    }
  });
});
