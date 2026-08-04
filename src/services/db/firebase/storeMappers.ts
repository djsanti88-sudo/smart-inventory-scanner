import type { Product, Alias, InventorySession, InventoryCount, ScanEvent } from "@/types";

// PURE Firestore-doc -> store-shape mappers. Deliberately dependency-free: NO `firebase/firestore` (or any
// client Firebase SDK) runtime import, so these can be safely pulled into a server/serverless API route
// (e.g. /api/resolve-scan) without bundling the client SDK into the function. `loadBusinessData`
// (businessDataLoader.ts) keeps the Firestore runtime imports and reuses these mappers.

function str(v: unknown, d = ""): string {
  return typeof v === "string" ? v : d;
}

function num(v: unknown, d = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}

function strings(v: unknown): string[] {
  if (typeof v === "string") return v ? [v] : [];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function time(v: unknown): string {
  if (typeof v === "string") return v;
  if (!v || typeof v !== "object") return "";
  const ts = v as { toDate?: () => Date; seconds?: number; nanoseconds?: number };
  if (typeof ts.toDate === "function") {
    const d = ts.toDate();
    return Number.isNaN(d.getTime()) ? "" : d.toISOString();
  }
  if (typeof ts.seconds === "number") {
    const d = new Date(ts.seconds * 1000 + Math.floor((ts.nanoseconds ?? 0) / 1_000_000));
    return Number.isNaN(d.getTime()) ? "" : d.toISOString();
  }
  return "";
}

export function toStoreProduct(id: string, data: Record<string, unknown>, businessId: string): Product {
  return {
    id,
    businessId,
    name: str(data.name),
    brand: str(data.brand),
    category: str(data.category),
    specsShort: str(data.specsShort),
    specsFull: str(data.specsFull),
    primarySku: str(data.primarySku),
    primaryBarcode: str(data.primaryBarcode),
    gtin: str(data.gtin),
    upc: str(data.upc),
    ean: str(data.ean),
    vendorCodes: Array.isArray(data.vendorCodes) ? (data.vendorCodes as string[]) : [],
    aliases: Array.isArray(data.aliases) ? (data.aliases as string[]) : [],
    imageUrl: str(data.imageUrl),
    productUrl: str(data.productUrl),
    location: str(data.location),
    notes: str(data.notes),
    status: data.status === "archived" ? "archived" : "active",
    source: (data.source as Product["source"]) ?? "human_review",
    confidence: typeof data.confidence === "number" ? data.confidence : 1,
    verified: data.verified === true,
    trustedExactCanonicalId: str(data.trustedExactCanonicalId) || undefined,
    createdAt: str(data.createdAt),
    updatedAt: str(data.updatedAt),
    createdBy: str(data.createdBy, "human"),
    updatedBy: str(data.updatedBy, "human"),
  };
}

export function toStoreAlias(id: string, data: Record<string, unknown>, businessId: string): Alias {
  return {
    id,
    businessId,
    productId: str(data.productId),
    rawCodeExample: str(data.rawCodeExample),
    cleanCode: str(data.cleanCode),
    normalizedCode: str(data.normalizedCode, str(data.cleanCode)),
    aliasType: (data.aliasType as Alias["aliasType"]) ?? "barcode",
    source: (data.source as Alias["source"]) ?? "human_review",
    confidence: typeof data.confidence === "number" ? data.confidence : 1,
    approved: data.approved === true,
    createdAt: str(data.createdAt),
    updatedAt: str(data.updatedAt),
    createdBy: str(data.createdBy, "human"),
    lastSeenAt: str(data.lastSeenAt),
    syncStatus: "synced",
    idempotencyKey: str(data.idempotencyKey),
  };
}

export function toStoreSession(id: string, data: Record<string, unknown>, businessId: string): InventorySession {
  return {
    id,
    businessId,
    name: str(data.name, "Session"),
    location: str(data.location, "Main"),
    status: data.status === "completed" ? "completed" : "active",
    startedAt: str(data.startedAt),
    completedAt: typeof data.completedAt === "string" && data.completedAt ? data.completedAt : null,
    createdBy: str(data.createdBy, str(data.startedBy, "human")),
    notes: str(data.notes),
    syncStatus: "synced",
  };
}

export function toStoreCount(id: string, data: Record<string, unknown>, businessId: string): InventoryCount {
  // Firestore InventoryCountLine -> store InventoryCount (countedQuantity->quantity,
  // countSessionId->sessionId). The doc id is `${sessionId}_${productId}`; reuse it as the store id.
  const scanEventIds = Array.isArray(data.scanEventIds) ? (data.scanEventIds as string[]) : [];
  return {
    id,
    businessId,
    sessionId: str(data.countSessionId),
    productId: str(data.productId),
    quantity: num(data.countedQuantity ?? data.quantity),
    lastScannedAt: str(data.lastScannedAt),
    aliasesSeen: Array.isArray(data.aliasesSeen) ? (data.aliasesSeen as string[]) : [],
    scanEventIds,
    createdAt: str(data.createdAt),
    updatedAt: str(data.updatedAt),
    syncStatus: "synced",
    syncError: null,
    appliedIdempotencyKeys: Array.isArray(data.appliedIdempotencyKeys)
      ? (data.appliedIdempotencyKeys as string[])
      : [],
  };
}

export function toStoreScanEvent(id: string, data: Record<string, unknown>, businessId: string): ScanEvent {
  return {
    id,
    businessId,
    sessionId: str(data.sessionId, str(data.countSessionId)),
    rawCode: str(data.rawCode),
    cleanCode: str(data.cleanCode, str(data.rawCode)),
    normalizedCandidates: strings(data.normalizedCandidates ?? data.normalizedCode),
    matchedProductId: typeof data.matchedProductId === "string" ? data.matchedProductId : null,
    matchType: (data.matchType as ScanEvent["matchType"]) ?? "unknown",
    status: (data.status as ScanEvent["status"]) ?? "unknown",
    resolverStatus: (data.resolverStatus as ScanEvent["resolverStatus"]) ?? "needs_review",
    codeType: (data.codeType as ScanEvent["codeType"]) ?? "messy",
    reason: str(data.reason),
    decodeNote: typeof data.decodeNote === "string" ? data.decodeNote : undefined,
    decodeStatus: (data.decodeStatus as ScanEvent["decodeStatus"]) ?? undefined,
    provenance: (data.provenance as ScanEvent["provenance"]) ?? undefined,
    offCategory: data.offCategory === true ? true : undefined,
    suggestion: data.suggestion as ScanEvent["suggestion"],
    quantityDelta: num(data.quantityDelta, 1),
    quantityAfterScan: num(data.quantityAfterScan, 1),
    createdAt: time(data.scannedAt) || time(data.createdAt),
    source: (data.source as ScanEvent["source"]) ?? "scan",
    notes: str(data.notes),
    syncStatus: "synced",
    syncError: null,
    idempotencyKey: str(data.idempotencyKey),
    deviceId: typeof data.deviceId === "string" ? data.deviceId : undefined,
    location: typeof data.location === "string" ? data.location : undefined,
  };
}
