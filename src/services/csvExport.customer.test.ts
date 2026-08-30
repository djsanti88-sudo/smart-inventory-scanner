import { describe, it, expect } from "vitest";
import { exportFinalCounts, exportFinalCountsCustomer, exportQuantityAdjustmentsCustomer, exportUnknownsCustomer } from "@/reports/export/csvExport";
import { isSensitiveKey } from "@/shared/privacy/sensitiveFields";
import type { InventoryCount, Product, UnknownCodeReview } from "@/types";

const product = { id: "p1", businessId: "b", name: "Falken Sincera", brand: "Falken", category: "Tire", specsShort: "215/70R15", specsFull: "", primarySku: "28816861", primaryBarcode: "848983012906", gtin: "848983012906", upc: "", ean: "", vendorCodes: ["x"], aliases: ["28816861", "2881-6861"], imageUrl: "", productUrl: "", location: "Bay A", notes: "", status: "active", source: "manual", confidence: 1, verified: true, createdAt: "", updatedAt: "", createdBy: "", updatedBy: "" } as Product;
const count = { id: "c1", businessId: "b", sessionId: "s1", productId: "p1", quantity: 3, lastScannedAt: "t", aliasesSeen: ["28816861"], scanEventIds: ["e1"], createdAt: "", updatedAt: "", syncStatus: "synced", syncError: null, appliedIdempotencyKeys: [] } as InventoryCount;
const review = { rawCode: "999", cleanCode: "999", normalizedCandidates: ["999"], suggestedProductName: "Mystery", suggestedBrand: "X", suggestedCategory: "Tire", status: "open", providerName: "gpt-5.4-mini", syncStatus: "synced" } as unknown as UnknownCodeReview;

// "barcode" is intentionally EXCLUDED here: a shop's own scanned barcode on its own product row is
// their data (same rule as commit 13adbdd / sensitiveFields.ts CUSTOMER_SAFE_PRODUCT_FIELDS comment).
// gtin/upc/ean (the platform's reusable catalog identifiers, distinct from what the shop itself
// scanned) stay excluded, as do aliases/raw codes/scan-event ids/provider names.
const SENSITIVE_HEADERS = ["gtin", "upc", "ean", "aliases", "raw_code", "clean_code", "normalized", "scan_event_ids", "provider"];

function headerCols(csv: string): string[] {
  return csv.replace(/^﻿/, "").split(/\r?\n/)[0].split(",");
}

describe("customer-safe exports", () => {
  it("platform final-counts DOES include code columns (baseline)", () => {
    const h = headerCols(exportFinalCounts([count], [product], "s1"));
    expect(h).toContain("primary_barcode");
    expect(h).toContain("aliases");
  });
  it("customer final-counts has NO reusable-catalog code columns, but DOES include the shop's own barcode", () => {
    const h = headerCols(exportFinalCountsCustomer([count], [product], "s1"));
    for (const bad of SENSITIVE_HEADERS) expect(h.some((c) => c.toLowerCase().includes(bad))).toBe(false);
    expect(h).toContain("product_name");
    expect(h).toContain("part_number");
    expect(h).toContain("barcode");
    expect(h.indexOf("barcode")).toBe(h.indexOf("part_number") + 1);
    const rows = exportFinalCountsCustomer([count], [product], "s1").split(/\r?\n/);
    const barcodeCol = h.indexOf("barcode");
    expect(rows[1].split(",")[barcodeCol]).toBe(product.primaryBarcode);
  });
  it("customer qty-adjustments has NO reusable-catalog code columns, but DOES include the shop's own barcode", () => {
    const h = headerCols(exportQuantityAdjustmentsCustomer([count], [product], "s1"));
    for (const bad of SENSITIVE_HEADERS) expect(h.some((c) => c.toLowerCase().includes(bad))).toBe(false);
    expect(h).toContain("barcode");
    expect(h.indexOf("barcode")).toBe(h.indexOf("part_number") + 1);
    const rows = exportQuantityAdjustmentsCustomer([count], [product], "s1").split(/\r?\n/);
    const barcodeCol = h.indexOf("barcode");
    expect(rows[1].split(",")[barcodeCol]).toBe(product.primaryBarcode);
  });
  it("customer unknowns export has NO raw/clean/normalized codes, no barcode, and no provider", () => {
    const csv = exportUnknownsCustomer([review]);
    const h = headerCols(csv);
    const unknownsSensitive = [...SENSITIVE_HEADERS, "barcode"];
    for (const bad of unknownsSensitive) expect(h.some((c) => c.toLowerCase().includes(bad))).toBe(false);
    expect(csv).not.toContain("gpt-5.4-mini"); // provider name never in a customer export
  });
  it("no customer export header is a sensitive key (barcode excepted for the shop's-own-data exports)", () => {
    for (const fn of [exportFinalCountsCustomer([count], [product], "s1"), exportQuantityAdjustmentsCustomer([count], [product], "s1")]) {
      for (const col of headerCols(fn)) {
        if (col === "barcode") continue; // intentional: shop's own scanned barcode, not reusable catalog data
        expect(isSensitiveKey(col)).toBe(false);
      }
    }
    for (const col of headerCols(exportUnknownsCustomer([review]))) expect(isSensitiveKey(col)).toBe(false);
  });
});
