"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type {
  Alias,
  AiLookupLog,
  AiLookupResult,
  DecodeDecision,
  InventoryCount,
  InventorySession,
  PendingSyncItem,
  Product,
  ScanEvent,
  Settings,
  SyncOperation,
  UnknownCodeReview,
} from "@/types";
import { cleanScanCode } from "@/services/scanCleaner";
import { normalizeCode } from "@/services/codeNormalizer";
import { evaluateMismatch, type MismatchVerdict } from "@/services/productMismatchGuard";
import { detectCodeType, codeTypeToAliasType } from "@/services/codeTypeDetector";
import { resolveScan } from "@/services/resolver";
import { resolveScanToProduct } from "@/services/aliasMatcher";
import { blobContainsCodeToken, codeFromNamePrefix, normCodeToken } from "@/services/productDedup";
import { incrementInventoryCount } from "@/services/inventory";
import { buildIdempotencyKey } from "@/services/idempotency";
import { MockDb, getMockDb, type IncrementPayload, type SyncResult } from "@/services/mockDb";
import type { SyncTarget } from "@/services/db/syncTarget";
import { FirebaseSyncTarget } from "@/services/db/firebase/firebaseSyncTarget";
import { loadBusinessData } from "@/services/db/firebase/businessDataLoader";
import { auditRepository, catalogRepository } from "@/services/db/firebase/repositories";
import { getDb } from "@/lib/firebaseClient";
import {
  evaluateAiGate,
  initBreaker,
  recordFailure,
  recordSuccess,
  canRequest,
  isDailyCapReached,
  type AiGateReason,
  type BreakerState,
} from "@/services/circuitBreaker";
import { sanitizeForAiLookup } from "@/services/sanitizer";
import { isUsableProductName, cleanProductName } from "@/services/ai/decode";
import { buildCleanupRecommendations } from "@/services/cleanup/recommendations";
import type { CatalogEntry, CatalogHit, ShopOverride } from "@/services/catalog/catalogTypes";
import { decideLookup, upsertVerified, applyAiCandidate, observeScan } from "@/services/catalog/localCatalogProvider";
import { planAutoVerify } from "@/services/catalog/catalogAutoVerify";
import { isTireContext, hasRequiredTireSpecs, hasCountableTireIdentity } from "@/services/ai/tireSpecs";
import { extractTireFields } from "@/services/tire/extractTireFields";
import { collectGroundedIdentifiers, discoverableIdentifiers } from "@/services/aliasDiscovery";
import { lookupTirePrefix } from "@/services/tire/tirePrefixLookup";
import { deriveBrandPrefixHints, decodeBarcodeStructure } from "@/services/ai/barcodeAnatomy";
import { detectScanContextConflict, detectIdentityContextConflict, conflictReason } from "@/services/ai/scanContextFirewall";
import { isCatalogWritable, sanitizeCatalogEntry } from "@/services/catalog/sanitizeCatalog";
import type { CatalogSourceTier, CatalogVerifiedBy } from "@/services/catalog/catalogTypes";
import { appendFeedback, type FeedbackEvent, type FeedbackEventType } from "@/services/feedback/feedback";
import { toAuditEvent, type AuditEventInput } from "@/services/audit/audit";
import { parseCsv, buildProductImport, type ImportConflict } from "@/services/csvImport";
import { getSeed, DEMO_BUSINESS_ID } from "@/seed/seedData";
import { buildPersistedScanState, type PersistableScanState } from "@/stores/scanPersist";
import type { AiStatus } from "@/types";

/** Result summary of a CSV product import (shown in the UI). */
export interface CsvImportSummary {
  rowsParsed: number;
  productsCreated: number;
  aliasesCreated: number;
  duplicates: number;
  conflicts: ImportConflict[];
}

/** Snapshot of rows removed by a junk cleanup, so the action is fully reversible (Undo). */
export interface CleanupBackup {
  removedCounts: InventoryCount[];
  removedProducts: Product[];
  removedAliases: Alias[];
  removedAt: string;
}

/** Full snapshot taken before deleting product(s), so a delete is fully reversible (Undo) + downloadable. */
export interface ProductDeleteBackup {
  products: Product[]; // the product rows as they were BEFORE delete (active/verified)
  aliases: Alias[]; // their aliases as they were BEFORE delete (approval intact)
  counts: InventoryCount[]; // their removed InventoryCount rows
  catalog: CatalogEntry[]; // removed global-catalog entries keyed to their codes
  shopOverrides: ShopOverride[]; // removed private shop-override entries keyed to their codes
  feed: ScanEvent[]; // scan-feed rows (full prior value) that referenced the deleted product(s)
  deletedAt: string;
}

const DEFAULT_AI_STATUS: AiStatus = {
  liveEnabled: true,
  autoDecodeOnScan: true,
  geminiEnabled: true,
  openaiEnabled: true,
  geminiConfigured: false,
  openaiConfigured: false,
  premiumFallback: false,
  mode: "aggressive",
  dailyLimit: 100,
  missingKeys: ["GEMINI_API_KEY", "OPENAI_API_KEY"],
  emergencyStop: false,
  lastAttemptAt: null,
  lastProvider: "",
  lastFailureReason: "",
};

/**
 * Decide whether an unknown scan should auto-run the live decode pipeline, and if not, WHY.
 * The "why" becomes the scan-row reason so the user always knows what happened (no silent skip).
 */
function evaluateAutoDecode(p: {
  aiEnabled: boolean;
  status: AiStatus;
  online: boolean;
  dailyCount: number;
  dailyLimit: number;
  breaker: BreakerState;
  now: number;
}): { allowed: boolean; reason: string } {
  if (!p.aiEnabled) return { allowed: false, reason: "AI lookup is off. Turn it on in Settings to auto-decode." };
  if (!p.status.liveEnabled)
    return { allowed: false, reason: "Live AI lookup is disabled on the server (ENABLE_LIVE_AI_LOOKUP=false)." };
  if (!p.status.autoDecodeOnScan) return { allowed: false, reason: "Auto decode on scan is disabled." };
  if (p.status.emergencyStop) return { allowed: false, reason: "Emergency stop is active. AI calls are paused." };
  if (!p.online) return { allowed: false, reason: "Offline. Saved locally; AI was not called." };
  if (!p.status.geminiConfigured && !p.status.openaiConfigured) {
    const missing = p.status.missingKeys.join(", ") || "GEMINI_API_KEY, OPENAI_API_KEY";
    return { allowed: false, reason: `No API keys configured (missing: ${missing}). Set them server-side, then retry live decode.` };
  }
  if (isDailyCapReached(p.dailyCount, p.dailyLimit))
    return { allowed: false, reason: "Daily AI lookup cap reached. Routed to Needs Review." };
  if (!canRequest(p.breaker, p.now).allowed)
    return { allowed: false, reason: "AI circuit breaker is open after repeated failures. Routed to Needs Review." };
  return { allowed: true, reason: "Decoding with AI..." };
}

/**
 * Tire portion of the auto-count gate, shared by liveDecode + backgroundVerifyDeep so the spec requirement
 * cannot drift between the two paths again. A non-tire decode is unaffected; a tire must carry the COUNTABLE
 * identity (brand-prefix + size + model), matching the route's verify gate (decode.ts hasCountableTireIdentity).
 * Load index + speed rating are optional enrichment, not required to count. This relaxes ONLY the spec
 * requirement; every other clause of the gate (verified status, app-verified exact code, confidence >= 0.9,
 * firewall / brand-prefix conflict, planAutoVerify) is enforced separately and unchanged.
 */
function tireAutoCountOk(best: AiLookupResult | null | undefined): boolean {
  return !isTireContext(best) || hasCountableTireIdentity(best);
}

/**
 * What counts as "corroborated" for auto-count, shared by liveDecode + backgroundVerifyDeep so the rule
 * cannot drift. The app-verified exact code OR the internet_two_source_size path (brand from the strong GS1
 * prefix + two independent Internet sources agreeing on the size, set app-side by the route race). The
 * local DB is never involved. Every OTHER gate clause (verified status, confidence >= 0.9, tireOk,
 * no context conflict, autoAddOn) is enforced separately and unchanged.
 */
export function decodeCorroborated(decision: { exactCodeEvidenceVerifiedByApp?: boolean; corroborationPath?: string } | null | undefined): boolean {
  return Boolean(decision?.exactCodeEvidenceVerifiedByApp) || decision?.corroborationPath === "internet_two_source_size";
}

// The local optimistic session store. Known scans update this store immediately - the UI never
// waits on a server round-trip. Sync to the (mock) backend happens AFTER the user sees feedback,
// using idempotency keys so a retry can never double-count.

export interface ScanStoreDeps {
  db: SyncTarget; // MockDb (local, sync) or FirebaseSyncTarget (cloud/emulator, async)
  idFactory: () => string;
  now: () => string;
  persistName: string | null; // null disables persistence (used by tests)
  // When true (Firebase backend), syncPending uses the async drain and REQUIRES a real business context
  // (businessId + userId) before any write. Default/mock path is unchanged (sync, no context required).
  cloudBackend?: boolean;
  // Cloud backend only: loads a business's products/aliases/sessions/counts from Firestore when its
  // context is set, so the deterministic resolver works and the active session + finalCounts are
  // reconstructed after a refresh / on a fresh device. Injectable for tests.
  loadBusinessData?: (
    businessId: string,
    userId: string,
  ) => Promise<{
    products: Product[];
    aliases: Alias[];
    sessions: InventorySession[];
    counts: InventoryCount[];
  }>;
  // Fire-and-forget audit sink (cloud -> auditRepository.append). Optional: when absent (mock/default)
  // audit is a no-op. It must never throw into the scanner path; the store also guards every call.
  audit?: (event: AuditEventInput) => void;
  // Cloud global catalog lookup (Option 1 wiring). Given a list of candidate codes, returns the first
  // verified CatalogEntry from the global Firestore catalog, or null on a miss. Optional: when absent
  // (tests / mock path) the cloud step is skipped and the scan falls through to AI / Needs Review.
  lookupGlobalCatalog?: (codes: string[]) => Promise<CatalogEntry | null>;
}

export const DEFAULT_SETTINGS: Settings = {
  businessId: DEMO_BUSINESS_ID,
  // Internal lookup is ALWAYS-ON by default: unknown codes auto-attempt the internal decode pipeline
  // (when configured server-side) before going to Needs Review. The toggle remains platformOwner-only.
  aiLookupEnabled: true,
  // Gemini Flash is the primary decode provider; OpenAI (gpt-5-mini) is the fallback. In mock/E2E mode the
  // server forces the mock provider regardless, so this only affects real-cloud lookups (keys server-side).
  primaryProvider: "gemini",
  fallbackProvider: "openai",
  dailyLookupLimit: 200, // fallback if the server cap (AI_LOOKUP_DAILY_LIMIT) is unreachable
  dailyLookupCount: 0,
  lastResetDate: "1970-01-01",
  requireHumanApprovalForMerges: true,
  allowImageSuggestions: true,
  allowProductUrlSuggestions: true,
  scannerSubmitMode: "both",
  scannerDebounceMs: 80,
  enablePendingSyncQueue: true,
  enableIdempotentSync: true,
  autoSuggestUnknowns: false,
  autoAcceptVerifiedDecodes: false,
  autoAddDecodedProducts: true,
  decodeBudgetMs: 13000,
  autoCatalogLearningEnabled: true,
  autoVerifyConfidenceThreshold: 80,
  scanContext: "tire", // Phase 9: default to Tires so the category firewall protects from day one (no setup)
  trustedSourceAutoVerifyEnabled: true,
  aiOnlyAutoVerifyAllowed: false,
};

export interface ScanState {
  // identity / config
  businessId: string;
  userId: string | null; // signed-in user (Firebase backend); null on the local/mock path
  businessContextReady: boolean; // true once a REAL business context is set (or always on the mock path)
  // Cloud backend: true once loadBusinessData has finished (products/aliases/session/counts in store), so
  // the UI does not let a scan run against an empty catalog before the business's data arrives. Always
  // true on the mock/local path.
  businessDataLoaded: boolean;
  currentSession: InventorySession | null;
  sessionId: string;
  settings: Settings;

  // deterministic lookup data (seeded; learned aliases are appended and persisted)
  products: Product[];
  aliases: Alias[];

  // live session data
  scanFeed: ScanEvent[]; // newest first
  finalCounts: InventoryCount[];
  needsReviewQueue: UnknownCodeReview[];

  // sync
  pendingSyncQueue: PendingSyncItem[];
  syncedScanEventIds: string[];
  online: boolean;
  simulateSyncFailure: boolean;
  lastSyncError: string | null;
  // Transient (not persisted): set when a link to a product was BLOCKED by the human-mistake guard.
  // The UI shows the warning and may re-call resolveUnknown with confirmedMismatch: true to override.
  lastMismatchWarning: { reviewId: string; productId: string; verdict: MismatchVerdict } | null;
  // Transient (not persisted): SELECTED discovered identifiers that could NOT be approved because the
  // clean code already belongs to a DIFFERENT product. Surfaced to the UI; never silently overwritten.
  lastAliasConflicts: { reviewId: string; code: string; existingProductId: string }[] | null;
  // Transient (not persisted): set when a scan was BLOCKED by the category firewall. Drives the
  // non-blocking, dismissible warning banner on the scan page (the item still goes to Needs Review).
  lastCategoryWarning: { code: string; productName: string; reason: string } | null;

  // AI lookup (fallback only, for unknown codes)
  aiLookupLogs: AiLookupLog[];
  breaker: BreakerState;
  aiStatus: AiStatus;

  // shared barcode knowledge (local, offline-first abstraction; cloud later via CatalogProvider)
  catalog: CatalogEntry[]; // GLOBAL verified catalog (sanitized, non-private)
  shopOverrides: ShopOverride[]; // PRIVATE, businessId-scoped; never merged into catalog
  feedbackEvents: FeedbackEvent[]; // PRIVATE local event log (capped ring buffer)

  // most recent junk-cleanup snapshot (enables Undo); persisted so Undo survives a reload
  lastCleanupBackup: CleanupBackup | null;
  // most recent product-delete snapshot (enables Undo); persisted so Undo survives a reload
  lastProductDeleteBackup: ProductDeleteBackup | null;
  // most recent identifier-backfill snapshot (enables in-session Undo of the P2 name-prefix backfill)
  lastIdentifierBackfill: Array<{ productId: string; primaryBarcode: string; upc: string }> | null;

  // hydration guard
  _hasHydrated: boolean;

  // actions
  setHasHydrated: (v: boolean) => void;
  /** Set the signed-in business context (Firebase backend). Enables cloud sync + drains the queue. */
  setBusinessContext: (businessId: string, userId: string) => void;
  startSession: (name: string, location: string) => void;
  /** Mark the current session completed (status=completed, completedAt set) and persist it. */
  finishSession: () => void;
  processScan: (rawInput: string) => ScanEvent | null;
  syncPending: (force?: boolean) => void;
  retrySync: () => void;
  setOnline: (online: boolean) => void;
  setSimulateSyncFailure: (on: boolean) => void;
  updateSettings: (partial: Partial<Settings>) => void;
  lookupUnknown: (reviewId: string) => Promise<void>;
  liveDecode: (reviewId: string) => Promise<void>;
  /** Tasks 5+6: client-orchestrated background verify. After a tire scan's fast decode lands as
   *  suggested/needs_review, fire ONE `mode:"decode-deep"` request WITH `scanContext:"tire"` (the
   *  page-fetch verify gate cannot fire without it). On a `verified` decideDecode result, route it
   *  through the EXISTING verified-decode handling (count + alias) using the scan's existing review,
   *  so a late/duplicate response can never double-count (the open-status guard makes it idempotent).
   *  A non-verified deep result never counts; it may only refresh the review suggestion. */
  backgroundVerifyDeep: (reviewId: string) => Promise<void>;
  /** Option 1 wiring: async cloud global catalog lookup on an in-memory-catalog miss.
   *  Awaits deps.lookupGlobalCatalog, applies the Phase-8C firewall, merges a verified hit into
   *  the in-memory catalog, records "found_from_catalog" feedback, and resolves via resolveUnknown.
   *  Falls through to AI on a miss, pending entry, firewall conflict, or dep absence. Fire-and-forget. */
  cloudCatalogResolve: (reviewId: string, codes: string[]) => Promise<void>;
  setAiStatus: (partial: Partial<AiStatus>) => void;
  refreshAiStatus: () => Promise<void>;
  setEmergencyStop: (on: boolean) => void;
  resolveUnknown: (
    reviewId: string,
    action: "link_existing" | "create_new" | "ignore",
    payload: {
      productId?: string;
      newProduct?: Partial<Product>;
      applyToCount?: boolean;
      origin?: "human" | "ai" | "catalog" | "auto_verify" | "auto_count";
      autoVerify?: {
        score: number;
        verifiedBy: CatalogVerifiedBy;
        sourceTier: CatalogSourceTier;
        reason: string;
        evidenceSummary: string;
        sourceUrls: string[];
      };
      /** Owner override: proceed with a link the mismatch guard flagged high-risk (audited). */
      confirmedMismatch?: boolean;
      /** Codes the human explicitly selected from the discovered identifiers to approve as aliases (W2). */
      selectedAliasCodes?: string[];
    },
  ) => void;
  /** Evaluate (without committing) whether linking a review's code to a product looks like a mistake. */
  evaluateLinkMismatch: (reviewId: string, productId: string) => MismatchVerdict | null;
  /** Clear a pending mismatch warning (e.g. the user cancelled the risky link). */
  clearMismatchWarning: () => void;
  clearAliasConflicts: () => void;
  /** Clear the category-firewall warning banner (user dismissed it or switched category). */
  clearCategoryWarning: () => void;
  /** Approve DISCOVERED (grounded, unapproved) identifiers as aliases for a product so scanning any of
   *  them resolves to it. Conflict-safe (a code approved for a DIFFERENT product is skipped + surfaced);
   *  idempotent (re-approving an already-approved code is a no-op). Never invents a code. */
  approveDiscoveredIdentifiers: (productId: string, cleanCodes: string[]) => void;
  /** Repair a bad alias: unlink it (stops resolving; soft delete, scan history kept). Audited. */
  unlinkAlias: (aliasId: string) => void;
  /** Repair a bad alias: move it to the correct product. Audited. */
  moveAlias: (aliasId: string, toProductId: string) => void;
  /** Phase 6: remove a product's count from the current session only (keeps product + aliases). Audited. */
  removeFromCount: (productId: string) => void;
  /** Phase 6: edit safe product fields (name/brand/category/specs/sku/image/location). No alias trust change. */
  correctProduct: (
    productId: string,
    fields: Partial<Pick<Product, "name" | "brand" | "category" | "specsShort" | "specsFull" | "primarySku" | "imageUrl" | "location">>,
  ) => void;
  /** Phase 6: mark a counted product wrong - deactivate its scanned-code aliases, remove the session count,
   *  reopen Needs Review for the code, and request a Gemini Pro correction recheck. Returns the reopened review id. */
  markWrong: (productId: string, opts?: { reason?: string }) => Promise<string | null>;
  /** Phase 6: reopen (or create) an OPEN Needs Review item for a clean code; clears stale suggestions. */
  reopenNeedsReview: (cleanCode: string, reason: string) => string | null;
  /** Phase 6: correction-only Gemini Pro recheck. Cost-guarded (one per code unless retry). Never auto-saves. */
  correctionRecheck: (reviewId: string, opts?: { retry?: boolean; reason?: string }) => Promise<void>;
  /** Append a private feedback/event-log entry (the "smarter over time" substrate). */
  recordFeedback: (
    type: FeedbackEventType,
    payload: { code: string; productId?: string | null; meta?: Record<string, string | number | boolean> },
  ) => void;
  /** Import products + approved aliases from CSV text (MVP). Writes via the durable queue + audits. */
  importProductsCsv: (text: string) => CsvImportSummary;
  /** Audit a CSV export (called by the export UI). Fire-and-forget; never blocks. */
  auditCsvExport: (kind: string, rowCount: number, format?: string) => void;
  pendingCount: () => number;
  getProduct: (id: string | null) => Product | undefined;
  clearSession: () => void;
  /** Dev/recovery action: wipe persisted + mock-backend state and reload clean seed data. */
  clearLocalCache: () => void;
  /** Remove the owner-selected recommended count rows (+ orphaned products/aliases). Snapshots for Undo. */
  applyCleanupSelections: (selectedCountIds: string[]) => { removed: number; backup: CleanupBackup | null };
  /** Convenience: apply all high-confidence (default-checked) recommendations. */
  cleanupJunkCounts: () => { removed: number; backup: CleanupBackup | null };
  /** Restore the rows removed by the most recent cleanup (additively, no data loss). */
  undoCleanup: () => boolean;
  /** Delete a saved product: archive it (status archived + verified false so the resolver stops matching),
   *  deactivate ALL its aliases, remove its count rows, detach its scan-feed rows, and drop catalog/
   *  shop-override entries keyed to its codes. Reversible (snapshots for Undo) + audited. The freed code
   *  re-decodes/Needs-Review on the next scan. Returns the backup, or null if the product is unknown. */
  deleteProduct: (productId: string) => ProductDeleteBackup | null;
  /** One-time safe purge of poisoned duplicates (e.g. the 235 "Manstel" rows on 745125495781 and any
   *  non-protected product whose identity is the poison code). Reversible via the same Undo. Returns count. */
  purgePoisonedProducts: () => { removed: number; backup: ProductDeleteBackup | null };
  /** Restore the product(s) removed by the most recent delete/purge (exact restore). */
  undoDeleteProduct: () => boolean;
  /** P2 maintenance (platform, NOT auto-run): dry-run preview of products whose identifier fields are empty
   *  but whose NAME starts with "UPC <code> - " - the code that would backfill primaryBarcode/upc. */
  previewIdentifierBackfill: () => Array<{ productId: string; name: string; code: string }>;
  /** Fill empty primaryBarcode (+ upc for 12-digit) from the name prefix for the given products. Snapshots
   *  the prior values for Undo. Reversible, audited, never auto-run. Returns how many products changed. */
  applyIdentifierBackfill: (productIds: string[]) => { changed: number };
  /** Restore the identifier fields changed by the most recent backfill. */
  undoIdentifierBackfill: () => boolean;
}

