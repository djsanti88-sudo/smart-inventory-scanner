import { describe, it, expect } from "vitest";
import { parseCsv, buildInteractiveHtml, escapeHtml } from "@/reports/export/exportFormats";
import { buildCsv, exportFinalCounts } from "@/reports/export/csvExport";
import type { InventoryCount, Product } from "@/types";

// The multi-format layer derives XLSX/PDF/HTML from the CSV the verified builders already produce. These
// tests prove the CSV round-trips losslessly (so every format sees the SAME sanitized data) and that the
// interactive HTML escapes untrusted values.

describe("exportFormats - CSV round-trip", () => {
  it("parses a buildCsv string back into the exact headers + rows", () => {
    const headers = ["a", "b", "c"];
    const rows = [
      ["plain", "has,comma", 'has"quote'],
      ["new\nline", "trailing ", "029142712886"],
    ];
    const parsed = parseCsv(buildCsv(headers, rows));
    expect(parsed.headers).toEqual(headers);
    expect(parsed.rows).toEqual(rows.map((r) => r.map(String)));
  });

  it("strips the leading-apostrophe CSV-injection guard for display formats", () => {
    // A product name starting with '=' gets a guard apostrophe in CSV; display formats should not show it.
    const parsed = parseCsv(buildCsv(["name"], [["=SUM(A1)"]]));
    expect(parsed.rows[0][0]).toBe("=SUM(A1)");
  });

  it("round-trips a real final-counts export with codes intact (long barcode stays exact text)", () => {
    const products: Product[] = [{
      id: "p1", businessId: "b", name: "Cooper Discoverer", brand: "Cooper", category: "Tire", specsShort: "LT245/75R16",
      specsFull: "", primarySku: "", primaryBarcode: "029142712886", gtin: "", upc: "029142712886", ean: "", vendorCodes: [],
      aliases: [], imageUrl: "", productUrl: "", location: "Bay A", notes: "", status: "active", source: "manual",
      confidence: 1, verified: true, createdAt: "t", updatedAt: "t", createdBy: "x", updatedBy: "x",
    }];
    const counts: InventoryCount[] = [{
      id: "c1", businessId: "b", sessionId: "s", productId: "p1", quantity: 3, lastScannedAt: "t", aliasesSeen: ["029142712886"],
      scanEventIds: ["e1"], createdAt: "t", updatedAt: "t", syncStatus: "synced", syncError: null, appliedIdempotencyKeys: [],
    }];
    const parsed = parseCsv(exportFinalCounts(counts, products, "s"));
    expect(parsed.headers[0]).toBe("quantity");
    expect(parsed.rows[0][0]).toBe("3");
    expect(parsed.rows.some((r) => r.includes("029142712886"))).toBe(true);
  });
});

describe("exportFormats - interactive HTML safety", () => {
  it("escapeHtml neutralizes markup", () => {
    expect(escapeHtml('<img src=x onerror=alert(1)>')).not.toContain("<img");
  });

  it("inlined data cannot break out of the script tag", () => {
    const html = buildInteractiveHtml(
      { headers: ["name"], rows: [["</script><script>alert(1)</script>"]] },
      { title: "T", businessName: "B", timestamp: "2026-06-21", filenameBase: "x" },
    );
    // The literal closing-script sequence must be neutralized in the embedded JSON payload.
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain("\\u003c/script>");
  });

  it("escapes the title/business into the document chrome", () => {
    const html = buildInteractiveHtml(
      { headers: [], rows: [] },
      { title: "<b>x</b>", businessName: "A&B", timestamp: "t", filenameBase: "f" },
    );
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).toContain("A&amp;B");
  });
});
