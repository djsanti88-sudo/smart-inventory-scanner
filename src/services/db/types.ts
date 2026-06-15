// Firebase/Firestore domain model for the Launch MVP backend foundation. Every business-scoped document
// carries businessId + createdAt/updatedAt. These are the shapes the typed repositories read/write.

export type Role = "owner" | "admin" | "counter" | "viewer";

export interface Business {
  id: string;
  name: string;
  slug?: string;
  createdBy: string; // auth uid of the creator (becomes owner)
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface UserProfile {
  id: string; // = auth uid
  authUserId: string;
  email: string;
  name?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface BusinessMember {
  id: string; // = `${businessId}_${userId}`
  businessId: string;
  userId: string;
  role: Role;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface Product {
  id: string;
  businessId: string;
  name: string;
  brand?: string;
  category?: string;
  specs?: string;
  primarySku?: string;
  primaryBarcode?: string;
  gtin?: string;
  upc?: string;
  ean?: string;
  vendorCodes?: string[];
  location?: string;
  imageUrl?: string;
  verified?: boolean;
  source?: string;
  currentQuantity?: number;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface Alias {
  id: string;
  businessId: string;
  productId: string;
  rawCode?: string;
  cleanCode: string;
  normalizedCode?: string;
  aliasType?: string;
  approved?: boolean;
  confidence?: number;
  createdBy?: string;
  approvedBy?: string;
  createdAt?: unknown;
  approvedAt?: unknown;
  updatedAt?: unknown;
}

export interface ScanEvent {
  id: string;
  businessId: string;
  countSessionId?: string;
  rawCode?: string;
  cleanCode?: string;
  normalizedCode?: string;
  matchedProductId?: string;
  matchedAliasId?: string;
  matchType?: string;
  quantityDelta?: number;
  status?: string;
  idempotencyKey?: string;
  syncStatus?: string;
  scannedBy?: string;
  scannedAt?: unknown;
  createdAt?: unknown;
}

export interface CountSession {
  id: string;
  businessId: string;
  name?: string;
  status?: string;
  location?: string;
  category?: string;
  startedBy?: string;
  completedBy?: string;
  startedAt?: unknown;
  completedAt?: unknown;
  notes?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface InventoryCountLine {
  id: string;
  businessId: string;
  countSessionId: string;
  productId: string;
  countedQuantity?: number;
  previousQuantity?: number;
  variance?: number;
  scanEventIds?: string[];
  updatedAt?: unknown;
}

export interface UnknownCodeReview {
  id: string;
  businessId: string;
  countSessionId?: string;
  rawCode?: string;
  cleanCode?: string;
  normalizedCode?: string;
  status?: string;
  suggestedProductId?: string;
  approvedProductId?: string;
  rejectionReason?: string;
  decodeStatus?: string;
  evidenceStrength?: string;
  exactCodeEvidenceVerifiedByApp?: boolean;
  createdBy?: string;
  reviewedBy?: string;
  createdAt?: unknown;
  reviewedAt?: unknown;
}

export interface Settings {
  id: string;
  businessId: string;
  aiProvider?: string;
  dailyCap?: number;
  autoDecodeEnabled?: boolean;
  decodeBudget?: number;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface CatalogEntry {
  id: string;
  normalizedBarcode: string;
  name?: string;
  brand?: string;
  category?: string;
  verificationStatus?: "verified" | "pending" | "conflict";
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface ShopOverride {
  id: string;
  businessId: string;
  normalizedBarcode: string;
  name?: string;
  brand?: string;
  category?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface AuditEvent {
  id: string;
  businessId: string;
  actorUserId?: string;
  entityType?: string;
  entityId?: string;
  action?: string;
  before?: unknown;
  after?: unknown;
  metadata?: unknown;
  createdAt?: unknown;
}

export const COLLECTIONS = {
  businesses: "businesses",
  userProfiles: "userProfiles",
  businessMembers: "businessMembers",
  products: "products",
  aliases: "aliases",
  countSessions: "countSessions",
  inventoryCounts: "inventoryCounts",
  scanEvents: "scanEvents",
  unknownCodeReviews: "unknownCodeReviews",
  settings: "settings",
  catalogEntries: "catalogEntries",
  shopOverrides: "shopOverrides",
  auditLog: "auditLog",
} as const;

/** Deterministic membership doc id so security rules can get()/exists() it cheaply. */
export function memberDocId(businessId: string, userId: string): string {
  return `${businessId}_${userId}`;
}
