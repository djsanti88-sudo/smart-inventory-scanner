import type { Product, Alias, InventorySession, InventoryCount } from "@/types";

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
