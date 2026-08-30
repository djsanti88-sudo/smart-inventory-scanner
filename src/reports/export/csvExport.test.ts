import { describe, it, expect } from "vitest";
import {
  escapeCsvField,
  buildCsv,
  exportFinalCounts,
  exportQuantityAdjustments,
  exportRawScanLog,
  exportSessionScanLog,
  exportSessionScanLogCustomer,
} from "@/reports/export/csvExport";
import { isSensitiveKey } from "@/shared/privacy/sensitiveFields";
import type { InventoryCount, Product, ScanEvent } from "@/types";

describe("escapeCsvField", () => {
  it("quotes fields containing commas, quotes, or newlines", () => {
    expect(escapeCsvField("a,b")).toBe('"a,b"');
    expect(escapeCsvField('he said "hi"')).toBe('"he said ""hi"""');
    expect(escapeCsvField("line1\nline2")).toBe('"line1\nline2"');
  });

  it("neutralizes CSV/formula injection", () => {
    expect(escapeCsvField("=SUM(A1:A2)")).toBe("'=SUM(A1:A2)");
    expect(escapeCsvField("+1234")).toBe("'+1234");
    expect(escapeCsvField("@cmd")).toBe("'@cmd");
  });

  it("leaves plain values untouched", () => {
    expect(escapeCsvField("Nokian")).toBe("Nokian");
    expect(escapeCsvField(3)).toBe("3");
  });
});

