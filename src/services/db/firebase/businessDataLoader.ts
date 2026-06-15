import { type Firestore, collection, getDocs } from "firebase/firestore";
import type { Product, Alias, InventorySession, InventoryCount } from "@/types";
import { COLLECTIONS } from "@/services/db/types";

// Loads a business's persisted data from Firestore into the shapes the local store uses, so the
// deterministic resolver sees products/aliases after a refresh or on a fresh device, and the active
// count session + its counts are reconstructed (survive-refresh). Products, aliases, and sessions are
// stored store-shaped (FirebaseSyncTarget writes the store payload); count lines are stored as
// InventoryCountLine (countedQuantity/countSessionId). The mappers are defensive merges that fill any
// missing required fields. RLS scopes reads to members of `businessId`.

export interface LoadedBusinessData {
  products: Product[];
  aliases: Alias[];
  sessions: InventorySession[];
  counts: InventoryCount[];
}

function str(v: unknown, d = ""): string {
  return typeof v === "string" ? v : d;
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

function num(v: unknown, d = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
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

/**
 * Read a business's products, aliases, count sessions, and count lines from Firestore, mapped to the
 * local store shapes. The store uses sessions/counts to reconstruct the active session + finalCounts
 * after a refresh (survive-refresh). RLS scopes every read to members of `businessId`.
 */
export async function loadBusinessData(db: Firestore, businessId: string): Promise<LoadedBusinessData> {
  const [psnap, asnap, ssnap, csnap] = await Promise.all([
    getDocs(collection(db, COLLECTIONS.businesses, businessId, COLLECTIONS.products)),
    getDocs(collection(db, COLLECTIONS.businesses, businessId, COLLECTIONS.aliases)),
    getDocs(collection(db, COLLECTIONS.businesses, businessId, COLLECTIONS.countSessions)),
    getDocs(collection(db, COLLECTIONS.businesses, businessId, COLLECTIONS.inventoryCounts)),
  ]);
  return {
    products: psnap.docs.map((d) => toStoreProduct(d.id, d.data() as Record<string, unknown>, businessId)),
    aliases: asnap.docs.map((d) => toStoreAlias(d.id, d.data() as Record<string, unknown>, businessId)),
    sessions: ssnap.docs.map((d) => toStoreSession(d.id, d.data() as Record<string, unknown>, businessId)),
    counts: csnap.docs.map((d) => toStoreCount(d.id, d.data() as Record<string, unknown>, businessId)),
  };
}