function makeQueueItem(params: {
  idFactory: () => string;
  now: () => string;
  businessId: string;
  sessionId: string;
  entityType: PendingSyncItem["entityType"];
  entityId: string;
  operation: SyncOperation;
  payload: unknown;
  idempotencyKey: string;
  scanEventId: string | null;
}): PendingSyncItem {
  return {
    id: params.idFactory(),
    businessId: params.businessId,
    sessionId: params.sessionId,
    entityType: params.entityType,
    entityId: params.entityId,
    operation: params.operation,
    payload: params.payload,
    status: "pending",
    retryCount: 0,
    lastError: null,
    createdAt: params.now(),
    updatedAt: params.now(),
    idempotencyKey: params.idempotencyKey,
    scanEventId: params.scanEventId,
  };
}

/**
 * Multi-code: build an APPROVED alias for every OTHER scannable code on a product (part number / SKU /
 * GTIN / UPC / EAN / vendor codes), beyond the code(s) already aliased. This is what makes a tire's
 * barcode AND its part-number QR both resolve to the same product. Pure builder; caller commits to state.
 */
function buildProductCodeAliases(params: {
  product: Product;
  alreadyAliasedCleanCodes: string[];
  businessId: string;
  sessionId: string;
  idFactory: () => string;
  now: () => string;
}): { aliases: Alias[]; queued: PendingSyncItem[] } {
  const { product, alreadyAliasedCleanCodes, businessId, sessionId, idFactory, now } = params;
  const rawCodes = [
    product.primaryBarcode,
    product.primarySku,
    product.gtin,
    product.upc,
    product.ean,
    ...(product.vendorCodes ?? []),
  ];
  const seen = new Set(alreadyAliasedCleanCodes.filter(Boolean));
  const aliases: Alias[] = [];
  const queued: PendingSyncItem[] = [];
  for (const code of rawCodes) {
    if (!code) continue;
    const n = normalizeCode(code);
    const cleanCode = n.clean;
    if (!cleanCode || seen.has(cleanCode)) continue;
    seen.add(cleanCode);
    const aliasId = `alias-${idFactory()}`;
    const key = buildIdempotencyKey(businessId, sessionId, aliasId, "RESOLVE_ALIAS");
    const alias: Alias = {
      id: aliasId,
      businessId,
      productId: product.id,
      rawCodeExample: code,
      cleanCode,
      normalizedCode: n.noSeparators || cleanCode,
      aliasType: codeTypeToAliasType(detectCodeType(cleanCode)),
      source: product.source ?? "human_review",
      confidence: 1,
      approved: true,
      createdAt: now(),
      updatedAt: now(),
      createdBy: "multi_code",
      lastSeenAt: now(),
      syncStatus: "pending",
      idempotencyKey: key,
    };
    aliases.push(alias);
    queued.push(
      makeQueueItem({
        idFactory,
        now,
        businessId,
        sessionId,
        entityType: "Alias",
        entityId: aliasId,
        operation: "RESOLVE_ALIAS",
        payload: alias,
        idempotencyKey: key,
        scanEventId: null,
      }),
    );
  }
  return { aliases, queued };
}

/**
 * W2: build APPROVED aliases for an EXPLICIT list of human-selected discovered identifier codes, onto a
 * target product (new or existing). Dedupes against codes already aliased for that product (idempotent),
 * and NEVER overwrites a code that is an approved alias of a DIFFERENT product - those are returned as
 * conflicts for the caller to surface. Pure builder; caller commits to state.
 */
function buildAliasesForCodes(params: {
  product: Product;
  codes: string[];
  existingAliases: Alias[];
  businessId: string;
  sessionId: string;
  idFactory: () => string;
  now: () => string;
  approved?: boolean; // default true; pass false to persist a DISCOVERED (un-trusted) alias suggestion
  source?: Alias["source"];
  createdBy?: string;
}): { aliases: Alias[]; queued: PendingSyncItem[]; conflicts: { code: string; otherProductId: string }[] } {
  const { product, codes, existingAliases, businessId, sessionId, idFactory, now } = params;
  const approved = params.approved ?? true;
  const aliasSource = params.source ?? "human_review";
  const aliasCreatedBy = params.createdBy ?? "human";
  const ownCleanCodes = new Set(existingAliases.filter((a) => a.productId === product.id).map((a) => a.cleanCode));
  const aliases: Alias[] = [];
  const queued: PendingSyncItem[] = [];
  const conflicts: { code: string; otherProductId: string }[] = [];
  for (const raw of codes) {
    if (!raw) continue;
    const n = normalizeCode(raw);
    const cleanCode = n.clean;
    if (!cleanCode) continue;
    if (ownCleanCodes.has(cleanCode)) continue; // already aliased to THIS product -> idempotent skip
    const other = existingAliases.find((a) => a.cleanCode === cleanCode && a.productId !== product.id && a.approved);
    if (other) {
      conflicts.push({ code: cleanCode, otherProductId: other.productId });
      continue; // belongs to a DIFFERENT product -> never overwrite
    }
    ownCleanCodes.add(cleanCode);
    const aliasId = `alias-${idFactory()}`;
    const key = buildIdempotencyKey(businessId, sessionId, aliasId, "RESOLVE_ALIAS");
    const alias: Alias = {
      id: aliasId,
      businessId,
      productId: product.id,
      rawCodeExample: raw,
      cleanCode,
      normalizedCode: n.noSeparators || cleanCode,
      aliasType: codeTypeToAliasType(detectCodeType(cleanCode)),
      source: aliasSource,
      confidence: 1,
      approved,
      createdAt: now(),
      updatedAt: now(),
      createdBy: aliasCreatedBy,
      lastSeenAt: now(),
      syncStatus: "pending",
      idempotencyKey: key,
    };
    aliases.push(alias);
    queued.push(
      makeQueueItem({
        idFactory,
        now,
        businessId,
        sessionId,
        entityType: "Alias",
        entityId: aliasId,
        operation: "RESOLVE_ALIAS",
        payload: alias,
        idempotencyKey: key,
        scanEventId: null,
      }),
    );
  }
  return { aliases, queued, conflicts };
}

/** Recompute syncStatus on feed/counts/reviews from what remains in the pending queue. */
function recomputeSyncStatus(state: {
  scanFeed: ScanEvent[];
  finalCounts: InventoryCount[];
  needsReviewQueue: UnknownCodeReview[];
  pendingSyncQueue: PendingSyncItem[];
}) {
  const pendingEventIds = new Set(
    state.pendingSyncQueue.map((p) => p.scanEventId).filter((x): x is string => !!x),
  );
  const erroredEventIds = new Set(
    state.pendingSyncQueue
      .filter((p) => p.status === "error")
      .map((p) => p.scanEventId)
      .filter((x): x is string => !!x),
  );
  const pendingProductIds = new Set(
    state.pendingSyncQueue
      .filter((p) => p.operation === "INCREMENT_COUNT")
      .map((p) => (p.payload as IncrementPayload).productId),
  );

  const statusFor = (eventId: string): ScanEvent["syncStatus"] =>
    pendingEventIds.has(eventId) ? (erroredEventIds.has(eventId) ? "error" : "pending") : "synced";

  return {
    scanFeed: state.scanFeed.map((e) => ({ ...e, syncStatus: statusFor(e.id) })),
    finalCounts: state.finalCounts.map((c) => ({
      ...c,
      syncStatus: pendingProductIds.has(c.productId) ? ("pending" as const) : ("synced" as const),
    })),
    needsReviewQueue: state.needsReviewQueue.map((r) => ({
      ...r,
      syncStatus: pendingEventIds.has(idForReview(r)) ? ("pending" as const) : ("synced" as const),
    })),
  };
}

// reviews are keyed to their originating scan event via idempotencyKey's event segment;
// we stash the scanEventId on the review's idempotencyKey, so derive it back here.
function idForReview(r: UnknownCodeReview): string {
  const parts = r.idempotencyKey.split(":");
  return parts[2] ?? r.id;
}