describe("buildCsv", () => {
  it("prepends a UTF-8 BOM and uses CRLF rows", () => {
    const csv = buildCsv(["a", "b"], [["1", "2"]]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain("a,b\r\n1,2");
  });
});

describe("exportFinalCounts", () => {
  const product: Product = {
    id: "prod-nokian",
    businessId: "biz",
    name: "Nokian Outpost APT",
    brand: "Nokian",
    category: "Tire",
    specsShort: "245/55R19 103H",
    specsFull: "",
    primarySku: "T432119",
    primaryBarcode: "6419440485331",
    gtin: "6419440485331",
    upc: "",
    ean: "",
    vendorCodes: [],
    aliases: [],
    imageUrl: "",
    productUrl: "",
    location: "Bay A",
    notes: "",
    status: "active",
    source: "seed",
    confidence: 1,
    verified: true,
    createdAt: "",
    updatedAt: "",
    createdBy: "",
    updatedBy: "",
  };
  const count: InventoryCount = {
    id: "c1",
    businessId: "biz",
    sessionId: "sess",
    productId: "prod-nokian",
    quantity: 3,
    lastScannedAt: "2026-06-12T10:00:00.000Z",
    aliasesSeen: ["6419440485331", "T432119", "T432119%RU1%"],
    scanEventIds: ["e1", "e2", "e3"],
    createdAt: "",
    updatedAt: "",
    syncStatus: "pending",
    syncError: null,
    appliedIdempotencyKeys: [],
  };

  it("groups by product and includes sync_status + scan_event_ids", () => {
    const csv = exportFinalCounts([count], [product], "sess");
    expect(csv).toContain("quantity,product_name");
    expect(csv).toContain("3,Nokian Outpost APT");
    expect(csv).toContain("pending");
    expect(csv).toContain("e1 | e2 | e3");
  });

  it("works from local state even while sync is pending (no throw)", () => {
    expect(() => exportFinalCounts([count], [product], "sess")).not.toThrow();
  });

  it("exports a quantity-adjustment CSV with counted_quantity == adjustment (no baseline tracked)", () => {
    const csv = exportQuantityAdjustments([count], [product], "sess");
    expect(csv).toContain("product_name,primary_sku,primary_barcode,gtin,upc,ean,counted_quantity,system_quantity,adjustment");
    // Nokian Outpost APT, T432119, 6419440485331, 6419440485331, "", "", 3, "", 3, Bay A, sess
    expect(csv).toContain("Nokian Outpost APT,T432119,6419440485331,6419440485331,,,3,,3,Bay A,sess");
  });
});

describe("exportRawScanLog", () => {
  it("includes every scan with its idempotency key", () => {
    const e: ScanEvent = {
      id: "e1",
      businessId: "biz",
      sessionId: "sess",
      rawCode: "T432119%RU1%",
      cleanCode: "T432119%RU1%",
      normalizedCandidates: ["T432119%RU1%", "T432119"],
      matchedProductId: "prod-nokian",
      matchType: "exact_alias",
      status: "known",
      resolverStatus: "known",
      codeType: "messy",
      reason: "",
      quantityDelta: 1,
      quantityAfterScan: 1,
      createdAt: "2026-06-12T10:00:00.000Z",
      source: "scan",
      notes: "",
      syncStatus: "synced",
      syncError: null,
      idempotencyKey: "biz:sess:e1:INCREMENT_COUNT",
    };
    const csv = exportRawScanLog([e]);
    expect(csv).toContain("biz:sess:e1:INCREMENT_COUNT");
    expect(csv).toContain("T432119%RU1%");
  });
});

describe("exportSessionScanLog", () => {
  it("includes a location column and the scan's stamped location value", () => {
    const event: ScanEvent = {
      id: "e1", businessId: "b1", sessionId: "s1", rawCode: "123", cleanCode: "123",
      normalizedCandidates: ["123"], matchedProductId: "p1", matchType: "upc", status: "known",
      resolverStatus: "known", codeType: "upc_a", reason: "matched", quantityDelta: 1,
      quantityAfterScan: 1, createdAt: "2026-07-19T16:00:00.000Z", source: "scan", notes: "",
      syncStatus: "synced", syncError: null, idempotencyKey: "k1", location: "Bay A",
    };
    const csv = exportSessionScanLog([event]);
    expect(csv).toContain("location");
    expect(csv).toContain("Bay A");
  });

  it("renders an empty location as a blank field, never the literal 'undefined'", () => {
    const event: ScanEvent = {
      id: "e1", businessId: "b1", sessionId: "s1", rawCode: "123", cleanCode: "123",
      normalizedCandidates: ["123"], matchedProductId: null, matchType: "unknown", status: "unknown",
      resolverStatus: "needs_review", codeType: "numeric_sku", reason: "no match", quantityDelta: 1,
      quantityAfterScan: 1, createdAt: "2026-07-19T16:00:00.000Z", source: "scan", notes: "",
      syncStatus: "synced", syncError: null, idempotencyKey: "k1",
    };
    const csv = exportSessionScanLog([event]);
    expect(csv).not.toContain("undefined");
  });

  it("keeps the customer export free of platform-only scan fields", () => {
    const event: ScanEvent = {
      id: "e1", businessId: "b1", sessionId: "s1", rawCode: "secret-raw", cleanCode: "secret-clean",
      normalizedCandidates: ["secret-normalized"], matchedProductId: "p1", matchType: "upc", status: "known",
      resolverStatus: "known", codeType: "upc_a", reason: "matched", quantityDelta: 1,
      quantityAfterScan: 1, createdAt: "2026-07-19T16:00:00.000Z", source: "scan", notes: "",
      syncStatus: "synced", syncError: null, idempotencyKey: "secret-key", location: "Bay A",
      deviceId: "private-device",
    };
    const csv = exportSessionScanLogCustomer([event]);
    const headers = csv.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0].split(",");

    for (const header of headers) expect(isSensitiveKey(header)).toBe(false);
    expect(headers).toContain("location");
    expect(headers).not.toContain("raw_code");
    expect(headers).not.toContain("clean_code");
    expect(csv).toContain("Bay A");
    expect(csv).not.toContain("secret-raw");
    expect(csv).not.toContain("secret-clean");
    expect(csv).not.toContain("secret-normalized");
    expect(csv).not.toContain("secret-key");
    expect(csv).not.toContain("private-device");
  });
});
