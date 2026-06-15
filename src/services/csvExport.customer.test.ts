import { describe, it, expect } from "vitest";
import { exportFinalCounts, exportFinalCountsCustomer, exportQuantityAdjustmentsCustomer, exportUnknownsCustomer } from "./csvExport";
import { isSensitiveKey } from "./security/sensitiveFields";
import type { InventoryCount, Product, UnknownCodeReview } from "@/types";

const product = { id: "p1", businessId: "b", name: "Falken Sincera", brand: "Falken", category: "Tire", specsShort: "215/70R15", specsFull: "", primarySku: "28816861", primaryBarcode: "848983012906", gtin: "848983012906", upc: "", ean: "", vendorCodes: ["x"], aliases: ["28816861", "2881-6861"], imageUrl: "", productUrl: "", location: "Bay A", notes: "", status: "active", source: "manual", confidence: 1, verified: true, createdAt: "", updatedAt: "", createdBy: "", updatedBy: "" } as Product;
const count = { id: "c1", businessId: "b", sessionId: "s1", productId: "p1", quantity: 3, lastScannedAt: "t", aliasesSeen: ["28816861"], scanEventIds: ["e1"], createdAt: "", updatedAt: "", syncStatus: "synced", syncError: null, appliedIdempotencyKeys: [] } as InventoryCount;
const review = { rawCode: "999", cleanCode: "999", normalizedCandidates: ["999"], suggestedProductName: "Mystery", suggestedBrand: "X", suggestedCategory: "Tire", status: "open", providerName: "gemini", syncStatus: "synced" } as unknown as UnknownCodeReview;

const SENSITIVE_HEADERS = ["barcode", "gtin", "upc", "ean", "aliases", "raw_code", "clean_code", "normalized", "scan_event_ids", "provider"];

function headerCols(csv: string): string[] {
  return csv.replace(/^﻿/, "").split(/\r?\n/)[0].split(",");
}

describe("customer-safe exports", () => {
  it("platform final-counts DOES include code columns (baseline)", () => {
    const h = headerCols(exportFinalCounts([count], [product], "s1"));
    expect(h).toContain("primary_barcode");
    expect(h).toContain("aliases");
  });
  it("customer final-counts has NO code columns", () => {
    const h = headerCols(exportFinalCountsCustomer([count], [product], "s1"));
    for (const bad of SENSITIVE_HEADERS) expect(h.some((c) => c.toLowerCase().includes(bad))).toBe(false);
    expect(h).toContain("product_name");
    expect(h).toContain("part_number");
  });
  it("customer qty-adjustments has NO code columns", () => {
    const h = headerCols(exportQuantityAdjustmentsCustomer([count], [product], "s1"));
    for (const bad of SENSITIVE_HEADERS) expect(h.some((c) => c.toLowerCase().includes(bad))).toBe(false);
  });
  it("customer unknowns export has NO raw/clean/normalized codes and no provider", () => {
    const csv = exportUnknownsCustomer([review]);
    const h = headerCols(csv);
    for (const bad of SENSITIVE_HEADERS) expect(h.some((c) => c.toLowerCase().includes(bad))).toBe(false);
    expect(csv).not.toContain("gemini"); // provider name never in a customer export
  });
  it("no customer export header is a sensitive key", () => {
    for (const fn of [exportFinalCountsCustomer([count], [product], "s1"), exportQuantityAdjustmentsCustomer([count], [product], "s1"), exportUnknownsCustomer([review])]) {
      for (const col of headerCols(fn)) expect(isSensitiveKey(col)).toBe(false);
    }
  });
});