export function buildScanInitializer(deps: ScanStoreDeps) {
  const { db, idFactory, now } = deps;
  const cloudBackend = deps.cloudBackend ?? false;

  return (
    set: (partial: Partial<ScanState> | ((s: ScanState) => Partial<ScanState>)) => void,
    get: () => ScanState,
  ): ScanState => {
    const seed = getSeed();

    const enqueueAndSync = (items: PendingSyncItem[]) => {
      set((s) => ({ pendingSyncQueue: [...s.pendingSyncQueue, ...items] }));
      // Optimistic UI is already updated by the caller; attempt sync afterward.
      get().syncPending();
    };

    // Fire-and-forget audit. NEVER blocks or throws into the scanner/UI. Only emits with a REAL business
    // context (no fake businessId/actor); a no-op when no audit sink is wired (mock/default path).
    const emitAudit = (e: { entityType: string; entityId: string; action: string; metadata?: Record<string, unknown> }) => {
      const { businessId, userId, businessContextReady } = get();
      if (!deps.audit || !businessContextReady || !userId || !businessId) return;
      try {
        deps.audit({ businessId, actorUserId: userId, ...e });
      } catch {
        // An audit failure must never break the scanner or any action. Swallow it.
      }
    };

    // Serialize cloud drains: rapid scans each call syncPending, and overlapping async drains would
    // contend on the same _appliedKeys doc (self-inflicted "already-exists"). A promise-chain mutex runs
    // each drain after the previous completes; every enqueue still triggers a drain that picks up the
    // latest queue. Per-item idempotency (transaction + ledger) remains the guarantee against true retries.
    let drainChain: Promise<void> = Promise.resolve();
    const syncPendingCloud = (force: boolean): Promise<void> => {
      drainChain = drainChain.then(() => drainCloudOnce(force)).catch(() => {});
      return drainChain;
    };

    // Cloud drain (one pass): async, awaits db.apply, and REQUIRES a real business context first (no
    // fake/default business writes). The mock/local path keeps the original SYNCHRONOUS syncPending below.
    const drainCloudOnce = async (force: boolean) => {
      const state = get();
      if (!state.online && !force) return;
      if (state.pendingSyncQueue.length === 0) return;
      if (!state.businessContextReady || !state.userId || !state.businessId) {
        set({ lastSyncError: "Select or create a business before syncing to the cloud." });
        return; // pause: keep everything pending, write nothing
      }
      // Snapshot the batch to process. We must NOT overwrite the whole queue at the end (items enqueued
      // by rapid scans DURING this async loop would be clobbered + silently lost). Instead, track this
      // batch's outcome by item id and reconcile against the LATEST queue, preserving anything new.
      const batch = state.pendingSyncQueue;
      const syncedIds = new Set(get().syncedScanEventIds);
      const appliedIds = new Set<string>();
      const erroredById = new Map<string, PendingSyncItem>();
      let lastErr: string | null = null;
      for (const item of batch) {
        let res;
        try {
          res = await db.apply(item);
        } catch (e) {
          res = { ok: false, alreadyApplied: false, error: e instanceof Error ? e.message : String(e) };
        }
        if (res.ok) {
          appliedIds.add(item.id);
          if (item.scanEventId) syncedIds.add(item.scanEventId);
        } else {
          erroredById.set(item.id, { ...item, status: "error", retryCount: item.retryCount + 1, lastError: res.error ?? "sync failed", updatedAt: now() });
          lastErr = res.error ?? "sync failed";
        }
      }
      set((cur) => {
        // Reconcile against the CURRENT queue: drop applied items, replace errored with their updated
        // version, and KEEP any items enqueued while this pass was awaiting (the mutex's next pass drains
        // them). This avoids the read-modify-write race that previously dropped concurrent scans.
        const nextQueue = cur.pendingSyncQueue
          .filter((it) => !appliedIds.has(it.id))
          .map((it) => erroredById.get(it.id) ?? it);
        const recomputed = recomputeSyncStatus({
          scanFeed: cur.scanFeed,
          finalCounts: cur.finalCounts,
          needsReviewQueue: cur.needsReviewQueue,
          pendingSyncQueue: nextQueue,
        });
        return { pendingSyncQueue: nextQueue, syncedScanEventIds: [...syncedIds], lastSyncError: lastErr, ...recomputed };
      });
    };

    return {
      businessId: DEMO_BUSINESS_ID,
      userId: null,
      // Mock/local path needs no business context; cloud path must wait for setBusinessContext().
      businessContextReady: !cloudBackend,
      businessDataLoaded: !cloudBackend, // mock path has no remote data to load

      sessionId: "session-1",
      currentSession: {
        id: "session-1",
        businessId: DEMO_BUSINESS_ID,
        name: "Default Session",
        location: "Main",
        status: "active",
        startedAt: now(),
        completedAt: null,
        createdBy: "demo",
        notes: "",
        syncStatus: "synced",
      },
      settings: DEFAULT_SETTINGS,
      products: seed.products,
      aliases: seed.aliases,
      scanFeed: [],
      finalCounts: [],
      needsReviewQueue: [],
      pendingSyncQueue: [],
      syncedScanEventIds: [],
      online: true,
      simulateSyncFailure: false,
      lastSyncError: null,
      lastMismatchWarning: null,
      lastAliasConflicts: null,
      lastCategoryWarning: null,
      aiLookupLogs: [],
      breaker: initBreaker(),
      aiStatus: { ...DEFAULT_AI_STATUS },
      catalog: [],
      shopOverrides: [],
      feedbackEvents: [],
      lastCleanupBackup: null,
      lastProductDeleteBackup: null,
      lastIdentifierBackfill: null,
      _hasHydrated: deps.persistName ? false : true,

      setHasHydrated: (v) => set({ _hasHydrated: v }),

      setBusinessContext: (businessId, userId) => {
        const needsLoad = cloudBackend && !!deps.loadBusinessData;
        set({ businessId, userId, businessContextReady: true, businessDataLoaded: !needsLoad, lastSyncError: null });
        const loader = deps.loadBusinessData;
        if (cloudBackend && loader) {
          // Load THIS business's products/aliases from Firestore (replace, never merge another tenant's
          // data), then drain anything queued. Failure is surfaced, not fatal to the local UI.
          void (async () => {
            try {
              const data = await loader(businessId, userId);
              // Reconstruct the active count session + its finalCounts (survive-refresh). Prefer the most
              // recent ACTIVE session; else the most recent overall. finalCounts are the persisted count
              // lines for that session, mapped back to store shape. No session -> keep current defaults.
              const byStartedAtDesc = (a: InventorySession, b: InventorySession) =>
                (b.startedAt ?? "").localeCompare(a.startedAt ?? "");
              const sessions = [...data.sessions].sort(byStartedAtDesc);
              const restored = sessions.find((s) => s.status === "active") ?? sessions[0] ?? null;
              const next: Partial<ScanState> = { products: data.products, aliases: data.aliases };
              if (restored) {
                next.currentSession = restored;
                next.sessionId = restored.id;
                next.finalCounts = data.counts.filter((c) => c.sessionId === restored.id);
              }
              next.businessDataLoaded = true;
              set(next);
            } catch (e) {
              // Surface the error but mark loaded so the UI does not hang forever (sync still paused on error).
              set({ lastSyncError: e instanceof Error ? e.message : "Failed to load business data", businessDataLoaded: true });
            }
            get().syncPending();
          })();
        } else {
          get().syncPending(); // drain anything queued now that we have a real business context
        }
      },

      recordFeedback: (type, payload) =>
        set((s) => ({
          feedbackEvents: appendFeedback(s.feedbackEvents, {
            id: idFactory(),
            businessId: s.businessId,
            type,
            code: payload.code,
            productId: payload.productId ?? null,
            at: now(),
            meta: payload.meta,
          }),
        })),

      startSession: (name, location) => {
        const id = `session-${idFactory()}`;
        const businessId = get().businessId;
        const session: InventorySession = {
          id,
          businessId,
          name: name || "Session",
          location: location || "Main",
          status: "active",
          startedAt: now(),
          completedAt: null,
          createdBy: get().userId ?? "demo",
          notes: "",
          syncStatus: "synced",
        };
        set({
          sessionId: id,
          currentSession: session,
          scanFeed: [],
          finalCounts: [],
          needsReviewQueue: [],
          pendingSyncQueue: [],
          syncedScanEventIds: [],
          lastSyncError: null,
        });
        // Persist the session through the SAME durable queue as scans/counts (never blocks the UI).
        // Distinct idempotency key per lifecycle state ("active") so finishSession's write still applies.
        enqueueAndSync([
          makeQueueItem({
            idFactory,
            now,
            businessId,
            sessionId: id,
            entityType: "CountSession",
            entityId: id,
            operation: "SAVE_SESSION",
            payload: session,
            idempotencyKey: buildIdempotencyKey(businessId, id, `${id}-active`, "SAVE_SESSION"),
            scanEventId: null,
          }),
        ]);
        emitAudit({ entityType: "CountSession", entityId: id, action: "session_started", metadata: { name: session.name, location: session.location } });
      },

      finishSession: () => {
        const cur = get().currentSession;
        if (!cur) return;
        const completed: InventorySession = { ...cur, status: "completed", completedAt: now() };
        set({ currentSession: completed });
        enqueueAndSync([
          makeQueueItem({
            idFactory,
            now,
            businessId: completed.businessId,
            sessionId: completed.id,
            entityType: "CountSession",
            entityId: completed.id,
            operation: "SAVE_SESSION",
            payload: completed,
            // Distinct key from the "active" write so the completed state is not deduped as alreadyApplied.
            idempotencyKey: buildIdempotencyKey(completed.businessId, completed.id, `${completed.id}-completed`, "SAVE_SESSION"),
            scanEventId: null,
          }),
        ]);
        emitAudit({ entityType: "CountSession", entityId: completed.id, action: "session_completed", metadata: { completedAt: completed.completedAt } });
      },

      processScan: (rawInput) => {
        const cleaned = cleanScanCode(rawInput);
        if (!cleaned.cleanCode) return null;

        const { products, aliases, businessId, sessionId } = get();
        // Deterministic resolver only. AI is never consulted here. Known requires verified/approved.
        const resolution = resolveScan(cleaned, products, aliases, businessId);
        const scanEventId = idFactory();
        const createdAt = now();
        const keyFor = (op: SyncOperation) =>
          buildIdempotencyKey(businessId, sessionId, scanEventId, op);

        const isKnown = resolution.resolverStatus === "known" && !!resolution.productId;
        // Phase 8C SIDE-DOOR FIREWALL: a deterministic "known" match (approved alias or verified product)
        // can still carry a POISONED identity - e.g. a verified product whose primaryBarcode is a tire UPC
        // that a public source mislabels as a rivet kit. The original firewall only ran inside the AI
        // decode path, so such a match would auto-count with NO AI and NO firewall. Re-check the matched
        // product's domain against the scan context; on conflict it must NOT count -> route to Needs Review.
        const matchedProduct = resolution.productId
          ? products.find((p) => p.id === resolution.productId)
          : undefined;
        const knownConflict = isKnown
          ? detectIdentityContextConflict(get().settings.scanContext ?? "any", matchedProduct)
          : null;
        const countable = isKnown && !knownConflict;
        if (knownConflict === "category_context_conflict") {
          // Phase 9: surface the non-blocking category warning banner (the scan still routes to review).
          set({ lastCategoryWarning: { code: cleaned.cleanCode, productName: matchedProduct?.name ?? "this product", reason: knownConflict } });
        }

        const event: ScanEvent = {
          id: scanEventId,
          businessId,
          sessionId,
          rawCode: cleaned.rawCode,
          cleanCode: cleaned.cleanCode,
          normalizedCandidates: cleaned.normalizedCandidates,
          matchedProductId: resolution.productId,
          matchType: resolution.matchType,
          status: countable ? "known" : resolution.resolverStatus === "conflict" ? "conflict" : "needs_review",
          resolverStatus: resolution.resolverStatus,
          codeType: resolution.codeType,
          reason: resolution.reason,
          quantityDelta: countable ? 1 : 0,
          quantityAfterScan: 0,
          createdAt,
          source: "scan",
          notes: resolution.reason,
          syncStatus: "pending",
          idempotencyKey: keyFor("INCREMENT_COUNT"),
          syncError: null,
        };

        if (countable && resolution.productId) {
          // Deterministic increment in local state FIRST (instant UI, no server round-trip).
          const { counts, count } = incrementInventoryCount(get().finalCounts, event, idFactory);
          event.quantityAfterScan = count.quantity;

          set((s) => ({
            scanFeed: [event, ...s.scanFeed],
            finalCounts: counts,
          }));

          const incPayload: IncrementPayload = {
            businessId,
            sessionId,
            productId: resolution.productId,
            scanEventId,
            quantityDelta: 1,
            idempotencyKey: keyFor("INCREMENT_COUNT"),
          };
          enqueueAndSync([
            makeQueueItem({
              idFactory,
              now,
              businessId,
              sessionId,
              entityType: "ScanEvent",
              entityId: scanEventId,
              operation: "SAVE_SCAN_EVENT",
              payload: event,
              idempotencyKey: keyFor("SAVE_SCAN_EVENT"),
              scanEventId,
            }),
            makeQueueItem({
              idFactory,
              now,
              businessId,
              sessionId,
              entityType: "InventoryCount",
              entityId: count.id,
              operation: "INCREMENT_COUNT",
              payload: incPayload,
              idempotencyKey: keyFor("INCREMENT_COUNT"),
              scanEventId,
            }),
          ]);
          return event;
        }

        if (isKnown && knownConflict && resolution.productId) {
          // SIDE-DOOR FIREWALL block: the matched product contradicts the tire scan context (a poisoned
          // identity reached via the deterministic path). Do NOT count. Surface it for human relink,
          // carrying the suspect product so the owner sees what it WOULD have been. No AI is run here -
          // re-decoding would just return the same poisoned public source.
          const conflictText = conflictReason(knownConflict);
          event.decodeStatus = "needs_review";
          event.reason = conflictText;
          event.notes = conflictText;
          set((s) => ({ scanFeed: [event, ...s.scanFeed] }));
          const alreadyOpen = get().needsReviewQueue.find(
            (r) => r.cleanCode === cleaned.cleanCode && r.status === "open",
          );
          if (!alreadyOpen) {
            const review: UnknownCodeReview = {
              id: idFactory(),
              businessId,
              sessionId,
              rawCode: cleaned.rawCode,
              cleanCode: cleaned.cleanCode,
              normalizedCandidates: cleaned.normalizedCandidates,
              suggestedProductName: matchedProduct?.name ?? "",
              suggestedBrand: matchedProduct?.brand ?? "",
              suggestedCategory: matchedProduct?.category ?? "",
              suggestedSpecsShort: matchedProduct?.specsShort ?? "",
              suggestedSpecsFull: matchedProduct?.specsFull ?? "",
              suggestedPrimarySku: matchedProduct?.primarySku ?? "",
              suggestedPrimaryBarcode: matchedProduct?.primaryBarcode ?? "",
              suggestedGtin: matchedProduct?.gtin ?? "",
              suggestedUpc: matchedProduct?.upc ?? "",
              suggestedEan: matchedProduct?.ean ?? "",
              suggestedImageUrl: "",
              suggestedProductUrl: "",
              suggestedAliases: [],
              sourceUrls: [],
              verifiedFacts: [],
              guesses: [],
              reason: conflictText,
              providerName: "",
              confidence: 0,
              hasSuggestion: !!matchedProduct,
              decodeStatus: "needs_review",
              evidenceStrength: "none",
              exactCodeEvidenceVerifiedByApp: false,
              crossCheckDecision: "",
              status: "open",
              createdAt,
              resolvedAt: null,
              resolvedBy: null,
              resolutionAction: null,
              syncStatus: "pending",
              idempotencyKey: keyFor("SAVE_UNKNOWN_SCAN"),
            };
            set((s) => ({ needsReviewQueue: [...s.needsReviewQueue, review] }));
            enqueueAndSync([
              makeQueueItem({
                idFactory,
                now,
                businessId,
                sessionId,
                entityType: "UnknownCodeReview",
                entityId: review.id,
                operation: "SAVE_UNKNOWN_SCAN",
                payload: review,
                idempotencyKey: keyFor("SAVE_UNKNOWN_SCAN"),
                scanEventId,
              }),
            ]);
            emitAudit({
              entityType: "UnknownCodeReview",
              entityId: review.id,
              action: "context_conflict_blocked",
              metadata: { code: cleaned.cleanCode, productId: resolution.productId, kind: knownConflict },
            });
          }
          get().recordFeedback("conflict_detected", { code: cleaned.cleanCode });
          return event;
        }

        // Unknown or conflict. AGGRESSIVE AUTO DECODE: if AI is on and a key is configured, run the
        // live decode pipeline automatically instead of dropping straight to passive Needs Review.
        const settings = get().settings;
        const today = createdAt.slice(0, 10);
        const dailyCount = settings.lastResetDate === today ? settings.dailyLookupCount : 0;
        const autoGate = evaluateAutoDecode({
          aiEnabled: settings.aiLookupEnabled,
          status: get().aiStatus,
          online: get().online,
          dailyCount,
          dailyLimit: settings.dailyLookupLimit,
          breaker: get().breaker,
          now: new Date(createdAt).getTime(),
        });

        const existingOpen = get().needsReviewQueue.find(
          (r) => r.cleanCode === cleaned.cleanCode && r.status === "open",
        );

        // Customer-safe split: the feed REASON is the deterministic resolver explanation only (product-
        // facing, no AI/provider/Settings mechanics). The auto-decode "why" (e.g. lookup not configured)
        // goes to decodeNote, which LiveScanFeed shows ONLY to platformOwner. The internal gate reason
        // text is unchanged (still used for aiLookupLogs/diagnostics).
        event.decodeStatus = existingOpen?.decodeStatus ?? (autoGate.allowed ? "decoding" : "needs_review");
        event.reason = existingOpen?.reason ?? resolution.reason;
        event.decodeNote = existingOpen?.decodeNote ?? autoGate.reason;

        set((s) => ({ scanFeed: [event, ...s.scanFeed] }));

        if (!existingOpen) {
          const review: UnknownCodeReview = {
            id: idFactory(),
            businessId,
            sessionId,
            rawCode: cleaned.rawCode,
            cleanCode: cleaned.cleanCode,
            normalizedCandidates: cleaned.normalizedCandidates,
            suggestedProductName: "",
            suggestedBrand: "",
            suggestedCategory: "",
            suggestedSpecsShort: "",
            suggestedSpecsFull: "",
            suggestedPrimarySku: "",
            suggestedPrimaryBarcode: "",
            suggestedGtin: "",
            suggestedUpc: "",
            suggestedEan: "",
            suggestedImageUrl: "",
            suggestedProductUrl: "",
            suggestedAliases: [],
            sourceUrls: [],
            verifiedFacts: [],
            guesses: [],
            reason: resolution.reason,
            decodeNote: autoGate.reason,
            providerName: resolution.resolverStatus === "conflict" ? "conflict" : "",
            confidence: 0,
            hasSuggestion: false,
            decodeStatus: autoGate.allowed ? "decoding" : "needs_review",
            evidenceStrength: "none",
            exactCodeEvidenceVerifiedByApp: false,
            crossCheckDecision: "",
            status: "open",
            createdAt,
            resolvedAt: null,
            resolvedBy: null,
            resolutionAction: null,
            syncStatus: "pending",
            idempotencyKey: keyFor("SAVE_UNKNOWN_SCAN"),
          };
          set((s) => ({ needsReviewQueue: [...s.needsReviewQueue, review] }));
          enqueueAndSync([
            makeQueueItem({
              idFactory,
              now,
              businessId,
              sessionId,
              entityType: "UnknownCodeReview",
              entityId: review.id,
              operation: "SAVE_UNKNOWN_SCAN",
              payload: review,
              idempotencyKey: keyFor("SAVE_UNKNOWN_SCAN"),
              scanEventId,
            }),
          ]);
          emitAudit({ entityType: "UnknownCodeReview", entityId: review.id, action: "unknown_review_created", metadata: { code: cleaned.cleanCode } });

          if (resolution.resolverStatus === "conflict") {
            get().recordFeedback("conflict_detected", { code: cleaned.cleanCode });
          }

          // CATALOG-FIRST (offline-first, saves AI tokens): private shop override -> verified shared
          // catalog. A verified hit resolves + counts with NO AI, even with no key / offline. AI only
          // runs on a miss or a weak/conflicting catalog hit.
          const codes = [cleaned.cleanCode, ...cleaned.normalizedCandidates];
          const decision = decideLookup(get().catalog, get().shopOverrides, codes, businessId);
          // Phase 8C: a verified-catalog / shop-override hit is also a NON-AI auto-count path - apply the
          // same context firewall. A clearly non-tire hit in tire context must not shortcut-count; let it
          // fall through to the AI decode path (where the firewall + human review handle it).
          const catalogConflict = decision.hit
            ? detectIdentityContextConflict(get().settings.scanContext ?? "any", decision.hit)
            : null;
          if (decision.shouldResolveWithoutAi && decision.hit && !catalogConflict) {
            const fromOverride = decision.source === "shop_override";
            get().recordFeedback(fromOverride ? "found_from_override" : "found_from_catalog", {
              code: cleaned.cleanCode,
            });
            if (decision.source === "verified_catalog") {
              set({ catalog: observeScan(get().catalog, codes, now()) });
            }
            set((s) => ({
              scanFeed: s.scanFeed.map((e) =>
                e.cleanCode === cleaned.cleanCode &&
                (e.decodeStatus === "decoding" || e.decodeStatus === "needs_review")
                  ? { ...e, decodeStatus: "verified", reason: `Matched from ${fromOverride ? "shop override" : "verified catalog"} - no AI used.` }
                  : e,
              ),
            }));
            get().resolveUnknown(review.id, "create_new", {
              applyToCount: true,
              origin: "catalog",
              newProduct: {
                name: decision.hit.name,
                brand: decision.hit.brand,
                category: decision.hit.category,
                imageUrl: decision.hit.imageUrl,
                productUrl: decision.hit.productUrl,
                primaryBarcode: cleaned.cleanCode,
                source: "catalog",
              },
            });
            return event;
          }

          // Fall back to live AI decode (subject to the existing gate). A human still approves anything
          // not auto-accepted. AI is never called for a known/approved scan or a verified catalog hit.
          // Option 1 wiring: if the cloud dep is present and we're online, try the global catalog first;
          // cloudCatalogResolve falls through to AI internally on a miss / firewall conflict.
          if (deps.lookupGlobalCatalog && get().online) {
            void get().cloudCatalogResolve(review.id, codes);
          } else if (autoGate.allowed) {
            void get().liveDecode(review.id);
          }
        }
        return event;
      },

      syncPending: (force = false) => {
        // Cloud backend: async drain (preserves the local optimistic UI; never blocks the scan input).
        if (cloudBackend) {
          void syncPendingCloud(force);
          return;
        }
        const state = get();
        if (!state.online && !force) return; // offline: keep everything pending, lose nothing
        if (state.pendingSyncQueue.length === 0) return;

        db.setFailure(state.simulateSyncFailure ? "always" : "none");

        const stillPending: PendingSyncItem[] = [];
        const syncedIds = new Set(state.syncedScanEventIds);
        let lastErr: string | null = null;

        for (const item of state.pendingSyncQueue) {
          // This branch only runs for the local mock backend (cloudBackend === false), whose apply() is
          // synchronous, so the cast is safe.
          const res = db.apply(item) as SyncResult;
          if (res.ok) {
            if (item.scanEventId) syncedIds.add(item.scanEventId);
          } else {
            stillPending.push({
              ...item,
              status: "error",
              retryCount: item.retryCount + 1,
              lastError: res.error ?? "sync failed",
              updatedAt: now(),
            });
            lastErr = res.error ?? "sync failed";
          }
        }

        const recomputed = recomputeSyncStatus({
          scanFeed: state.scanFeed,
          finalCounts: state.finalCounts,
          needsReviewQueue: state.needsReviewQueue,
          pendingSyncQueue: stillPending,
        });

        set({
          pendingSyncQueue: stillPending,
          syncedScanEventIds: [...syncedIds],
          lastSyncError: lastErr,
          ...recomputed,
        });
      },

      retrySync: () => get().syncPending(true),

      setOnline: (online) => {
        set({ online });
        if (online) get().syncPending(true);
      },

      setSimulateSyncFailure: (on) => set({ simulateSyncFailure: on }),

      setAiStatus: (partial) => set((s) => ({ aiStatus: { ...s.aiStatus, ...partial } })),

      setEmergencyStop: (on) => set((s) => ({ aiStatus: { ...s.aiStatus, emergencyStop: on } })),

      refreshAiStatus: async () => {
        // Ask the server which keys/flags are configured (no secrets are returned).
        try {
          const res = await fetch("/api/ai-lookup", { method: "GET" });
          if (!res.ok) return;
          const d = await res.json();
          set((s) => {
            const keyConfigured = Boolean(d.geminiConfigured) || Boolean(d.openaiConfigured);
            return {
              aiStatus: {
                ...s.aiStatus,
                liveEnabled: Boolean(d.liveEnabled),
                autoDecodeOnScan: Boolean(d.autoDecodeOnScan),
                geminiEnabled: Boolean(d.geminiEnabled),
                openaiEnabled: Boolean(d.openaiEnabled),
                geminiConfigured: Boolean(d.geminiConfigured),
                openaiConfigured: Boolean(d.openaiConfigured),
                premiumFallback: Boolean(d.premiumFallback),
                mode: typeof d.mode === "string" ? d.mode : s.aiStatus.mode,
                dailyLimit: typeof d.dailyLimit === "number" ? d.dailyLimit : s.aiStatus.dailyLimit,
                missingKeys: Array.isArray(d.missingKeys) ? d.missingKeys : s.aiStatus.missingKeys,
              },
              // Live AI config is SERVER-AUTHORITATIVE so a stale persisted client value can't disable lookup
              // or pin an old daily cap. When the server confirms a provider key, force lookup ON (always-on),
              // adopt the server daily cap (AI_LOOKUP_DAILY_LIMIT), and set Gemini-first -> OpenAI fallback.
              settings: {
                ...s.settings,
                aiLookupEnabled: keyConfigured ? true : s.settings.aiLookupEnabled,
                dailyLookupLimit: typeof d.dailyLimit === "number" ? d.dailyLimit : s.settings.dailyLookupLimit,
                primaryProvider: d.geminiConfigured ? "gemini" : d.openaiConfigured ? "openai" : s.settings.primaryProvider,
                fallbackProvider: d.openaiConfigured ? "openai" : s.settings.fallbackProvider,
              },
            };
          });
        } catch {
          // leave existing status; auto-decode simply won't fire without confirmed keys
        }
      },

      updateSettings: (partial) => set((s) => ({ settings: { ...s.settings, ...partial } })),

      lookupUnknown: async (reviewId) => {
        const state = get();
        const review = state.needsReviewQueue.find((r) => r.id === reviewId);
        if (!review || review.status !== "open") return;

        const s = state.settings;
        const nowIso = now();
        const today = nowIso.slice(0, 10);
        const nowMs = new Date(nowIso).getTime();
        const dailyCount = s.lastResetDate === today ? s.dailyLookupCount : 0;

        const log = (
          status: AiLookupLog["status"],
          providerName: string,
          confidence: number,
          breakerState: BreakerState,
        ): AiLookupLog => ({
          id: idFactory(),
          businessId: state.businessId,
          rawCode: review.rawCode,
          cleanCode: review.cleanCode,
          providerName,
          status,
          confidence,
          estimatedInputTokens: 0,
          estimatedOutputTokens: 0,
          estimatedCost: 0,
          cacheHit: false,
          circuitBreakerState: breakerState.state,
          createdAt: nowIso,
        });

        const gate = evaluateAiGate({
          enabled: s.aiLookupEnabled,
          online: state.online,
          dailyCount,
          dailyLimit: s.dailyLookupLimit,
          breaker: state.breaker,
          now: nowMs,
        });

        if (!gate.allowed) {
          // Never fail silently: log the block and leave the code in Needs Review.
          const blockStatus: Record<AiGateReason, AiLookupLog["status"]> = {
            ok: "success",
            disabled: "blocked_cap",
            offline: "blocked_offline",
            daily_cap: "blocked_cap",
            circuit_open: "blocked_cap",
          };
          set((st) => ({
            aiLookupLogs: [log(blockStatus[gate.reason], s.primaryProvider, 0, gate.breaker), ...st.aiLookupLogs],
            breaker: gate.breaker,
            settings: { ...st.settings, dailyLookupCount: dailyCount, lastResetDate: today },
          }));
          return;
        }

        // Sanitize before the AI ever sees the data (defense in depth; the server re-sanitizes too).
        const rawCodeSanitized = sanitizeForAiLookup(review.rawCode).clean;
        const cleanCodeSanitized = sanitizeForAiLookup(review.cleanCode).clean;

        try {
          const res = await fetch("/api/ai-lookup", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              rawCode: rawCodeSanitized,
              cleanCode: cleanCodeSanitized,
              provider: s.primaryProvider,
              allowImageSuggestions: s.allowImageSuggestions,
            }),
          });
          if (!res.ok) throw new Error(`lookup failed ${res.status}`);
          const data = (await res.json()) as { providerName: string; result: AiLookupResult };
          const result = data.result;

          set((st) => ({
            needsReviewQueue: st.needsReviewQueue.map((r) =>
              r.id === reviewId
                ? {
                    ...r,
                    suggestedProductName: result.productName,
                    suggestedBrand: result.brand,
                    suggestedCategory: result.category,
                    suggestedSpecsShort: result.specsShort,
                    suggestedSpecsFull: result.specsFull,
                    suggestedPrimarySku: result.primarySku,
                    suggestedPrimaryBarcode: result.primaryBarcode,
                    suggestedGtin: result.gtin,
                    suggestedUpc: result.upc,
                    suggestedEan: result.ean,
                    suggestedImageUrl: result.imageUrl,
                    suggestedProductUrl: result.productUrl,
                    suggestedAliases: result.aliases,
                    sourceUrls: result.sourceUrls,
                    verifiedFacts: result.verifiedFacts,
                    guesses: result.guesses,
                    reason: result.needsHumanReview
                      ? "AI suggestion (low confidence). Confirm the real product before saving."
                      : "AI suggestion. Review the facts and approve to save the alias.",
                    providerName: data.providerName,
                    confidence: result.confidence,
                    hasSuggestion: true,
                  }
                : r,
            ),
            aiLookupLogs: [log("success", data.providerName, result.confidence, recordSuccess()), ...st.aiLookupLogs],
            breaker: recordSuccess(),
            settings: { ...st.settings, dailyLookupCount: dailyCount + 1, lastResetDate: today },
          }));

          // TRUST BOUNDARY: an AI result is only ever a SUGGESTION attached to the review item.
          // It is NEVER auto-saved as an alias and NEVER counted. A human must approve it via the
          // Needs Review actions. This is the fix for the wrong-product bug.
        } catch {
          const nextBreaker = recordFailure(gate.breaker, nowMs);
          set((st) => ({
            aiLookupLogs: [log("error", s.primaryProvider, 0, nextBreaker), ...st.aiLookupLogs],
            breaker: nextBreaker,
            settings: { ...st.settings, dailyLookupCount: dailyCount, lastResetDate: today },
          }));
        }
      },

      cloudCatalogResolve: async (reviewId, codes) => {
        if (!deps.lookupGlobalCatalog) return;
        let entry: CatalogEntry | null = null;
        try {
          entry = await deps.lookupGlobalCatalog(codes);
        } catch {
          // Cloud lookup failure must never break the scanner. Fall through to AI.
        }
        // Re-read review after the async round-trip: the user may have already resolved it.
        const review = get().needsReviewQueue.find((r) => r.id === reviewId);
        if (!review || review.status !== "open") return;

        const scanContext = get().settings.scanContext ?? "any";
        if (entry && entry.verificationStatus === "verified") {
          // Build a CatalogHit for the Phase-8C identity-context firewall check.
          const hit: CatalogHit = {
            source: "verified_catalog",
            name: entry.name,
            brand: entry.brand ?? "",
            category: entry.category ?? "",
            size: entry.size ?? "",
            imageUrl: entry.imageUrl ?? "",
            productUrl: entry.sourceUrls?.[0] ?? "",
            confidence: entry.confidence ?? 0.9,
            verified: true,
          };
          const hasConflict = detectIdentityContextConflict(scanContext, hit);
          if (!hasConflict) {
            // Cache into in-memory catalog so repeat scans are instant (no second cloud round-trip).
            set((s) => ({ catalog: [...s.catalog, entry!] }));
            get().recordFeedback("found_from_catalog", { code: review.cleanCode });
            set((s) => ({
              scanFeed: s.scanFeed.map((e) =>
                e.cleanCode === review.cleanCode &&
                (e.decodeStatus === "decoding" || e.decodeStatus === "needs_review")
                  ? { ...e, decodeStatus: "verified" as const, reason: "Matched from global catalog - no AI used." }
                  : e,
              ),
            }));
            get().resolveUnknown(reviewId, "create_new", {
              applyToCount: true,
              origin: "catalog",
              newProduct: {
                name: entry.name,
                brand: entry.brand,
                category: entry.category,
                imageUrl: entry.imageUrl,
                productUrl: entry.sourceUrls?.[0],
                primaryBarcode: review.cleanCode,
                source: "catalog",
              },
            });
            return;
          }
          // Firewall conflict: fall through to AI below (same as a miss).
        }
        // Cloud miss, pending/unverified, or firewall conflict -> fall back to AI if the gate allows.
        const state = get();
        const s = state.settings;
        const nowMs = Date.now();
        const today = now().slice(0, 10);
        const dailyCount = s.lastResetDate === today ? s.dailyLookupCount : 0;
        const autoGate = evaluateAutoDecode({
          aiEnabled: s.aiLookupEnabled,
          status: state.aiStatus,
          online: state.online,
          dailyCount,
          dailyLimit: s.dailyLookupLimit,
          breaker: state.breaker,
          now: nowMs,
        });
        if (autoGate.allowed) void get().liveDecode(reviewId);
      },

      liveDecode: async (reviewId) => {
        const state = get();
        const review = state.needsReviewQueue.find((r) => r.id === reviewId);
        if (!review || review.status !== "open") return;

        const s = state.settings;
        const nowIso = now();
        const today = nowIso.slice(0, 10);
        const nowMs = new Date(nowIso).getTime();
        const dailyCount = s.lastResetDate === today ? s.dailyLookupCount : 0;

        const mkLog = (
          status: AiLookupLog["status"],
          providerName: string,
          confidence: number,
          breakerState: BreakerState,
        ): AiLookupLog => ({
          id: idFactory(),
          businessId: state.businessId,
          rawCode: review.rawCode,
          cleanCode: review.cleanCode,
          providerName,
          status,
          confidence,
          estimatedInputTokens: 0,
          estimatedOutputTokens: 0,
          estimatedCost: 0,
          cacheHit: false,
          circuitBreakerState: breakerState.state,
          createdAt: nowIso,
        });

        const gate = evaluateAiGate({
          enabled: s.aiLookupEnabled,
          online: state.online,
          dailyCount,
          dailyLimit: s.dailyLookupLimit,
          breaker: state.breaker,
          now: nowMs,
        });
        if (!gate.allowed) {
          const blockStatus: AiLookupLog["status"] = gate.reason === "offline" ? "blocked_offline" : "blocked_cap";
          set((st) => ({
            aiLookupLogs: [mkLog(blockStatus, s.primaryProvider, 0, gate.breaker), ...st.aiLookupLogs],
            breaker: gate.breaker,
            settings: { ...st.settings, dailyLookupCount: dailyCount, lastResetDate: today },
          }));
          return;
        }

        const rawCodeSanitized = sanitizeForAiLookup(review.rawCode).clean;
        const cleanCodeSanitized = sanitizeForAiLookup(review.cleanCode).clean;
        const codeType = detectCodeType(review.cleanCode);
        // Phase 8B: app-derived prompt hints (advisory only - the Phase 8 firewall stays the hard gate).
        const scanContext = s.scanContext ?? "any";
        const candidatePrefix = decodeBarcodeStructure(review.cleanCode, codeType).candidateCompanyPrefix;
        const learnedHint = candidatePrefix
          ? deriveBrandPrefixHints(get().products, get().aliases).find((h) => h.prefix === candidatePrefix)
          : undefined;
        // Non-authoritative brand-FAMILY suggestion from the validated prefix hint table (corporate
        // siblings that share a GS1 company prefix). The learned (human-approved) hint is listed FIRST -
        // it is the trusted/promoted layer; the family is only a suggestion and never overrides the firewall.
        const familyMatch = lookupTirePrefix(review.cleanCode);
        const familyHint = familyMatch
          ? `GS1 prefix ${familyMatch.prefix} is associated (non-authoritative hint) with the tire brand family: ${familyMatch.brands.map((b) => b.brand).slice(0, 8).join(", ")}`
          : undefined;
        const brandPrefixHint =
          [
            learnedHint
              ? `candidate prefix ${learnedHint.prefix} has previously been human-approved for brand "${learnedHint.brand}" in this business`
              : undefined,
            familyHint,
          ]
            .filter(Boolean)
            .join(". ") || undefined;

        try {
          const decodeOnce = async () => {
            const res = await fetch("/api/ai-lookup", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                mode: "decode",
                proRecheck: review.reopenedFromWrong === true, // auto-escalate a marked-wrong code to the stronger model
                rawCode: rawCodeSanitized,
                cleanCode: cleanCodeSanitized,
                codeType,
                confidenceThreshold: 0.85,
                allowImageSuggestions: s.allowImageSuggestions,
                budgetMs: s.decodeBudgetMs ?? 13000,
                scanContext,
                brandPrefixHint,
              }),
            });
            if (!res.ok) throw new Error(`decode failed ${res.status}`);
            return res.json();
          };
          // RELIABILITY: a cold lookup reads external barcode DBs that can transiently rate-limit, so
          // the same code can decode one moment and return nothing the next. If the first pass yields
          // no usable product, retry ONCE (the throttle almost always clears). The success path is
          // unchanged and fast - only a genuine miss pays for the extra attempt.
          let data = await decodeOnce();
          const firstName = String((((data.results ?? [])[0] ?? {}).productName ?? ""));
          if (!isUsableProductName(firstName) && codeType !== "vendor_label") {
            try {
              const retry = await decodeOnce();
              if (isUsableProductName(String((((retry.results ?? [])[0] ?? {}).productName ?? "")))) data = retry;
            } catch {
              // keep the first result if the retry itself failed
            }
          }
          const decision = data.decision;
          const results: AiLookupResult[] = data.results ?? [];
          const best = results[0] ?? null;
          // Phase 10: for a tire scan, parse the messy decode into structured columns (size -> specs,
          // brand, part number, clean description). Display/storage only - it does NOT touch the firewall
          // or the tireAutoCountOk (size + model) auto-count gate below (those read the ORIGINAL `best`).
          const tireFields = best && s.scanContext === "tire" && isTireContext(best) ? extractTireFields(best) : null;
          const providerNamesArr = (data.providerNames as string[]) ?? [];
          const providerName = providerNamesArr.join("+") || "mock";
          const decodeProviderSummaries = results.map((r, i) => ({
            provider: providerNamesArr[i] ?? "?",
            productName: r.productName,
            sources: (r.sourceUrls ?? []).length,
          }));

          set((st) => ({
            needsReviewQueue: st.needsReviewQueue.map((r) =>
              r.id === reviewId
                ? {
                    ...r,
                    suggestedProductName: tireFields?.description || (best?.productName ?? ""),
                    suggestedBrand: tireFields?.brand ?? best?.brand ?? "",
                    suggestedCategory: best?.category ?? "",
                    suggestedSpecsShort: tireFields?.size ?? best?.specsShort ?? "",
                    suggestedSpecsFull: best?.specsFull ?? "",
                    suggestedPrimarySku: tireFields?.partNumber ?? best?.primarySku ?? "",
                    suggestedPrimaryBarcode: best?.primaryBarcode ?? "",
                    suggestedGtin: best?.gtin ?? "",
                    suggestedUpc: best?.upc ?? "",
                    suggestedEan: best?.ean ?? "",
                    suggestedImageUrl: s.allowImageSuggestions ? (best?.imageUrl ?? "") : "",
                    suggestedProductUrl: best?.productUrl ?? "",
                    suggestedAliases: best?.aliases ?? [],
                    sourceUrls: best?.sourceUrls ?? [],
                    verifiedFacts: best?.verifiedFacts ?? [],
                    guesses: best?.guesses ?? [],
                    reason: decision?.reason ?? "",
                    providerName,
                    confidence: decision?.confidence ?? 0,
                    hasSuggestion: true,
                    decodeStatus: decision?.status ?? "needs_review",
                    evidenceStrength: decision?.evidenceStrength ?? "none",
                    exactCodeEvidenceVerifiedByApp: Boolean(decision?.exactCodeEvidenceVerifiedByApp),
                    crossCheckDecision: decision?.crossCheck?.decision ?? "",
                    decodeProviderSummaries,
                  }
                : r,
            ),
            // Update the originating scan-feed row(s) from "Decoding..." to the final decode status.
            scanFeed: st.scanFeed.map((e) =>
              e.cleanCode === review.cleanCode && (e.decodeStatus === "decoding" || e.decodeStatus === "needs_review")
                ? { ...e, decodeStatus: (decision?.status ?? "needs_review") as ScanEvent["decodeStatus"], reason: decision?.reason ?? e.reason }
                : e,
            ),
            aiLookupLogs: [mkLog("success", providerName, decision?.confidence ?? 0, recordSuccess()), ...st.aiLookupLogs],
            breaker: recordSuccess(),
            aiStatus: { ...st.aiStatus, lastAttemptAt: nowIso, lastProvider: providerName, lastFailureReason: "" },
            settings: { ...st.settings, dailyLookupCount: dailyCount + 1, lastResetDate: today },
          }));

          // CONFIDENCE-BASED AUTO-VERIFY (no extra network calls - scores the evidence the decode
          // already returned). Strong, evidence-backed matches auto-save to the verified catalog and
          // count with NO owner approval. Weak/conflicting/unsafe/AI-only-no-evidence -> Needs Review.
          const cleanName = cleanProductName(best?.productName ?? "");
          const avSettings = {
            autoCatalogLearningEnabled: s.autoCatalogLearningEnabled ?? true,
            autoVerifyConfidenceThreshold: s.autoVerifyConfidenceThreshold ?? 80,
            trustedSourceAutoVerifyEnabled: s.trustedSourceAutoVerifyEnabled ?? true,
            aiOnlyAutoVerifyAllowed: s.aiOnlyAutoVerifyAllowed ?? false,
          };
          const plan = planAutoVerify({
            code: review.cleanCode,
            codeType,
            decision: {
              status: decision?.status ?? "needs_review",
              evidenceStrength: decision?.evidenceStrength ?? "none",
              exactCodeEvidenceVerifiedByApp: Boolean(decision?.exactCodeEvidenceVerifiedByApp),
              crossCheck: decision?.crossCheck ?? {
                decision: "weak", confidence: 0, reason: "", brandSimilarity: 0, nameSimilarity: 0, contradictions: [],
              },
            },
            best,
            catalog: get().catalog,
            settings: avSettings,
          });

          const newProduct = {
            name: tireFields?.description || cleanName,
            brand: tireFields?.brand ?? best?.brand ?? "",
            category: best?.category ?? "",
            specsShort: tireFields?.size ?? best?.specsShort ?? "",
            specsFull: best?.specsFull ?? "",
            primarySku: tireFields?.partNumber ?? best?.primarySku ?? "",
            primaryBarcode: best?.primaryBarcode || review.cleanCode,
            gtin: best?.gtin ?? "",
            upc: best?.upc ?? "",
            ean: best?.ean ?? "",
            imageUrl: s.allowImageSuggestions ? (best?.imageUrl ?? "") : "",
            productUrl: best?.productUrl ?? "",
          };

          const autoAddOn = s.autoAddDecodedProducts ?? true; // master gate: false = manual review for all
          // Phase 7 EVIDENCE GATE: auto-count ONLY on the app's independent exact-code verification +
          // confidence >= 0.90 + (for tires) a countable identity (size + model, matching the route's
          // verify gate). The model's self-reported confidence alone is never enough (that is what
          // auto-counted wrong products). Anything short -> Needs Review.
          const tireOk = tireAutoCountOk(best);
          // Phase 8 FIREWALL: exact-code evidence is necessary but NOT sufficient. If the decoded product
          // contradicts the business scan context (tire) or a learned brand-prefix hint, block auto-count.
          const contextConflict = detectScanContextConflict({
            scanContext: s.scanContext ?? "any",
            code: review.cleanCode,
            codeType,
            result: best,
            brandPrefixHints: deriveBrandPrefixHints(get().products, get().aliases),
          });
          const evidenceGatePassed =
            decision?.status === "verified" &&
            decodeCorroborated(decision) &&
            (decision?.confidence ?? 0) >= 0.9 &&
            isUsableProductName(best?.productName ?? "") &&
            tireOk &&
            !contextConflict;
          if (autoAddOn && evidenceGatePassed && (plan.status === "auto_verify" || plan.status === "auto_count")) {
            // Origin decides the catalog write: exact app-confirmed evidence -> VERIFIED global catalog
            // entry; a trusted-but-non-exact AI product -> still counted + aliased, PENDING catalog
            // entry ("ai"); learning off -> count only, no catalog write ("auto_count").
            const origin =
              plan.status === "auto_count" ? "auto_count" : plan.verifiedBy ? "auto_verify" : "ai";
            get().recordFeedback(plan.verifiedBy === "trusted_source" ? "trusted_source_match" : "found_from_ai", { code: review.cleanCode });
            if (origin === "auto_verify") {
              get().recordFeedback("auto_verified_catalog_entry", { code: review.cleanCode, meta: { score: plan.score, tier: plan.sourceTier } });
            }
            get().resolveUnknown(reviewId, "create_new", {
              applyToCount: true,
              origin,
              autoVerify:
                origin === "auto_verify"
                  ? {
                      score: plan.score,
                      verifiedBy: plan.verifiedBy ?? "evidence_score",
                      sourceTier: plan.sourceTier,
                      reason: plan.reason,
                      evidenceSummary: plan.evidenceSummary,
                      sourceUrls: best?.sourceUrls ?? [],
                    }
                  : undefined,
              newProduct,
            });
          } else {
            // Needs Review: keep it in the queue, show the score + why; write a PENDING catalog
            // candidate when the name is usable so the catalog still accumulates knowledge.
            get().recordFeedback("catalog_candidate_blocked", { code: review.cleanCode, meta: { score: plan.score } });
            if (isUsableProductName(best?.productName ?? "")) {
              set({
                catalog: applyAiCandidate(
                  get().catalog,
                  {
                    barcode: review.cleanCode,
                    normalizedBarcode: review.cleanCode,
                    barcodeType: codeType,
                    name: cleanName,
                    brand: best?.brand ?? "",
                    category: best?.category ?? "",
                    sourceUrls: best?.sourceUrls ?? [],
                    evidenceScore: plan.score,
                    blockingReasons: plan.blockingReasons,
                  },
                  nowIso,
                ),
              });
            }
            // Prefer the server's HONEST reason (rate-limited / timed-out / not-found-after-search /
            // fallback) over the generic gate text, so the row never lies about why it needs review.
            const honest = typeof data.reasonText === "string" ? data.reasonText : "";
            // Phase 8: a category/brand conflict gives the safe, product-facing reason (highest priority).
            // Phase 7: a usable tire decode blocked only for missing specs gets a precise reason.
            const tireIncomplete = isUsableProductName(best?.productName ?? "") && isTireContext(best) && !hasRequiredTireSpecs(best);
            const reviewReason = contextConflict
              ? conflictReason(contextConflict)
              : tireIncomplete
                ? "Tire decode missing size / load index / speed rating - confirm full specs before counting (incomplete_specs)."
                : honest || plan.blockingReasons[0] || plan.reason || "Needs review";
            set((st) => ({
              // Phase 9: a category-context conflict drives the dismissible scan-page warning banner.
              lastCategoryWarning:
                contextConflict === "category_context_conflict"
                  ? { code: review.cleanCode, productName: best?.productName ?? "this product", reason: contextConflict }
                  : st.lastCategoryWarning,
              needsReviewQueue: st.needsReviewQueue.map((r) =>
                r.id === reviewId
                  ? { ...r, autoVerifyScore: plan.score, blockingReasons: plan.blockingReasons, reason: reviewReason }
                  : r,
              ),
              // Never leave a "Verified AI Decode + Unknown" feed row: if the decode said "verified" but
              // did NOT auto-save, rewrite the feed badge to needs_review. Conflict/suggested keep their
              // (already accurate) decode status.
              scanFeed:
                decision?.status === "verified"
                  ? st.scanFeed.map((e) =>
                      e.cleanCode === review.cleanCode && e.status !== "known" && e.status !== "resolved"
                        ? { ...e, decodeStatus: "needs_review", reason: reviewReason }
                        : e,
                    )
                  : st.scanFeed,
            }));

            // Tasks 5+6: CLIENT-ORCHESTRATED BACKGROUND VERIFY. The fast hot path (mode:"decode") did
            // NOT auto-count this scan (the else branch ran -> not verified-and-clean). For a TIRE scan
            // that is still open, fire ONE background `mode:"decode-deep"` request WITH scanContext
            // "tire" - that is what makes the route page-fetch + app-verify the exact UPC and lets
            // decideDecode return "verified" (proven live: Hankook 715459332915). On success it routes
            // through the SAME verified-decode handling below to count + learn the alias.
            //
            // Never fire when the fast pass was a firewall context CONFLICT (a poisoned/off-domain
            // identity in tire context): re-fetching would just re-confirm the poison and the firewall
            // would block the count anyway, so we keep it in human review instead of spending a fetch.
            // The tire trigger reads BOTH the scan context (tire) and the decoded identity, so a clearly
            // non-tire decode in tire context does not escalate.
            const tireScan =
              (s.scanContext ?? "any") === "tire" && (isTireContext(best) || lookupTirePrefix(review.cleanCode) !== null);
            const fastWasVerified = decision?.status === "verified";
            if (tireScan && !fastWasVerified && !contextConflict) {
              // Fire-and-forget: it must NEVER block the scan UI or throw into this flow. The action
              // self-guards on the review still being open (idempotent against a late/duplicate response).
              void get().backgroundVerifyDeep(reviewId);
            }
          }
        } catch (e) {
          const nextBreaker = recordFailure(gate.breaker, nowMs);
          const failReason = `Live decode failed (network or provider error). You can retry. ${
            e instanceof Error ? e.message : ""
          }`.trim();
          set((st) => ({
            // Surface the failure on the review AND the scan-feed row; keep it open for retry.
            needsReviewQueue: st.needsReviewQueue.map((r) =>
              r.id === reviewId ? { ...r, decodeStatus: "needs_review", reason: failReason } : r,
            ),
            scanFeed: st.scanFeed.map((ev) =>
              ev.cleanCode === review.cleanCode && ev.decodeStatus === "decoding"
                ? { ...ev, decodeStatus: "needs_review", reason: failReason }
                : ev,
            ),
            aiLookupLogs: [mkLog("error", s.primaryProvider, 0, nextBreaker), ...st.aiLookupLogs],
            breaker: nextBreaker,
            aiStatus: { ...st.aiStatus, lastAttemptAt: nowIso, lastFailureReason: failReason },
            settings: { ...st.settings, dailyLookupCount: dailyCount, lastResetDate: today },
          }));
        }
      },

      backgroundVerifyDeep: async (reviewId) => {
        const state = get();
        const review = state.needsReviewQueue.find((r) => r.id === reviewId);
        // IDEMPOTENCY GUARD: only an OPEN review is ever acted on. The fast-path resolveUnknown (or an
        // earlier deep response) flips the review to "resolved" the instant it counts, so a late or
        // duplicate deep response that re-enters here finds status !== "open" and returns - it can never
        // double-count or duplicate the alias. This reuses the SAME open-status gate liveDecode relies on.
        if (!review || review.status !== "open") return;

        const s = state.settings;
        const nowIso = now();
        const today = nowIso.slice(0, 10);
        const nowMs = new Date(nowIso).getTime();
        const dailyCount = s.lastResetDate === today ? s.dailyLookupCount : 0;

        // Reuse the EXACT auto-decode gate (online + AI on + configured + not stopped + under cap +
        // breaker closed). No new gating is invented; a blocked state simply leaves the review open.
        const gate = evaluateAiGate({
          enabled: s.aiLookupEnabled,
          online: state.online,
          dailyCount,
          dailyLimit: s.dailyLookupLimit,
          breaker: state.breaker,
          now: nowMs,
        });
        if (!gate.allowed) return;

        const rawCodeSanitized = sanitizeForAiLookup(review.rawCode).clean;
        const cleanCodeSanitized = sanitizeForAiLookup(review.cleanCode).clean;
        const codeType = detectCodeType(review.cleanCode);

        let data: {
          decision?: DecodeDecision;
          results?: AiLookupResult[];
        };
        try {
          const res = await fetch("/api/ai-lookup", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              mode: "decode-deep",
              // MANDATORY: without scanContext "tire" the route's page-fetch verify gate cannot fire,
              // so the exact UPC is never app-verified and decideDecode can never return "verified"
              // (proven live). This is the whole point of the background pass.
              scanContext: "tire",
              rawCode: rawCodeSanitized,
              cleanCode: cleanCodeSanitized,
              codeType,
              confidenceThreshold: 0.85,
              allowImageSuggestions: s.allowImageSuggestions,
            }),
          });
          if (!res.ok) return; // never throw into the scan flow; leave the review open for the human
          data = await res.json();
        } catch {
          // Network/provider failure on the BACKGROUND pass must be silent: the row is already shown as
          // suggested/needs_review and the human can still resolve it. Never surface a scary error here.
          return;
        }

        // COST METERING: a successful deep fetch is a REAL provider call, so it must count against the
        // daily cap exactly like liveDecode does (same field, same +1, same set/persist pattern). Only a
        // real provider call reaches here - a non-OK response or a thrown fetch returned above, uncounted.
        set((st) => ({
          settings: { ...st.settings, dailyLookupCount: dailyCount + 1, lastResetDate: today },
        }));

        const decision = data.decision;
        const results: AiLookupResult[] = data.results ?? [];
        const best = results[0] ?? null;

        // Re-read the review: it may have been resolved (fast path / a concurrent deep response) while we
        // awaited the fetch. Only an OPEN review is upgraded - the idempotency backstop.
        const fresh = get().needsReviewQueue.find((r) => r.id === reviewId);
        if (!fresh || fresh.status !== "open") return;

        // NON-VERIFIED deep result: NEVER counts. If it carries a fuller product than the fast pass, refresh
        // the review's suggestion so the human sees better data; otherwise leave it untouched. No gate weakened.
        if (decision?.status !== "verified") {
          if (best && isUsableProductName(best.productName ?? "")) {
            const tireFields = best && s.scanContext === "tire" && isTireContext(best) ? extractTireFields(best) : null;
            set((st) => ({
              needsReviewQueue: st.needsReviewQueue.map((r) =>
                r.id === reviewId && r.status === "open"
                  ? {
                      ...r,
                      suggestedProductName: tireFields?.description || best.productName || r.suggestedProductName,
                      suggestedBrand: tireFields?.brand ?? best.brand ?? r.suggestedBrand,
                      suggestedCategory: best.category ?? r.suggestedCategory,
                      suggestedSpecsShort: tireFields?.size ?? best.specsShort ?? r.suggestedSpecsShort,
                      suggestedSpecsFull: best.specsFull ?? r.suggestedSpecsFull,
                      suggestedPrimarySku: tireFields?.partNumber ?? best.primarySku ?? r.suggestedPrimarySku,
                      suggestedImageUrl: s.allowImageSuggestions ? (best.imageUrl ?? r.suggestedImageUrl) : r.suggestedImageUrl,
                      suggestedProductUrl: best.productUrl ?? r.suggestedProductUrl,
                      sourceUrls: best.sourceUrls ?? r.sourceUrls,
                      hasSuggestion: true,
                    }
                  : r,
              ),
            }));
          }
          return;
        }

        // VERIFIED deep result: route through the SAME auto-count gate + verified-decode handling as
        // liveDecode (Task 6 alignment). This must reuse resolveUnknown so the count + alias-learn +
        // idempotency keys are identical to the fast path - we never re-implement counting here.
        const cleanName = cleanProductName(best?.productName ?? "");
        const tireFields = best && s.scanContext === "tire" && isTireContext(best) ? extractTireFields(best) : null;
        const avSettings = {
          autoCatalogLearningEnabled: s.autoCatalogLearningEnabled ?? true,
          autoVerifyConfidenceThreshold: s.autoVerifyConfidenceThreshold ?? 80,
          trustedSourceAutoVerifyEnabled: s.trustedSourceAutoVerifyEnabled ?? true,
          aiOnlyAutoVerifyAllowed: s.aiOnlyAutoVerifyAllowed ?? false,
        };
        const plan = planAutoVerify({
          code: review.cleanCode,
          codeType,
          decision: {
            status: decision.status,
            evidenceStrength: decision.evidenceStrength ?? "none",
            exactCodeEvidenceVerifiedByApp: Boolean(decision.exactCodeEvidenceVerifiedByApp),
            crossCheck: decision.crossCheck ?? {
              decision: "weak", confidence: 0, reason: "", brandSimilarity: 0, nameSimilarity: 0, contradictions: [],
            },
          },
          best,
          catalog: get().catalog,
          settings: avSettings,
        });

        const newProduct = {
          name: tireFields?.description || cleanName,
          brand: tireFields?.brand ?? best?.brand ?? "",
          category: best?.category ?? "",
          specsShort: tireFields?.size ?? best?.specsShort ?? "",
          specsFull: best?.specsFull ?? "",
          primarySku: tireFields?.partNumber ?? best?.primarySku ?? "",
          primaryBarcode: best?.primaryBarcode || review.cleanCode,
          gtin: best?.gtin ?? "",
          upc: best?.upc ?? "",
          ean: best?.ean ?? "",
          imageUrl: s.allowImageSuggestions ? (best?.imageUrl ?? "") : "",
          productUrl: best?.productUrl ?? "",
        };

        const autoAddOn = s.autoAddDecodedProducts ?? true; // master gate (unchanged): false -> manual review
        // SAME Phase 7 evidence gate + Phase 8 firewall as liveDecode. A non-verified result never reaches
        // here, and a firewall/brand-prefix conflict (poison in tire context) still blocks the count.
        const tireOk = tireAutoCountOk(best);
        const contextConflict = detectScanContextConflict({
          scanContext: s.scanContext ?? "any",
          code: review.cleanCode,
          codeType,
          result: best,
          brandPrefixHints: deriveBrandPrefixHints(get().products, get().aliases),
        });
        const evidenceGatePassed =
          decision.status === "verified" &&
          decodeCorroborated(decision) &&
          (decision.confidence ?? 0) >= 0.9 &&
          isUsableProductName(best?.productName ?? "") &&
          tireOk &&
          !contextConflict;

        if (autoAddOn && evidenceGatePassed && (plan.status === "auto_verify" || plan.status === "auto_count")) {
          const origin = plan.status === "auto_count" ? "auto_count" : plan.verifiedBy ? "auto_verify" : "ai";
          get().recordFeedback(plan.verifiedBy === "trusted_source" ? "trusted_source_match" : "found_from_ai", { code: review.cleanCode });
          if (origin === "auto_verify") {
            get().recordFeedback("auto_verified_catalog_entry", { code: review.cleanCode, meta: { score: plan.score, tier: plan.sourceTier } });
          }
          // Flip the scan-feed badge to verified BEFORE resolveUnknown re-scans (it would otherwise stay
          // on the suggested/needs_review badge the fast pass left).
          set((st) => ({
            scanFeed: st.scanFeed.map((e) =>
              e.cleanCode === review.cleanCode && e.status !== "known" && e.status !== "resolved"
                ? { ...e, decodeStatus: "verified" as ScanEvent["decodeStatus"], reason: decision.reason ?? e.reason }
                : e,
            ),
          }));
          get().resolveUnknown(reviewId, "create_new", {
            applyToCount: true,
            origin,
            autoVerify:
              origin === "auto_verify"
                ? {
                    score: plan.score,
                    verifiedBy: plan.verifiedBy ?? "evidence_score",
                    sourceTier: plan.sourceTier,
                    reason: plan.reason,
                    evidenceSummary: plan.evidenceSummary,
                    sourceUrls: best?.sourceUrls ?? [],
                  }
                : undefined,
            newProduct,
          });
        } else if (contextConflict) {
          // FALSE-AUTO-COUNT BACKSTOP: a "verified" deep decode that contradicts the tire context (poison)
          // must NOT count. Keep it open with the safe conflict reason; the human relinks. Never weaken.
          set((st) => ({
            lastCategoryWarning:
              contextConflict === "category_context_conflict"
                ? { code: review.cleanCode, productName: best?.productName ?? "this product", reason: contextConflict }
                : st.lastCategoryWarning,
            needsReviewQueue: st.needsReviewQueue.map((r) =>
              r.id === reviewId && r.status === "open" ? { ...r, reason: conflictReason(contextConflict) } : r,
            ),
          }));
        }
        // else: verified-but-gate-blocked-for-another-reason (e.g. autoAdd off, incomplete specs). The fast
        // pass already left an accurate review row; we leave it for the human (never count a blocked result).
      },

      resolveUnknown: (reviewId, action, payload) => {
        const state = get();
        const review = state.needsReviewQueue.find((r) => r.id === reviewId);
        if (!review) return;

        if (action === "ignore") {
          set({
            needsReviewQueue: state.needsReviewQueue.map((r) =>
              r.id === reviewId
                ? { ...r, status: "ignored", resolvedAt: now(), resolutionAction: "ignore" }
                : r,
            ),
          });
          get().recordFeedback("product_rejected", { code: review.cleanCode });
          emitAudit({ entityType: "UnknownCodeReview", entityId: reviewId, action: "alias_rejected", metadata: { code: review.cleanCode } });
          return;
        }

        // Determine target product (existing or newly created).
        let products = state.products;
        let productId = payload.productId ?? "";
        let createdProduct: Product | null = null; // persisted to Firestore (cloud backend) via SAVE_PRODUCT

        if (action === "create_new") {
          const np = payload.newProduct ?? {};

          // DEDUP GUARD (data correctness): every auto-add path (AI auto-add, catalog auto-count) funnels
          // through create_new, so without this one barcode could spawn dozens of identical product rows
          // (the 235x "Manstel rivet kit" bug). Before minting a product, look for an existing one this
          // identity already belongs to, using the SAME deterministic matcher the resolver uses (approved
          // alias OR verified product identifier) so dedup never drifts from resolve.
          const identityCodes = [...new Set(
            [review.cleanCode, np.primaryBarcode, np.gtin, np.upc, np.ean, np.primarySku]
              .map((c) => (c ?? "").trim())
              .filter(Boolean),
          )];
          const matchedIds = new Set<string>();
          for (const codeStr of identityCodes) {
            const res = resolveScanToProduct(cleanScanCode(codeStr), state.products, state.aliases, state.businessId);
            if (res.matchType === "conflict") (res.conflictProductIds ?? []).forEach((id) => matchedIds.add(id));
            else if (res.productId) matchedIds.add(res.productId);
          }

          // ORPHANED-COUNT DEDUP: also reuse a product that is STILL COUNTED (has a surviving finalCounts
          // row) whose own identifier fields exactly match the scanned code - even if it is no longer
          // verified or approved-aliased. A persist/session reset can drop a counted product's approved
          // alias AND its `verified` flag (the customer-safe persist strips both) while its count survives,
          // which makes resolveScanToProduct miss it and used to mint a duplicate. This is a DETERMINISTIC
          // exact identifier match (never fuzzy name), and it is scoped to products that are ACTIVELY
          // COUNTED, so a markWrong'd product (whose count was removed) is never silently reused.
          const countedProductIds = new Set(state.finalCounts.map((c) => c.productId));
          for (const p of state.products) {
            if (!countedProductIds.has(p.id) || p.status === "archived") continue;
            const pCodes = [p.primaryBarcode, p.gtin, p.upc, p.ean, p.primarySku].map((c) => (c ?? "").trim()).filter(Boolean);
            if (pCodes.some((c) => identityCodes.includes(c))) matchedIds.add(p.id);
            // BARCODE-IN-NAME DEDUP (P2): a legacy product can carry its barcode ONLY inside the name
            // (e.g. "UPC 029142712886 - Discoverer A/T3"), so the identifier-field check above misses it
            // and re-scanning that barcode mints a duplicate. Reuse it when the scanned code appears as an
            // EXACT whole token in its name (never fuzzy name matching). >1 match -> conflict block below.
            else if (blobContainsCodeToken(p.name, identityCodes)) matchedIds.add(p.id);
          }

          if (matchedIds.size > 1) {
            // MORE THAN ONE existing product owns this identity -> never guess; keep it in Needs Review
            // (same rule as the resolver conflict guard). The human picks the right one via link_existing.
            set({ lastAliasConflicts: [...matchedIds].map((existingProductId) => ({ reviewId, code: review.cleanCode, existingProductId })) });
            emitAudit({ entityType: "UnknownCodeReview", entityId: reviewId, action: "alias_conflict_blocked", metadata: { code: review.cleanCode, reason: "dedup_multiple_match", productIds: [...matchedIds].join(",") } });
            return;
          }

          if (matchedIds.size === 1) {
            // EXACTLY ONE existing product owns this identity -> reuse it (count the existing row) and fall
            // through to the alias-add + applyToCount path. Do NOT create a duplicate.
            productId = [...matchedIds][0];
            emitAudit({ entityType: "Product", entityId: productId, action: "product_dedup_reused", metadata: { code: review.cleanCode, origin: payload.origin ?? "human" } });
          } else {
            productId = `prod-${idFactory()}`;
            const newProduct: Product = {
              id: productId,
              businessId: state.businessId,
              name: np.name ?? review.cleanCode,
              brand: np.brand ?? "",
              category: np.category ?? "",
              specsShort: np.specsShort ?? "",
              specsFull: np.specsFull ?? "",
              primarySku: np.primarySku ?? "",
              // Identity = the scanned code, so the product's primaryBarcode and its first approved alias
              // agree (prevents the alias-miss -> identifier-conflict -> re-decode -> duplicate cascade).
              primaryBarcode: review.cleanCode,
              gtin: np.gtin ?? "",
              upc: np.upc ?? "",
              ean: np.ean ?? "",
              vendorCodes: [],
              aliases: [review.cleanCode],
              imageUrl: np.imageUrl ?? "",
              productUrl: np.productUrl ?? "",
              location: np.location ?? "",
              notes: "",
              status: "active",
              source: np.source ?? "human_review",
              confidence: 1,
              verified: true, // a human created/confirmed this product, so it is trusted identity
              createdAt: now(),
              updatedAt: now(),
              createdBy: "human",
              updatedBy: "human",
            };
            products = [...products, newProduct];
            createdProduct = newProduct;
          }
        }

        if (!productId) return;

        // Human-mistake guard: before linking a code to an EXISTING product, check it doesn't look like
        // a different product entirely (e.g. a Falken tire part number being linked to Camel cigarettes).
        // High-risk links are BLOCKED until the human explicitly overrides (confirmedMismatch: true).
        if (action === "link_existing") {
          const target = state.products.find((p) => p.id === productId);
          const hasSuggestion = !!(review.suggestedProductName || review.suggestedBrand || review.suggestedCategory);
          const verdict = evaluateMismatch({
            scannedCode: review.cleanCode,
            suggested: hasSuggestion
              ? { name: review.suggestedProductName, brand: review.suggestedBrand, category: review.suggestedCategory }
              : undefined,
            target: { name: target?.name, brand: target?.brand, category: target?.category },
          });
          if (verdict.risk === "high_risk" && !payload.confirmedMismatch) {
            set({ lastMismatchWarning: { reviewId, productId, verdict } });
            emitAudit({ entityType: "Alias", entityId: review.cleanCode, action: "alias_link_warning_shown", metadata: { code: review.cleanCode, productId, reason: verdict.reason, suggestedName: verdict.suggestedName ?? "", targetProductName: target?.name ?? "" } });
            return; // do NOT link until the owner explicitly confirms the override
          }
          if (verdict.risk === "high_risk" && payload.confirmedMismatch) {
            emitAudit({ entityType: "Alias", entityId: review.cleanCode, action: "alias_link_override", metadata: { code: review.cleanCode, productId, targetProductName: target?.name ?? "", suggestedName: verdict.suggestedName ?? "", suggestedDomain: verdict.suggestedDomain ?? "", reason: verdict.reason } });
          }
        }

        // Permanently learn the alias (deterministic from now on, even before sync completes).
        const aliasId = `alias-${idFactory()}`;
        const aliasKeyOp = buildIdempotencyKey(
          state.businessId,
          state.sessionId,
          aliasId,
          "RESOLVE_ALIAS",
        );
        const newAlias: Alias = {
          id: aliasId,
          businessId: state.businessId,
          productId,
          rawCodeExample: review.rawCode,
          cleanCode: review.cleanCode,
          // normalizedCandidates is stripped from a customer's persisted (rehydrated) review for privacy;
          // fall back to the cleanCode, which is what this alias is keyed on anyway.
          normalizedCode:
            review.normalizedCandidates?.[review.normalizedCandidates.length - 1] ?? review.cleanCode,
          aliasType: codeTypeToAliasType(detectCodeType(review.cleanCode)),
          source: "human_review",
          confidence: 1,
          approved: true, // human-approved -> this alias resolves deterministically to Known
          createdAt: now(),
          updatedAt: now(),
          createdBy: "human",
          lastSeenAt: now(),
          syncStatus: "pending",
          idempotencyKey: aliasKeyOp,
        };

        // Avoid duplicate aliases for the same clean code + product.
        const aliasExists = state.aliases.some(
          (a) => a.cleanCode === newAlias.cleanCode && a.productId === productId,
        );
        const aliases = aliasExists ? state.aliases : [...state.aliases, newAlias];

        const needsReviewQueue = state.needsReviewQueue.map((r) =>
          r.id === reviewId
            ? {
                ...r,
                status: "resolved" as const,
                resolvedAt: now(),
                resolvedBy: "human",
                resolutionAction: (action === "create_new" ? "create_new" : "link_existing") as
                  | "create_new"
                  | "link_existing",
              }
            : r,
        );

        // Mark any earlier "unknown" feed rows for this code as resolved, so the feed reflects the
        // learned mapping instead of staying red.
        const scanFeed = get().scanFeed.map((e) =>
          e.cleanCode === review.cleanCode &&
          (e.status === "unknown" || e.status === "needs_review" || e.status === "conflict")
            ? { ...e, status: "resolved" as const, resolverStatus: "resolved" as const, matchedProductId: productId }
            : e,
        );

        set({ products, aliases, needsReviewQueue, scanFeed, lastMismatchWarning: null, lastAliasConflicts: null, lastCategoryWarning: null });

        // Queue idempotent SAVE_PRODUCT (new products only) BEFORE the alias, so a reloaded alias always
        // references a persisted product. Then queue idempotent RESOLVE_ALIAS.
        const queued: PendingSyncItem[] = [];
        if (createdProduct) {
          queued.push(
            makeQueueItem({
              idFactory,
              now,
              businessId: state.businessId,
              sessionId: state.sessionId,
              entityType: "Product",
              entityId: createdProduct.id,
              operation: "SAVE_PRODUCT",
              payload: createdProduct,
              idempotencyKey: buildIdempotencyKey(state.businessId, state.sessionId, createdProduct.id, "SAVE_PRODUCT"),
              scanEventId: null,
            }),
          );
        }
        if (!aliasExists) {
          queued.push(
            makeQueueItem({
              idFactory,
              now,
              businessId: state.businessId,
              sessionId: state.sessionId,
              entityType: "Alias",
              entityId: aliasId,
              operation: "RESOLVE_ALIAS",
              payload: newAlias,
              idempotencyKey: aliasKeyOp,
              scanEventId: null,
            }),
          );
        }
        if (queued.length > 0) {
          set((s) => ({ pendingSyncQueue: [...s.pendingSyncQueue, ...queued] }));
        }

        // Multi-code: a newly created product registers an approved alias for EVERY other code it carries
        // (part number / SKU / GTIN / UPC / EAN), so scanning the tire's barcode OR its part-number QR both
        // resolve to the same product. Deduped against the scanned alias and any pre-existing aliases.
        if (createdProduct) {
          const extra = buildProductCodeAliases({
            product: createdProduct,
            alreadyAliasedCleanCodes: [newAlias.cleanCode],
            businessId: state.businessId,
            sessionId: state.sessionId,
            idFactory,
            now,
          });
          const existingForProduct = new Set(
            get().aliases.filter((a) => a.productId === createdProduct!.id).map((a) => a.cleanCode),
          );
          const freshAliases = extra.aliases.filter((a) => !existingForProduct.has(a.cleanCode));
          if (freshAliases.length > 0) {
            const freshIds = new Set(freshAliases.map((a) => a.id));
            set((s) => ({
              aliases: [...s.aliases, ...freshAliases],
              pendingSyncQueue: [...s.pendingSyncQueue, ...extra.queued.filter((q) => freshIds.has(q.entityId))],
            }));
            for (const a of freshAliases) {
              emitAudit({ entityType: "Alias", entityId: a.id, action: "alias_approved", metadata: { code: a.cleanCode, productId: createdProduct.id, origin: "multi_code" } });
            }
          }
        }

        // W2: approve the human-SELECTED discovered identifiers as APPROVED aliases onto the resolved
        // product (new or existing). Only codes the human explicitly selected reach here; deduped per
        // product; a code already owned by a DIFFERENT product is a conflict (surfaced, never overwritten).
        const selectedAliasCodes = (payload.selectedAliasCodes ?? []).filter(Boolean);
        if (selectedAliasCodes.length > 0) {
          const targetProduct = get().products.find((p) => p.id === productId);
          if (targetProduct) {
            const built = buildAliasesForCodes({
              product: targetProduct,
              codes: selectedAliasCodes,
              existingAliases: get().aliases,
              businessId: state.businessId,
              sessionId: state.sessionId,
              idFactory,
              now,
            });
            if (built.aliases.length > 0) {
              const builtIds = new Set(built.aliases.map((a) => a.id));
              set((s) => ({
                aliases: [...s.aliases, ...built.aliases],
                pendingSyncQueue: [...s.pendingSyncQueue, ...built.queued.filter((q) => builtIds.has(q.entityId))],
              }));
              for (const a of built.aliases) {
                emitAudit({ entityType: "Alias", entityId: a.id, action: "alias_approved", metadata: { code: a.cleanCode, productId, origin: "human_discovered" } });
              }
            }
            if (built.conflicts.length > 0) {
              set({ lastAliasConflicts: built.conflicts.map((c) => ({ reviewId, code: c.code, existingProductId: c.otherProductId })) });
              for (const c of built.conflicts) {
                emitAudit({ entityType: "Alias", entityId: c.code, action: "alias_conflict_blocked", metadata: { code: c.code, attemptedProductId: productId, existingProductId: c.otherProductId } });
              }
            }
          }
        }

        // Persist any decode-SUGGESTED identifiers the human did NOT approve as UNAPPROVED "discovered"
        // aliases on the resolved product. They never match or count until a human approves them (the
        // resolver ignores approved !== true); they are offered for one-click approval from the count
        // table. Grounded only - we persist codes the decode actually returned, never an invented one.
        const discoveryTarget = get().products.find((p) => p.id === productId);
        if (discoveryTarget) {
          const selectedSet = new Set(selectedAliasCodes.map((c) => normalizeCode(c).clean));
          const grounded = collectGroundedIdentifiers({ extras: review.suggestedAliases ?? [] });
          const discoverable = discoverableIdentifiers(grounded, get().aliases, productId, state.businessId).filter(
            (g) => g.cleanCode !== newAlias.cleanCode && !selectedSet.has(g.cleanCode),
          );
          if (discoverable.length > 0) {
            const built = buildAliasesForCodes({
              product: discoveryTarget,
              codes: discoverable.map((g) => g.rawCode),
              existingAliases: get().aliases,
              businessId: state.businessId,
              sessionId: state.sessionId,
              idFactory,
              now,
              approved: false, // DISCOVERED: never trusted until a human approves it
              source: discoveryTarget.source,
              createdBy: "discovered",
            });
            if (built.aliases.length > 0) {
              const ids = new Set(built.aliases.map((a) => a.id));
              set((s) => ({
                aliases: [...s.aliases, ...built.aliases],
                pendingSyncQueue: [...s.pendingSyncQueue, ...built.queued.filter((q) => ids.has(q.entityId))],
              }));
              for (const a of built.aliases) {
                emitAudit({ entityType: "Alias", entityId: a.id, action: "alias_discovered", metadata: { code: a.cleanCode, productId, origin: "decode_discovered" } });
              }
            }
          }
        }

        // Audit the human/system resolution (product creation + alias approval). Fire-and-forget.
        if (createdProduct) {
          emitAudit({ entityType: "Product", entityId: createdProduct.id, action: "product_created", metadata: { code: review.cleanCode, origin: payload.origin ?? "human" } });
        }
        if (!aliasExists) {
          emitAudit({ entityType: "Alias", entityId: aliasId, action: "alias_approved", metadata: { code: review.cleanCode, productId, origin: payload.origin ?? "human" } });
        }

        // Feed the shared knowledge base (privacy-safe; only barcode/product/evidence is written).
        // Origin controls trust: human -> verified catalog write; ai -> pending only (NEVER overwrites
        // a verified entry, rule #1/#2); catalog -> already observed on the read path, no write here.
        const origin = payload.origin ?? "human";
        const resolvedProduct = products.find((p) => p.id === productId);
        if (resolvedProduct && isCatalogWritable(resolvedProduct.name)) {
          const candidate = {
            barcode: review.cleanCode,
            normalizedBarcode: review.cleanCode,
            barcodeType: detectCodeType(review.cleanCode),
            name: resolvedProduct.name,
            brand: resolvedProduct.brand,
            category: resolvedProduct.category,
            imageUrl: resolvedProduct.imageUrl,
            sourceUrls: review.sourceUrls ?? [],
            confidence: review.confidence || 1,
          };
          if (origin === "human") set({ catalog: upsertVerified(get().catalog, candidate, now(), "owner") });
          else if (origin === "ai") set({ catalog: applyAiCandidate(get().catalog, candidate, now()) });
          else if (origin === "auto_verify") {
            const av = payload.autoVerify;
            set({
              catalog: upsertVerified(
                get().catalog,
                {
                  ...candidate,
                  sourceUrls: av?.sourceUrls ?? candidate.sourceUrls,
                  autoVerified: true,
                  autoVerifyReason: av?.reason ?? "",
                  evidenceScore: av?.score ?? 0,
                  sourceTier: av?.sourceTier ?? "",
                  evidenceSummary: av?.evidenceSummary ?? "",
                },
                now(),
                av?.verifiedBy ?? "evidence_score",
              ),
            });
          }
          // origin "auto_count" (learning off) and "catalog" -> count only, no catalog write here.
        }
        if (origin === "human") {
          get().recordFeedback(action === "create_new" ? "product_approved" : "alias_linked", {
            code: review.cleanCode,
            productId,
          });
        }

        // Optionally apply this code to the current session count immediately. Fall back to cleanCode:
        // a customer review rehydrated from disk has its rawCode stripped (privacy), but cleanCode is kept
        // and is what the approved alias is keyed on, so the re-scan still matches + counts.
        if (payload.applyToCount) {
          get().processScan(review.rawCode || review.cleanCode);
        } else {
          get().syncPending();
        }
      },

      evaluateLinkMismatch: (reviewId, productId) => {
        const state = get();
        const review = state.needsReviewQueue.find((r) => r.id === reviewId);
        if (!review) return null;
        const target = state.products.find((p) => p.id === productId);
        const hasSuggestion = !!(review.suggestedProductName || review.suggestedBrand || review.suggestedCategory);
        return evaluateMismatch({
          scannedCode: review.cleanCode,
          suggested: hasSuggestion
            ? { name: review.suggestedProductName, brand: review.suggestedBrand, category: review.suggestedCategory }
            : undefined,
          target: { name: target?.name, brand: target?.brand, category: target?.category },
        });
      },

      clearMismatchWarning: () => set({ lastMismatchWarning: null }),

      clearCategoryWarning: () => set({ lastCategoryWarning: null }),

      approveDiscoveredIdentifiers: (productId, cleanCodes) => {
        const state = get();
        const product = state.products.find((p) => p.id === productId);
        if (!product) return;
        const { businessId, sessionId } = state;
        const codes = [...new Set(cleanCodes.map((c) => normalizeCode(c).clean).filter(Boolean))];
        if (codes.length === 0) return;
        const aliases = state.aliases;
        const flipIds = new Set<string>();
        const toCreate: string[] = [];
        const conflicts: { code: string; otherProductId: string }[] = [];
        for (const code of codes) {
          const approvedElsewhere = aliases.find(
            (a) => a.businessId === businessId && a.cleanCode === code && a.approved && a.productId !== productId,
          );
          if (approvedElsewhere) {
            conflicts.push({ code, otherProductId: approvedElsewhere.productId }); // never hijack another product
            continue;
          }
          const mine = aliases.find((a) => a.businessId === businessId && a.cleanCode === code && a.productId === productId);
          if (mine) {
            if (!mine.approved) flipIds.add(mine.id); // flip the discovered alias -> approved
            // already approved -> idempotent no-op
          } else {
            toCreate.push(code); // grounded code with no alias yet -> create approved
          }
        }
        const built =
          toCreate.length > 0
            ? buildAliasesForCodes({ product, codes: toCreate, existingAliases: aliases, businessId, sessionId, idFactory, now })
            : { aliases: [] as Alias[], queued: [] as PendingSyncItem[], conflicts: [] as { code: string; otherProductId: string }[] };
        for (const c of built.conflicts) conflicts.push(c);

        if (flipIds.size > 0 || built.aliases.length > 0) {
          const flipped = aliases.filter((a) => flipIds.has(a.id));
          const flipQueue = flipped.map((a) =>
            makeQueueItem({
              idFactory, now, businessId, sessionId,
              entityType: "Alias", entityId: a.id, operation: "RESOLVE_ALIAS",
              payload: { ...a, approved: true },
              idempotencyKey: buildIdempotencyKey(businessId, sessionId, a.id, "RESOLVE_ALIAS"),
              scanEventId: null,
            }),
          );
          set((s) => ({
            aliases: s.aliases
              .map((a): Alias => (flipIds.has(a.id) ? { ...a, approved: true, updatedAt: now(), syncStatus: "pending" } : a))
              .concat(built.aliases),
            pendingSyncQueue: [...s.pendingSyncQueue, ...built.queued, ...flipQueue],
          }));
          for (const a of [...flipped, ...built.aliases]) {
            emitAudit({ entityType: "Alias", entityId: a.id, action: "alias_approved", metadata: { code: a.cleanCode, productId, origin: "discovered_approved" } });
          }
        }
        if (conflicts.length > 0) {
          set({ lastAliasConflicts: conflicts.map((c) => ({ reviewId: "", code: c.code, existingProductId: c.otherProductId })) });
        }
      },

      clearAliasConflicts: () => set({ lastAliasConflicts: null }),

      unlinkAlias: (aliasId) => {
        const state = get();
        const alias = state.aliases.find((a) => a.id === aliasId);
        if (!alias) return;
        const key = buildIdempotencyKey(state.businessId, state.sessionId, `${aliasId}:unlink:${idFactory()}`, "RESOLVE_ALIAS");
        const updated: Alias = { ...alias, approved: false, updatedAt: now(), syncStatus: "pending", idempotencyKey: key };
        // Mark related feed rows as needing review again (scan HISTORY is preserved, just no longer "known").
        const scanFeed = state.scanFeed.map((e) =>
          e.matchedProductId === alias.productId && e.cleanCode === alias.cleanCode
            ? { ...e, status: "needs_review" as const, resolverStatus: "needs_review" as const, matchedProductId: null }
            : e,
        );
        set((s) => ({
          aliases: s.aliases.map((a) => (a.id === aliasId ? updated : a)),
          scanFeed,
          pendingSyncQueue: [
            ...s.pendingSyncQueue,
            makeQueueItem({ idFactory, now, businessId: state.businessId, sessionId: state.sessionId, entityType: "Alias", entityId: aliasId, operation: "RESOLVE_ALIAS", payload: updated, idempotencyKey: key, scanEventId: null }),
          ],
        }));
        emitAudit({ entityType: "Alias", entityId: aliasId, action: "alias_moved_or_unlinked", metadata: { fromProduct: alias.productId, toProduct: "", cleanCode: alias.cleanCode, normalizedCode: alias.normalizedCode, reason: "human_mistake_repair" } });
        get().syncPending();
      },

      moveAlias: (aliasId, toProductId) => {
        const state = get();
        const alias = state.aliases.find((a) => a.id === aliasId);
        if (!alias || !toProductId || toProductId === alias.productId) return;
        const fromProduct = alias.productId;
        const key = buildIdempotencyKey(state.businessId, state.sessionId, `${aliasId}:move:${idFactory()}`, "RESOLVE_ALIAS");
        const updated: Alias = { ...alias, productId: toProductId, approved: true, updatedAt: now(), syncStatus: "pending", idempotencyKey: key };
        set((s) => ({
          aliases: s.aliases.map((a) => (a.id === aliasId ? updated : a)),
          pendingSyncQueue: [
            ...s.pendingSyncQueue,
            makeQueueItem({ idFactory, now, businessId: state.businessId, sessionId: state.sessionId, entityType: "Alias", entityId: aliasId, operation: "RESOLVE_ALIAS", payload: updated, idempotencyKey: key, scanEventId: null }),
          ],
        }));
        emitAudit({ entityType: "Alias", entityId: aliasId, action: "alias_moved_or_unlinked", metadata: { fromProduct, toProduct: toProductId, cleanCode: alias.cleanCode, normalizedCode: alias.normalizedCode, reason: "human_mistake_repair" } });
        get().syncPending();
      },

      // --- Phase 6: wrong-decode correction -------------------------------------------------------

      removeFromCount: (productId) => {
        const state = get();
        const removed = state.finalCounts.find((c) => c.productId === productId);
        if (!removed) return;
        // Session-only: drop the count row. Product + aliases are untouched (reversible by re-scanning).
        set((s) => ({ finalCounts: s.finalCounts.filter((c) => c.productId !== productId) }));
        emitAudit({ entityType: "InventoryCount", entityId: removed.id, action: "count_removed", metadata: { productId, quantity: removed.quantity, reason: "remove_from_count" } });
      },

      correctProduct: (productId, fields) => {
        const state = get();
        const product = state.products.find((p) => p.id === productId);
        if (!product) return;
        // Whitelist editable, product-facing fields only. Alias trust (approved/verified) is NEVER touched here.
        const safe: Partial<Product> = {};
        for (const k of ["name", "brand", "category", "specsShort", "specsFull", "primarySku", "imageUrl", "location"] as const) {
          if (fields[k] !== undefined) safe[k] = fields[k];
        }
        const updated: Product = { ...product, ...safe, updatedAt: now(), updatedBy: "human" };
        const key = buildIdempotencyKey(state.businessId, state.sessionId, productId, "SAVE_PRODUCT");
        set((s) => ({ products: s.products.map((p) => (p.id === productId ? updated : p)) }));
        enqueueAndSync([
          makeQueueItem({ idFactory, now, businessId: state.businessId, sessionId: state.sessionId, entityType: "Product", entityId: productId, operation: "SAVE_PRODUCT", payload: updated, idempotencyKey: key, scanEventId: null }),
        ]);
        emitAudit({ entityType: "Product", entityId: productId, action: "product_corrected", metadata: { fields: Object.keys(safe).join(",") } });
      },

      reopenNeedsReview: (cleanCode, reason) => {
        const state = get();
        const code = (cleanCode ?? "").trim();
        if (!code) return null;
        const existing = state.needsReviewQueue.find((r) => r.cleanCode === code);
        if (existing) {
          set((s) => ({
            needsReviewQueue: s.needsReviewQueue.map((r) =>
              r.id === existing.id
                ? {
                    ...r, status: "open", reason, resolvedAt: null, resolvedBy: null, resolutionAction: null,
                    hasSuggestion: false, suggestedProductName: "", suggestedBrand: "", suggestedCategory: "",
                    suggestedSpecsShort: "", suggestedSpecsFull: "", suggestedPrimarySku: "", suggestedPrimaryBarcode: "",
                    suggestedGtin: "", suggestedUpc: "", suggestedEan: "", suggestedImageUrl: "", suggestedProductUrl: "",
                    suggestedAliases: [], sourceUrls: [], verifiedFacts: [], guesses: [], confidence: 0, providerName: "",
                    decodeStatus: "needs_review", evidenceStrength: "none", exactCodeEvidenceVerifiedByApp: false, crossCheckDecision: "",
                    correctionRecheckStatus: undefined, correctionRecheckedAt: null, correctionRecheckMissingKeys: undefined,
                    reopenedFromWrong: true,
                  }
                : r,
            ),
          }));
          return existing.id;
        }
        const id = idFactory();
        const review: UnknownCodeReview = {
          id, businessId: state.businessId, sessionId: state.sessionId, rawCode: code, cleanCode: code,
          normalizedCandidates: normalizeCode(code).searchVariants ?? [code],
          suggestedProductName: "", suggestedBrand: "", suggestedCategory: "", suggestedSpecsShort: "", suggestedSpecsFull: "",
          suggestedPrimarySku: "", suggestedPrimaryBarcode: "", suggestedGtin: "", suggestedUpc: "", suggestedEan: "",
          suggestedImageUrl: "", suggestedProductUrl: "", suggestedAliases: [], sourceUrls: [], verifiedFacts: [], guesses: [],
          reason, providerName: "", confidence: 0, hasSuggestion: false, decodeStatus: "needs_review",
          evidenceStrength: "none", exactCodeEvidenceVerifiedByApp: false, crossCheckDecision: "", reopenedFromWrong: true,
          status: "open", createdAt: now(), resolvedAt: null, resolvedBy: null, resolutionAction: null,
          syncStatus: "pending", idempotencyKey: buildIdempotencyKey(state.businessId, state.sessionId, id, "SAVE_UNKNOWN_SCAN"),
        };
        set((s) => ({ needsReviewQueue: [...s.needsReviewQueue, review] }));
        enqueueAndSync([
          makeQueueItem({ idFactory, now, businessId: state.businessId, sessionId: state.sessionId, entityType: "UnknownCodeReview", entityId: id, operation: "SAVE_UNKNOWN_SCAN", payload: review, idempotencyKey: review.idempotencyKey, scanEventId: null }),
        ]);
        return id;
      },

      markWrong: async (productId, opts) => {
        const state = get();
        const product = state.products.find((p) => p.id === productId);
        const count = state.finalCounts.find((c) => c.productId === productId);
        // Codes that resolved to this product this session (scan feed is the reliable source; the count's
        // aliasesSeen is a fallback). These approved aliases are the ones to deactivate.
        const seenCodes = Array.from(
          new Set([
            ...state.scanFeed.filter((e) => e.matchedProductId === productId).map((e) => e.cleanCode),
            ...(count?.aliasesSeen ?? []),
          ]),
        );
        // 1. Deactivate the APPROVED aliases that mapped the scanned code(s) to this (wrong) product.
        const deactivate = state.aliases.filter(
          (a) => a.productId === productId && a.approved && (seenCodes.length === 0 || seenCodes.includes(a.cleanCode)),
        );
        if (deactivate.length > 0) {
          const ids = new Set(deactivate.map((a) => a.id));
          const queued: PendingSyncItem[] = [];
          const updatedAliases = state.aliases.map((a) => {
            if (!ids.has(a.id)) return a;
            const key = buildIdempotencyKey(state.businessId, state.sessionId, `${a.id}:markwrong:${idFactory()}`, "RESOLVE_ALIAS");
            const u: Alias = { ...a, approved: false, updatedAt: now(), syncStatus: "pending", idempotencyKey: key };
            queued.push(makeQueueItem({ idFactory, now, businessId: state.businessId, sessionId: state.sessionId, entityType: "Alias", entityId: a.id, operation: "RESOLVE_ALIAS", payload: u, idempotencyKey: key, scanEventId: null }));
            emitAudit({ entityType: "Alias", entityId: a.id, action: "wrong_alias_removed", metadata: { productId, cleanCode: a.cleanCode, reason: opts?.reason ?? "marked_wrong" } });
            return u;
          });
          set((s) => ({ aliases: updatedAliases, pendingSyncQueue: [...s.pendingSyncQueue, ...queued] }));
        }
        // 1b. Un-verify the wrong product so the DETERMINISTIC resolver can no longer match it by its
        // identifier fields (matchProductByIdentifiers only trusts verified === true). Without this, the
        // next scan of the same barcode would re-match this wrong product and re-count it - bypassing the
        // firewall entirely. The product row is kept (status unchanged) for audit/repair, just untrusted.
        if (product && product.verified) {
          const key = buildIdempotencyKey(state.businessId, state.sessionId, `${product.id}:markwrong:unverify`, "SAVE_PRODUCT");
          const unverified: Product = { ...product, verified: false, updatedAt: now(), updatedBy: "human" };
          set((s) => ({
            products: s.products.map((p) => (p.id === productId ? unverified : p)),
            pendingSyncQueue: [
              ...s.pendingSyncQueue,
              makeQueueItem({ idFactory, now, businessId: state.businessId, sessionId: state.sessionId, entityType: "Product", entityId: productId, operation: "SAVE_PRODUCT", payload: unverified, idempotencyKey: key, scanEventId: null }),
            ],
          }));
          emitAudit({ entityType: "Product", entityId: productId, action: "product_unverified", metadata: { reason: opts?.reason ?? "marked_wrong" } });
        }
        // 2. Reset related feed rows to needs_review (scan history preserved; no longer "known").
        set((s) => ({
          scanFeed: s.scanFeed.map((e) =>
            e.matchedProductId === productId && (seenCodes.length === 0 || seenCodes.includes(e.cleanCode))
              ? { ...e, status: "needs_review" as const, resolverStatus: "needs_review" as const, matchedProductId: null }
              : e,
          ),
        }));
        // 3. Remove the session count (product + now-deactivated aliases are kept for audit/repair).
        if (count) {
          set((s) => ({ finalCounts: s.finalCounts.filter((c) => c.productId !== productId) }));
          emitAudit({ entityType: "InventoryCount", entityId: count.id, action: "count_removed", metadata: { productId, quantity: count.quantity, reason: "marked_wrong" } });
        }
        // 4. Reopen Needs Review for the representative scanned code.
        const code = seenCodes[0] || product?.primaryBarcode || "";
        const reviewId = code
          ? get().reopenNeedsReview(code, `Marked wrong by owner. Previous match ${product?.name ? `"${product.name}"` : ""} removed - re-identify the product.`)
          : null;
        if (reviewId) {
          emitAudit({ entityType: "UnknownCodeReview", entityId: reviewId, action: "needs_review_reopened", metadata: { code, fromProduct: productId } });
          // 5. Stronger Gemini Pro correction recheck (cost-guarded; never auto-saves or counts).
          await get().correctionRecheck(reviewId, { reason: opts?.reason });
        }
        return reviewId;
      },

      correctionRecheck: async (reviewId, opts) => {
        const review = get().needsReviewQueue.find((r) => r.id === reviewId);
        if (!review || review.status !== "open") return;
        // Cost guard: one Pro recheck per marked-wrong code unless the user explicitly retries.
        if (review.correctionRecheckStatus && review.correctionRecheckStatus !== "requested" && !opts?.retry) return;
        const ai = get().aiStatus;
        const patch = (extra: Partial<UnknownCodeReview>) =>
          set((s) => ({ needsReviewQueue: s.needsReviewQueue.map((r) => (r.id === reviewId ? { ...r, ...extra } : r)) }));

        emitAudit({ entityType: "UnknownCodeReview", entityId: reviewId, action: "correction_recheck_requested", metadata: { code: review.cleanCode, reason: opts?.reason ?? "" } });

        // Config-missing: do NOT fail the correction. Mark unavailable, keep in Needs Review, report key NAMES only.
        if (!ai.geminiConfigured) {
          patch({ correctionRecheckStatus: "unavailable", correctionRecheckedAt: now(), correctionRecheckMissingKeys: ["GEMINI_API_KEY"] });
          emitAudit({ entityType: "UnknownCodeReview", entityId: reviewId, action: "correction_recheck_completed", metadata: { code: review.cleanCode, status: "unavailable", missing: "GEMINI_API_KEY" } });
          return;
        }

        patch({ correctionRecheckStatus: "requested", correctionRecheckedAt: now() });
        try {
          const res = await fetch("/api/ai-lookup", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            // proRecheck selects the strongest configured Gemini model server-side. Correction-only:
            // it does NOT change normal scan provider order or premium fallback.
            body: JSON.stringify({ mode: "decode", proRecheck: true, rawCode: review.rawCode, cleanCode: review.cleanCode, codeType: detectCodeType(review.cleanCode), confidenceThreshold: 0.85 }),
          });
          const data = await res.json();
          const decision = data.decision;
          const results: AiLookupResult[] = data.results ?? [];
          const best = results[0] ?? null;
          const status: "verified_correction" | "insufficient_evidence" | "conflict" =
            decision?.status === "verified" ? "verified_correction" : decision?.status === "conflict" ? "conflict" : "insufficient_evidence";

          if (status === "verified_correction" && best) {
            // Recommendation is a SUGGESTION only - the human still approves it via Needs Review (no auto-save/count).
            patch({
              correctionRecheckStatus: status, correctionRecheckedAt: now(),
              suggestedProductName: best.productName, suggestedBrand: best.brand, suggestedCategory: best.category,
              suggestedSpecsShort: best.specsShort, suggestedPrimarySku: best.primarySku, suggestedPrimaryBarcode: best.primaryBarcode,
              suggestedGtin: best.gtin, suggestedUpc: best.upc, suggestedEan: best.ean, suggestedAliases: best.aliases ?? [],
              sourceUrls: best.sourceUrls ?? [], verifiedFacts: best.verifiedFacts ?? [], guesses: best.guesses ?? [],
              hasSuggestion: true, decodeStatus: "verified", confidence: decision?.confidence ?? best.confidence ?? 0,
              evidenceStrength: decision?.evidenceStrength ?? "none", exactCodeEvidenceVerifiedByApp: Boolean(decision?.exactCodeEvidenceVerifiedByApp),
              crossCheckDecision: decision?.crossCheck?.decision ?? "",
              reason: "Gemini Pro recheck: verified correction suggested. Approve to save (still requires your confirmation).",
            });
          } else {
            // insufficient_evidence | conflict -> keep in Needs Review, safe message, NO trusted suggestion.
            patch({
              correctionRecheckStatus: status, correctionRecheckedAt: now(),
              decodeStatus: status === "conflict" ? "conflict" : "needs_review",
              reason: status === "conflict"
                ? "Gemini Pro recheck: providers conflict on identity. Kept in Needs Review - resolve manually."
                : "Gemini Pro recheck: insufficient evidence to auto-correct. Kept in Needs Review.",
            });
          }
          emitAudit({ entityType: "UnknownCodeReview", entityId: reviewId, action: "correction_recheck_completed", metadata: { code: review.cleanCode, status } });
        } catch {
          patch({ correctionRecheckStatus: "unavailable", correctionRecheckedAt: now() });
          emitAudit({ entityType: "UnknownCodeReview", entityId: reviewId, action: "correction_recheck_completed", metadata: { code: review.cleanCode, status: "error" } });
        }
      },

      importProductsCsv: (text) => {
        const state = get();
        const { rows } = parseCsv(text);
        const plan = buildProductImport({
          rows,
          existingProducts: state.products,
          existingAliases: state.aliases,
          businessId: state.businessId,
          idFactory,
          now,
        });

        if (plan.products.length > 0 || plan.aliases.length > 0) {
          set((s) => ({ products: [...s.products, ...plan.products], aliases: [...s.aliases, ...plan.aliases] }));

          // Queue idempotent SAVE_PRODUCT (each new product) BEFORE its aliases, then RESOLVE_ALIAS, so a
          // reloaded alias always references a persisted product. Same durable path Loop 4 proved.
          const items: PendingSyncItem[] = [];
          for (const p of plan.products) {
            items.push(makeQueueItem({
              idFactory, now, businessId: state.businessId, sessionId: state.sessionId,
              entityType: "Product", entityId: p.id, operation: "SAVE_PRODUCT", payload: p,
              idempotencyKey: buildIdempotencyKey(state.businessId, state.sessionId, p.id, "SAVE_PRODUCT"),
              scanEventId: null,
            }));
          }
          for (const a of plan.aliases) {
            items.push(makeQueueItem({
              idFactory, now, businessId: state.businessId, sessionId: state.sessionId,
              entityType: "Alias", entityId: a.id, operation: "RESOLVE_ALIAS", payload: a,
              idempotencyKey: a.idempotencyKey, scanEventId: null,
            }));
          }
          enqueueAndSync(items);
        }

        emitAudit({
          entityType: "ImportBatch",
          entityId: `import-${idFactory()}`,
          action: "csv_import",
          metadata: {
            rowsParsed: plan.rowsParsed,
            productsCreated: plan.products.length,
            aliasesCreated: plan.aliases.length,
            duplicates: plan.duplicates.length,
            conflicts: plan.conflicts.length,
          },
        });

        return {
          rowsParsed: plan.rowsParsed,
          productsCreated: plan.products.length,
          aliasesCreated: plan.aliases.length,
          duplicates: plan.duplicates.length,
          conflicts: plan.conflicts,
        };
      },

      auditCsvExport: (kind, rowCount, format) => {
        // Backward-compatible: action + entityId unchanged; format defaults to "csv" so existing 2-arg
        // callers and the csvImport audit test keep working, while new multi-format exports record which.
        emitAudit({ entityType: "Export", entityId: kind, action: "csv_export", metadata: { kind, rowCount, format: format ?? "csv" } });
      },

      pendingCount: () => get().pendingSyncQueue.length,
      getProduct: (id) => (id ? get().products.find((p) => p.id === id) : undefined),

      clearSession: () =>
        set({
          scanFeed: [],
          finalCounts: [],
          needsReviewQueue: [],
          pendingSyncQueue: [],
          syncedScanEventIds: [],
          lastSyncError: null,
        }),

      clearLocalCache: () => {
        // Clear ONLY browser-local data. In CLOUD mode we must NEVER call db.reset() (FirebaseSyncTarget
        // guards against a destructive cloud wipe and throws) and must NEVER reseed mock data over the
        // real cloud catalog - the cloud data re-loads on the next page load. In MOCK mode, reset the
        // local MockDb and reload clean seed (the original behavior).
        if (!cloudBackend) db.reset();
        if (typeof window !== "undefined" && window.localStorage) {
          try {
            window.localStorage.removeItem("sis-scan-v1");
            window.localStorage.removeItem("sis-mockdb-v1");
          } catch {
            // ignore
          }
        }
        const common = {
          scanFeed: [],
          finalCounts: [],
          needsReviewQueue: [],
          pendingSyncQueue: [],
          syncedScanEventIds: [],
          aiLookupLogs: [],
          lastSyncError: null,
          lastMismatchWarning: null,
          lastAliasConflicts: null,
          lastCategoryWarning: null,
          breaker: initBreaker(),
          lastCleanupBackup: null,
          lastProductDeleteBackup: null,
          catalog: [],
          shopOverrides: [],
          feedbackEvents: [],
        };
        if (cloudBackend) {
          // Cloud: empty the local catalog; products/aliases re-load from Firestore on reload. No reseed.
          set({ ...common, products: [], aliases: [] });
        } else {
          const fresh = getSeed();
          set({ ...common, products: fresh.products, aliases: fresh.aliases });
        }
      },

      applyCleanupSelections: (selectedCountIds) => {
        const state = get();
        const sel = new Set(selectedCountIds);
        const removedCounts = state.finalCounts.filter((c) => sel.has(c.id));
        if (removedCounts.length === 0) return { removed: 0, backup: null };

        const remainingCounts = state.finalCounts.filter((c) => !sel.has(c.id));
        const survivingProductIds = new Set(remainingCounts.map((c) => c.productId));
        // Remove a product/alias ONLY when no surviving count references it AND it is not a protected
        // (seed/manual) product. Good rows can never lose their product.
        const removableProductIds = new Set(
          removedCounts
            .map((c) => c.productId)
            .filter((pid) => {
              if (survivingProductIds.has(pid)) return false;
              const p = state.products.find((x) => x.id === pid);
              return !!p && p.source !== "seed" && p.source !== "manual";
            }),
        );

        const backup: CleanupBackup = {
          removedCounts,
          removedProducts: state.products.filter((p) => removableProductIds.has(p.id)),
          removedAliases: state.aliases.filter((a) => removableProductIds.has(a.productId)),
          removedAt: now(),
        };

        set({
          finalCounts: remainingCounts,
          products: state.products.filter((p) => !removableProductIds.has(p.id)),
          aliases: state.aliases.filter((a) => !removableProductIds.has(a.productId)),
          lastCleanupBackup: backup,
        });
        get().recordFeedback("ran_cleanup", { code: "", meta: { removed: removedCounts.length } });
        return { removed: removedCounts.length, backup };
      },

      cleanupJunkCounts: () => {
        const { finalCounts, products, aliases, catalog } = get();
        const { recommendations } = buildCleanupRecommendations({ finalCounts, products, aliases, catalog });
        const highIds = recommendations.filter((r) => r.defaultChecked).map((r) => r.id);
        return get().applyCleanupSelections(highIds);
      },

      undoCleanup: () => {
        const backup = get().lastCleanupBackup;
        if (!backup) return false;
        // Restore additively (dedupe by id) so any scans made after the cleanup are preserved.
        const mergeById = <T extends { id: string }>(current: T[], restored: T[]): T[] => {
          const ids = new Set(current.map((x) => x.id));
          return [...current, ...restored.filter((x) => !ids.has(x.id))];
        };
        set((s) => ({
          finalCounts: mergeById(s.finalCounts, backup.removedCounts),
          products: mergeById(s.products, backup.removedProducts),
          aliases: mergeById(s.aliases, backup.removedAliases),
          lastCleanupBackup: null,
        }));
        get().recordFeedback("restored_cleanup", { code: "", meta: { restored: backup.removedCounts.length } });
        return true;
      },

      deleteProduct: (productId) => {
        const r = deleteProductsInternal(get, set, emitAudit, now, [productId], "product_deleted");
        return r.backup;
      },

      purgePoisonedProducts: () => {
        // Targeted, safe purge of the known poison: NON-protected (non seed/manual) products whose identity
        // is the poison code 745125495781, or whose name is a rivet/Manstel kit sitting on that code. Seed/
        // manual products are never touched. Reversible via undoDeleteProduct. (The persist version bump
        // additionally resets every browser's local cache to clean seed on next load.)
        const state = get();
        const ids = state.products
          .filter((p) => {
            if (p.source === "seed" || p.source === "manual") return false;
            const codes = productIdentityCodes(p, state.aliases);
            const onPoison = codes.some((c) => POISON_CODES.has(c));
            const rivet = /\bmanstel\b|\brivet\b/i.test(`${p.name} ${p.brand}`);
            return onPoison || (rivet && codes.some((c) => POISON_CODES.has(c)));
          })
          .map((p) => p.id);
        if (ids.length === 0) return { removed: 0, backup: null };
        const r = deleteProductsInternal(get, set, emitAudit, now, ids, "product_purged");
        return { removed: ids.length, backup: r.backup };
      },

      undoDeleteProduct: () => {
        const backup = get().lastProductDeleteBackup;
        if (!backup) return false;
        // EXACT restore: put the product/alias/count rows back as they were, restore the catalog/shop
        // entries, and re-attach the scan-feed rows. Replace-by-id so a row that still exists (archived) is
        // restored to its pre-delete value; rows fully removed (counts) are re-added.
        const upsertById = <T extends { id: string }>(current: T[], restored: T[]): T[] => {
          const map = new Map(current.map((x) => [x.id, x]));
          for (const x of restored) map.set(x.id, x);
          return [...map.values()];
        };
        const restoredProductIds = new Set(backup.products.map((p) => p.id));
        const feedById = new Map(backup.feed.map((e) => [e.id, e]));
        set((s) => ({
          products: upsertById(s.products, backup.products),
          aliases: upsertById(s.aliases, backup.aliases),
          finalCounts: upsertById(s.finalCounts, backup.counts),
          catalog: [...s.catalog, ...backup.catalog.filter((c) => !s.catalog.some((x) => x.normalizedBarcode === c.normalizedBarcode && x.name === c.name))],
          shopOverrides: [...s.shopOverrides, ...backup.shopOverrides.filter((o) => !s.shopOverrides.some((x) => x.businessId === o.businessId && x.normalizedBarcode === o.normalizedBarcode))],
          scanFeed: s.scanFeed.map((e) => feedById.get(e.id) ?? e),
          lastProductDeleteBackup: null,
        }));
        for (const p of backup.products) emitAudit({ entityType: "Product", entityId: p.id, action: "product_delete_undone", metadata: { name: p.name } });
        get().recordFeedback("restored_cleanup", { code: "", meta: { restored: restoredProductIds.size } });
        return true;
      },

      // P2 maintenance: backfill identifier fields from a "UPC <code> - " name prefix so legacy products
      // carry their barcode in a real field (not just the name). Reversible + audited; never auto-run.
      previewIdentifierBackfill: () => {
        const out: Array<{ productId: string; name: string; code: string }> = [];
        for (const p of get().products) {
          if (p.status === "archived" || p.primaryBarcode) continue; // only fill empty identifier rows
          const code = codeFromNamePrefix(p.name);
          if (code) out.push({ productId: p.id, name: p.name, code });
        }
        return out;
      },

      applyIdentifierBackfill: (productIds) => {
        const targets = new Set(productIds);
        const snapshot: Array<{ productId: string; primaryBarcode: string; upc: string }> = [];
        let changed = 0;
        const products = get().products.map((p) => {
          if (!targets.has(p.id) || p.status === "archived" || p.primaryBarcode) return p;
          const code = codeFromNamePrefix(p.name);
          if (!code) return p;
          const norm = normCodeToken(code);
          snapshot.push({ productId: p.id, primaryBarcode: p.primaryBarcode ?? "", upc: p.upc ?? "" });
          changed++;
          emitAudit({ entityType: "Product", entityId: p.id, action: "identifier_backfilled", metadata: { code: norm } });
          // Fill primaryBarcode; fill upc only when the code is a 12-digit UPC-A (don't mislabel other lengths).
          return { ...p, primaryBarcode: code, upc: !p.upc && /^\d{12}$/.test(norm) ? code : p.upc, updatedAt: now(), updatedBy: "human" };
        });
        if (changed > 0) set({ products, lastIdentifierBackfill: snapshot });
        return { changed };
      },

      undoIdentifierBackfill: () => {
        const snap = get().lastIdentifierBackfill;
        if (!snap || snap.length === 0) return false;
        const byId = new Map(snap.map((s) => [s.productId, s]));
        const products = get().products.map((p) => {
          const prev = byId.get(p.id);
          return prev ? { ...p, primaryBarcode: prev.primaryBarcode, upc: prev.upc, updatedAt: now(), updatedBy: "human" } : p;
        });
        set({ products, lastIdentifierBackfill: null });
        return true;
      },
    };
  };
}

