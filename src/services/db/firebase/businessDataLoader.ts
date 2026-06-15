import { type Firestore, collection, getDocs } from "firebase/firestore";
import type { Product, Alias } from "@/types";
import { COLLECTIONS } from "@/services/db/types";

// Loads a business's persisted data from Firestore into the shapes the local store uses, so the
// deterministic resolver sees products/aliases after a refresh or on a fresh device. Products and
// aliases are stored store-shaped (FirebaseSyncTarget writes the store payload), so the mappers are
// defensive merges that fill any missing required fields. RLS scopes reads to members of `businessId`.

export interface LoadedBusinessData {
  products: Product[];
  aliases: Alias[];
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

/** Read a business's products + aliases from Firestore, mapped to the local store shapes. */
export async function loadBusinessData(db: Firestore, businessId: string): Promise<LoadedBusinessData> {
  const [psnap, asnap] = await Promise.all([
    getDocs(collection(db, COLLECTIONS.businesses, businessId, COLLECTIONS.products)),
    getDocs(collection(db, COLLECTIONS.businesses, businessId, COLLECTIONS.aliases)),
  ]);
  return {
    products: psnap.docs.map((d) => toStoreProduct(d.id, d.data() as Record<string, unknown>, businessId)),
    aliases: asnap.docs.map((d) => toStoreAlias(d.id, d.data() as Record<string, unknown>, businessId)),
  };
}
