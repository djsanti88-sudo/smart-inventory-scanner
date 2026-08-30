// Shared barcode catalog domain types. Kept provider-agnostic so a future cloud database
// (Firebase) can implement the same shapes with no caller changes.
//
// PRIVACY INVARIANT: `CatalogEntry` is the GLOBAL, shareable catalog. It must only ever hold
// sanitized barcode/product/evidence data - never businessId, prices, margins, notes, or any
// shop/customer data. Private, shop-scoped data lives in `ShopOverride` (carries businessId).

import type { ProvenanceTier } from "@/types";

export type CatalogVerificationStatus = "pending" | "verified" | "conflict";
export type CatalogVerifiedBy = "owner" | "admin" | "trusted_source" | "community" | "evidence_score" | null;

/** Tier of the strongest source behind an entry (see services/catalog/sourceTrust). */
export type CatalogSourceTier = "authoritative" | "strong_commercial" | "supporting" | "weak" | "";

export interface CatalogAuditEntry {
  at: string;
  action: string; // "created" | "verified" | "observed" | "ai_suggested" | "conflict_flagged" | ...
  by: string; // "owner" | "ai" | "system" | "community" | "trusted_source"
  note?: string;
}

/** GLOBAL catalog entry. Sanitized, non-private fields only. */
export interface CatalogEntry {
  barcode: string;
  normalizedBarcode: string; // primary lookup key
  barcodeType: string;
  name: string;
  brand: string;
  description: string;
  category: string;
  size: string;
  imageUrl: string;
  sourceUrls: string[];
  evidenceSnippets: string[];
  confidence: number; // 0..1
  verificationStatus: CatalogVerificationStatus;
  verifiedBy: CatalogVerifiedBy;
  timesScanned: number;
  timesConfirmed: number;
  timesRejected: number;
  firstSeenAt: string;
  lastSeenAt: string;
  aliases: string[]; // normalized codes that resolve to this entry
  conflictsWith: string[]; // candidate names/codes flagged as conflicting
  auditLog: CatalogAuditEntry[];
  // Confidence-based auto-learning metadata (set when an entry was auto-verified from evidence).
  autoVerified: boolean;
  autoVerifyReason: string;
  evidenceScore: number; // 0..100 deterministic evidence score
  sourceTier: CatalogSourceTier;
  evidenceSummary: string;
  blockingReasons: string[]; // why it was NOT auto-verified (for pending/review candidates)
  // Phase 5b (GC4 boundary): optional pass-through of the master-catalog (db/types.ts CatalogEntry)
  // identity, populated by toStoreEntry when this entry came from the top-level `catalogEntries`
  // master collection. Both optional - every existing constructor of this type is unaffected.
  masterId?: string;
  masterProvenanceTier?: ProvenanceTier;
}

/** PRIVATE, shop-scoped override. Wins over the global catalog for that shop. Never shared upward. */
export interface ShopOverride {
  businessId: string; // private scope - the reason this is NEVER part of the global catalog
  normalizedBarcode: string;
  name: string;
  brand: string;
  category: string;
  size: string;
  imageUrl: string;
  productUrl: string;
  note: string; // private note allowed here, never in the global catalog
  verified: boolean; // shop-level trust
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

export type CatalogLookupSource =
  | "shop_override"
  | "verified_catalog"
  | "weak_catalog"
  | "none";

export interface CatalogHit {
  source: CatalogLookupSource;
  name: string;
  brand: string;
  category: string;
  size: string;
  imageUrl: string;
  productUrl: string;
  confidence: number;
  verified: boolean; // true => safe to resolve + count without any AI call
}

export interface LookupDecision {
  source: CatalogLookupSource;
  hit: CatalogHit | null;
  /** A verified shop override or verified catalog entry - resolve + count, NO AI. */
  shouldResolveWithoutAi: boolean;
  /** Miss or a weak/pending/conflict hit - the caller may run AI (subject to its own gate). */
  shouldTryAi: boolean;
}

/** Candidate handed to the catalog for writing. Extra/private fields are ignored by the sanitizer. */
export interface CatalogCandidate {
  barcode: string;
  normalizedBarcode: string;
  barcodeType?: string;
  name: string;
  brand?: string;
  description?: string;
  category?: string;
  size?: string;
  imageUrl?: string;
  sourceUrls?: string[];
  evidenceSnippets?: string[];
  confidence?: number;
  aliases?: string[];
  autoVerified?: boolean;
  autoVerifyReason?: string;
  evidenceScore?: number;
  sourceTier?: CatalogSourceTier;
  evidenceSummary?: string;
  blockingReasons?: string[];
  [extra: string]: unknown; // anything else (businessId, price, notes...) is dropped on sanitize
}

export interface CatalogEntryMeta {
  now: string;
  verificationStatus: CatalogVerificationStatus;
  verifiedBy: CatalogVerifiedBy;
  by: string;
}