/** All identity codes a product owns: its identifier fields + every alias clean/normalized code. */
function productIdentityCodes(p: Product, aliases: Alias[]): string[] {
  const own = [p.primaryBarcode, p.gtin, p.upc, p.ean, p.primarySku].filter(Boolean) as string[];
  const aliasCodes = aliases.filter((a) => a.productId === p.id).flatMap((a) => [a.cleanCode, a.normalizedCode].filter(Boolean) as string[]);
  return [...new Set([...own, ...aliasCodes])];
}

// Known non-matching / poison codes that must never re-trust. 745125495781 is "not a valid UPC" at go-upc
// (which returns a DIFFERENT EAN 7451254957818 = Manstel rivet kit); the codes do not match.
const POISON_CODES = new Set(["745125495781"]);

/**
 * Shared delete engine for deleteProduct + purgePoisonedProducts. Archives each product (status archived +
 * verified false), deactivates ALL its aliases, removes its count rows, detaches its scan-feed rows, and
 * drops catalog/shop-override entries keyed to its codes. Snapshots everything BEFORE mutating for an exact
 * Undo. Idempotent (unknown/already-archived ids are skipped) and audited.
 */
function deleteProductsInternal(
  get: () => ScanState,
  set: (partial: Partial<ScanState> | ((s: ScanState) => Partial<ScanState>)) => void,
  emitAudit: (e: { entityType: string; entityId: string; action: string; metadata?: Record<string, unknown> }) => void,
  now: () => string,
  productIds: string[],
  auditAction: string,
): { backup: ProductDeleteBackup | null } {
  const state = get();
  const targetIds = new Set(productIds.filter((id) => state.products.some((p) => p.id === id)));
  if (targetIds.size === 0) return { backup: null };

  const targetProducts = state.products.filter((p) => targetIds.has(p.id));
  const codes = new Set(targetProducts.flatMap((p) => productIdentityCodes(p, state.aliases)));
  const targetAliases = state.aliases.filter((a) => targetIds.has(a.productId));
  const targetCounts = state.finalCounts.filter((c) => targetIds.has(c.productId));
  const targetCatalog = state.catalog.filter((c) => codes.has(c.normalizedBarcode) || codes.has(c.barcode));
  const targetOverrides = state.shopOverrides.filter((o) => codes.has(o.normalizedBarcode));
  const touchedFeed = state.scanFeed.filter((e) => e.matchedProductId !== null && targetIds.has(e.matchedProductId));

  // Snapshot the PRE-delete values for an exact Undo (+ for the downloadable JSON backup in the UI).
  const backup: ProductDeleteBackup = {
    products: targetProducts.map((p) => ({ ...p })),
    aliases: targetAliases.map((a) => ({ ...a })),
    counts: targetCounts.map((c) => ({ ...c })),
    catalog: targetCatalog.map((c) => ({ ...c })),
    shopOverrides: targetOverrides.map((o) => ({ ...o })),
    feed: touchedFeed.map((e) => ({ ...e })),
    deletedAt: now(),
  };

  set((s) => ({
    // Archive + un-verify so the deterministic resolver/matcher (verified === true only) stops matching it.
    products: s.products.map((p) => (targetIds.has(p.id) ? { ...p, status: "archived" as const, verified: false, updatedBy: "human" } : p)),
    // Deactivate ALL aliases so an approved alias can no longer resolve the freed code.
    aliases: s.aliases.map((a) => (targetIds.has(a.productId) ? { ...a, approved: false } : a)),
    // Remove the session count rows.
    finalCounts: s.finalCounts.filter((c) => !targetIds.has(c.productId)),
    // Drop catalog / shop-override entries keyed to the freed codes so a future scan re-decodes them.
    catalog: s.catalog.filter((c) => !(codes.has(c.normalizedBarcode) || codes.has(c.barcode))),
    shopOverrides: s.shopOverrides.filter((o) => !codes.has(o.normalizedBarcode)),
    // Detach scan-feed rows (history kept, but no longer "known" / pointing at the deleted product).
    scanFeed: s.scanFeed.map((e) =>
      e.matchedProductId !== null && targetIds.has(e.matchedProductId)
        ? { ...e, matchedProductId: null, status: "needs_review" as const, resolverStatus: "needs_review" as const }
        : e,
    ),
    lastProductDeleteBackup: backup,
  }));

  for (const p of targetProducts) {
    emitAudit({ entityType: "Product", entityId: p.id, action: auditAction, metadata: { name: p.name, codes: [...codes].join(" | "), aliasesDeactivated: targetAliases.filter((a) => a.productId === p.id).length } });
  }
  return { backup };
}

