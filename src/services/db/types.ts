// Firebase/Firestore domain model for the Launch MVP backend foundation. Every business-scoped document
// carries businessId + createdAt/updatedAt. These are the shapes the typed repositories read/write.

import type { ProvenanceTier } from "@/types";

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
  decisionUpdatedAt?: unknown;
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
  // "rejected" is written by the catalog-review reject action (api/catalog-review/[id]) and consulted
  // by masterAppend.ts's re-append trap (an owner-rejected entry is never silently re-verified).
  // "disputed" (catalog revocation round, design §2.1) is written by /api/catalog-dispute: a soft
  // demotion masterLookup.ts's classifyEntry treats as a miss (falls through to re-decode) - never a
  // human tombstone, and masterAppend.ts's re-append trap turns a fresh strong decode over a disputed
  // doc into a "pending" re-candidate rather than silently re-verifying it.
  verificationStatus?: "verified" | "pending" | "conflict" | "rejected" | "disputed";
  // GC5 (P5b): mirrors Product.provenanceTier (src/types.ts:89-94). Master-truth appends (P5b Task 1)
  // stamp the legacy-compatible "ladder_verified_strong" value for a strong app-verified decode.
  // Optional so every pre-existing CatalogEntry (no tier yet) stays valid.
  provenanceTier?: ProvenanceTier;
  // Written by /api/catalog-review/[id] (approve/reject) - declared here to close a pre-existing type
  // gap (these fields were already written ad hoc, undeclared). Untouched by this round except for
  // reuse in the new dispute audit trail below.
  verifiedBy?: string;
  timesRejected?: number;
  auditLog?: Array<{ at: string; action: string; by: string; reason?: string }>;
  // Catalog revocation round (design §2.1/§2.2): dispute tally + per-business dedup. disputedBy is
  // capped (FIFO, last 50) so the array itself never grows unbounded; disputeCount is the immutable
  // running total (kept even as disputedBy evicts old entries).
  disputeCount?: number;
  disputedBy?: Array<{ businessId: string; at: string }>;
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
