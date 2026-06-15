import type {
  Alias,
  InventoryCount,
  PendingSyncItem,
  Product,
  ScanEvent,
  UnknownCodeReview,
} from "@/types";

// Deterministic CSV export. Pure functions (no React, no next/*). Works entirely from local
// session state, so export succeeds even when sync is pending. Never exports secrets/API keys.

const BOM = "﻿"; // helps Excel on Windows read UTF-8 correctly

/** Escape one field: quote when needed, double inner quotes, and neutralize CSV injection. */
export function escapeCsvField(value: unknown): string {
  let s = value == null ? "" : String(value);
  // Guard against CSV/formula injection from user-ish data (product names, scanned codes).
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function buildCsv(headers: string[], rows: Array<Array<unknown>>): string {
  const lines = [headers.map(escapeCsvField).join(",")];
  for (const row of rows) lines.push(row.map(escapeCsvField).join(","));
  return BOM + lines.join("\r\n");
}

// --- Final inventory count (grouped by product, not by code) ---
export function exportFinalCounts(
  counts: InventoryCount[],
  products: Product[],
  sessionId: string,
): string {
  const byId = new Map(products.map((p) => [p.id, p]));
  const headers = [
    "quantity",
    "product_name",
    "brand",
    "category",
    "specs",
    "primary_sku",
    "primary_barcode",
    "gtin",
    "upc",
    "ean",
    "aliases",
    "image_url",
    "product_url",
    "location",
    "notes",
    "counted_at",
    "session_id",
    "sync_status",
    "scan_event_ids",
  ];
  const rows = counts.map((c) => {
    const p = byId.get(c.productId);
    return [
      c.quantity,
      p?.name ?? "",
      p?.brand ?? "",
      p?.category ?? "",
      p?.specsShort ?? "",
      p?.primarySku ?? "",
      p?.primaryBarcode ?? "",
      p?.gtin ?? "",
      p?.upc ?? "",
      p?.ean ?? "",
      c.aliasesSeen.join(" | "),
      p?.imageUrl ?? "",
      p?.productUrl ?? "",
      p?.location ?? "",
      p?.notes ?? "",
      c.lastScannedAt,
      sessionId,
      c.syncStatus,
      c.scanEventIds.join(" | "),
    ];
  });
  return buildCsv(headers, rows);
}

/**
 * Quantity-adjustment CSV: one row per counted product with its code(s) + counted quantity, formatted
 * for pushing adjustments into an inventory system. This MVP does not track a prior "system quantity"
 * baseline, so the counted quantity IS the adjustment value (system_quantity is left blank). Built from
 * the persisted finalCounts so it reflects what synced to Firebase.
 */
export function exportQuantityAdjustments(
  counts: InventoryCount[],
  products: Product[],
  sessionId: string,
): string {
  const byId = new Map(products.map((p) => [p.id, p]));
  const headers = [
    "product_name",
    "primary_sku",
    "primary_barcode",
    "gtin",
    "upc",
    "ean",
    "counted_quantity",
    "system_quantity",
    "adjustment",
    "location",
    "session_id",
  ];
  const rows = counts.map((c) => {
    const p = byId.get(c.productId);
    return [
      p?.name ?? "",
      p?.primarySku ?? "",
      p?.primaryBarcode ?? "",
      p?.gtin ?? "",
      p?.upc ?? "",
      p?.ean ?? "",
      c.quantity,
      "", // system_quantity: not tracked in this MVP
      c.quantity, // adjustment == counted quantity when there is no baseline
      p?.location ?? "",
      sessionId,
    ];
  });
  return buildCsv(headers, rows);
}

export function exportRawScanLog(scanFeed: ScanEvent[]): string {
  const headers = [
    "time",
    "raw_code",
    "clean_code",
    "normalized_candidates",
    "match_type",
    "matched_product_id",
    "status",
    "quantity_after_scan",
    "sync_status",
    "idempotency_key",
  ];
  const rows = scanFeed.map((e) => [
    e.createdAt,
    e.rawCode,
    e.cleanCode,
    e.normalizedCandidates.join(" | "),
    e.matchType,
    e.matchedProductId ?? "",
    e.status,
    e.quantityAfterScan,
    e.syncStatus,
    e.idempotencyKey,
  ]);
  return buildCsv(headers, rows);
}

export function exportUnknowns(reviews: UnknownCodeReview[]): string {
  const headers = [
    "raw_code",
    "clean_code",
    "normalized_candidates",
    "suggested_product_name",
    "suggested_brand",
    "confidence",
    "provider",
    "status",
    "sync_status",
  ];
  const rows = reviews.map((r) => [
    r.rawCode,
    r.cleanCode,
    r.normalizedCandidates.join(" | "),
    r.suggestedProductName,
    r.suggestedBrand,
    r.confidence,
    r.providerName,
    r.status,
    r.syncStatus,
  ]);
  return buildCsv(headers, rows);
}

export function exportProducts(products: Product[]): string {
  const headers = [
    "id",
    "name",
    "brand",
    "category",
    "specs",
    "primary_sku",
    "primary_barcode",
    "gtin",
    "upc",
    "ean",
    "aliases",
    "image_url",
    "location",
    "source",
  ];
  const rows = products.map((p) => [
    p.id,
    p.name,
    p.brand,
    p.category,
    p.specsShort,
    p.primarySku,
    p.primaryBarcode,
    p.gtin,
    p.upc,
    p.ean,
    p.aliases.join(" | "),
    p.imageUrl,
    p.location,
    p.source,
  ]);
  return buildCsv(headers, rows);
}

export function exportAliases(aliases: Alias[]): string {
  const headers = [
    "id",
    "product_id",
    "raw_code_example",
    "clean_code",
    "normalized_code",
    "alias_type",
    "source",
    "confidence",
    "sync_status",
  ];
  const rows = aliases.map((a) => [
    a.id,
    a.productId,
    a.rawCodeExample,
    a.cleanCode,
    a.normalizedCode,
    a.aliasType,
    a.source,
    a.confidence,
    a.syncStatus,
  ]);
  return buildCsv(headers, rows);
}

// ---- Customer-safe (sanitized) exports ----
// For non-platformOwner roles. Product-facing columns ONLY: no barcode/gtin/upc/ean/aliases/raw codes/
// scan-event ids. These are what ExportButtons offers when the access level is "business".

export function exportFinalCountsCustomer(counts: InventoryCount[], products: Product[], sessionId: string): string {
  const byId = new Map(products.map((p) => [p.id, p]));
  const headers = ["quantity", "product_name", "brand", "category", "specs", "part_number", "location", "counted_at", "session_id"];
  const rows = counts.map((c) => {
    const p = byId.get(c.productId);
    return [c.quantity, p?.name ?? "", p?.brand ?? "", p?.category ?? "", p?.specsShort ?? "", p?.primarySku ?? "", p?.location ?? "", c.lastScannedAt, sessionId];
  });
  return buildCsv(headers, rows);
}

export function exportQuantityAdjustmentsCustomer(counts: InventoryCount[], products: Product[], sessionId: string): string {
  const byId = new Map(products.map((p) => [p.id, p]));
  const headers = ["product_name", "brand", "category", "part_number", "counted_quantity", "system_quantity", "adjustment", "location", "session_id"];
  const rows = counts.map((c) => {
    const p = byId.get(c.productId);
    return [p?.name ?? "", p?.brand ?? "", p?.category ?? "", p?.primarySku ?? "", c.quantity, "", c.quantity, p?.location ?? "", sessionId];
  });
  return buildCsv(headers, rows);
}

export function exportUnknownsCustomer(reviews: UnknownCodeReview[]): string {
  // No raw/clean/normalized codes for customers — only the human-facing suggestion + status.
  const headers = ["suggested_product_name", "suggested_brand", "suggested_category", "status"];
  const rows = reviews.map((r) => [r.suggestedProductName, r.suggestedBrand, r.suggestedCategory, r.status]);
  return buildCsv(headers, rows);
}

export function exportPendingQueue(items: PendingSyncItem[]): string {
  const headers = [
    "id",
    "entity_type",
    "entity_id",
    "operation",
    "status",
    "retry_count",
    "last_error",
    "idempotency_key",
    "scan_event_id",
  ];
  const rows = items.map((i) => [
    i.id,
    i.entityType,
    i.entityId,
    i.operation,
    i.status,
    i.retryCount,
    i.lastError ?? "",
    i.idempotencyKey,
    i.scanEventId ?? "",
  ]);
  return buildCsv(headers, rows);
}