// --- App store (persisted) ---------------------------------------------------------------------

// Backend selection: Firebase (cloud/emulator) when NEXT_PUBLIC_FIREBASE_BACKEND=1, else the local mock
// (default + legacy E2E -> existing behavior unchanged). The Firebase target is constructed ONLY in that
// branch, so the mock/test path never initializes Firebase.
const useFirebaseBackend = process.env.NEXT_PUBLIC_FIREBASE_BACKEND === "1";
const appDeps: ScanStoreDeps = {
  db: useFirebaseBackend
    ? new FirebaseSyncTarget(getDb(), { emulator: process.env.NEXT_PUBLIC_FIREBASE_USE_EMULATOR === "1" })
    : getMockDb(),
  cloudBackend: useFirebaseBackend,
  loadBusinessData: useFirebaseBackend ? (businessId) => loadBusinessData(getDb(), businessId) : undefined,
  // Cloud audit sink: append-only auditLog. Fire-and-forget; swallows its own errors so a failed audit
  // write can never break a scan/resolution. No-op on the mock/default path (undefined).
  audit: useFirebaseBackend
    ? (event) => {
        try {
          void auditRepository(getDb(), event.businessId)
            .append(toAuditEvent(event, crypto.randomUUID()))
            .catch(() => {});
        } catch {
          // never propagate
        }
      }
    : undefined,
  // Global catalog cloud lookup (Option 1 wiring). Tries each candidate code against the Firestore
  // global catalog; returns the first verified entry, or the first entry of any status, or null.
  // Errors are swallowed here and also in cloudCatalogResolve so a Firestore failure never breaks scanning.
  lookupGlobalCatalog: useFirebaseBackend
    ? async (codes: string[]): Promise<CatalogEntry | null> => {
        const repo = catalogRepository(getDb());
        const nowIso = new Date().toISOString();
        // toStoreEntry: map the minimal db/types.ts CatalogEntry shape -> the full catalogTypes CatalogEntry
        // shape that the store/resolver expects, via sanitizeCatalogEntry (fills in all required defaults).
        const toStoreEntry = (raw: { id: string; normalizedBarcode: string; name?: string; brand?: string; category?: string; verificationStatus?: string }) =>
          sanitizeCatalogEntry(
            { barcode: raw.normalizedBarcode, normalizedBarcode: raw.normalizedBarcode, name: raw.name ?? "", brand: raw.brand, category: raw.category },
            { now: nowIso, verificationStatus: raw.verificationStatus === "verified" ? "verified" : raw.verificationStatus === "conflict" ? "conflict" : "pending", verifiedBy: null, by: "trusted_source" },
          );
        let firstAny: CatalogEntry | null = null;
        for (const code of codes) {
          try {
            const raw = await repo.getByBarcode(code);
            if (!raw) continue;
            const entry = toStoreEntry(raw);
            if (entry.verificationStatus === "verified") return entry;
            if (!firstAny) firstAny = entry;
          } catch {
            // swallow per-code errors; try the next candidate
          }
        }
        return firstAny;
      }
    : undefined,
  idFactory: () => crypto.randomUUID(),
  now: () => new Date().toISOString(),
  persistName: "sis-scan-v1",
};

export const useScanStore = create<ScanState>()(
  persist(buildScanInitializer(appDeps), {
    name: "sis-scan-v1",
    version: 5,
    storage: createJSONStorage(() => localStorage),
    skipHydration: true,
    // v3 hotfix: earlier versions could persist AI-auto-accepted (poisoned) products/aliases.
    // We cannot reliably tell poisoned from good learned data, so reset products/aliases to clean
    // verified seed and clear session/queues. User settings are preserved (merged with new
    // defaults). Use the in-app "Clear local cache" button for a full wipe including the mock DB.
    // v4 (Sec-4): the customer-data wipe of any legacy sensitive localStorage keys (aliases/catalog/
    // raw codes) is enforced by the role-aware `partialize` below on the first post-hydration write
    // (which defaults to the customer-safe shape until the user is proven to be the platformOwner).
    // v5: auto-purge the poisoned duplicates (e.g. the ~235 "Manstel rivet kit" rows saved on the
    // non-matching code 745125495781) by resetting products/aliases to clean verified seed on next load.
    migrate: (persisted: unknown) => {
      const p = (persisted ?? {}) as Record<string, unknown>;
      const fresh = getSeed();
      return {
        ...p,
        products: fresh.products,
        aliases: fresh.aliases,
        scanFeed: [],
        finalCounts: [],
        needsReviewQueue: [],
        pendingSyncQueue: [],
        syncedScanEventIds: [],
        settings: { ...DEFAULT_SETTINGS, ...((p.settings as Partial<Settings>) ?? {}) },
      } as never;
    },
    // Sec-4: split persisted state by access level. A customer browser must NEVER persist the reusable
    // code database (aliases / global catalog / shop overrides / barcodes / raw+clean+normalized codes /
    // decode traces). The level is computed from the signed-in uid (same source of truth as the UI), and
    // defaults to "business" when the user is unknown - so a customer's post-hydration write also WIPES
    // any sensitive keys an older build left in this browser's localStorage. This governs ONLY what is
    // written to disk; the in-memory store keeps the full data it needs to render/resolve in-session
    // (seed in mock, the loader in cloud), so resolution is unaffected.
    partialize: (s) => buildPersistedScanState(s as unknown as PersistableScanState),
    onRehydrateStorage: () => (state) => state?.setHasHydrated(true),
  }),
);

/** Factory for tests: a fresh, non-persisted store with injectable deps. */
export function createTestScanStore(overrides?: Partial<ScanStoreDeps>) {
  let n = 0;
  const deps: ScanStoreDeps = {
    db: overrides?.db ?? new MockDb(),
    idFactory: overrides?.idFactory ?? (() => `id-${++n}`),
    now: overrides?.now ?? (() => "2026-06-12T10:00:00.000Z"),
    persistName: null,
    cloudBackend: overrides?.cloudBackend ?? false,
    loadBusinessData: overrides?.loadBusinessData,
    audit: overrides?.audit,
    lookupGlobalCatalog: overrides?.lookupGlobalCatalog,
  };
  const store = create<ScanState>()(buildScanInitializer(deps));
  // Test convenience: generic store tests use non-tire seed fixtures (e.g. Coca-Cola) as stand-ins for
  // ANY product, so the test store defaults to "any" context. The PRODUCTION default is "tire"
  // (DEFAULT_SETTINGS); firewall tests opt in via updateSettings({ scanContext: "tire" }).
  store.getState().updateSettings({ scanContext: "any" });
  return store;
}
