"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type {
  Alias,
  AiLookupLog,
  AiLookupResult,
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
import { incrementInventoryCount } from "@/services/inventory";
import { buildIdempotencyKey } from "@/services/idempotency";
import { MockDb, getMockDb, type IncrementPayload, type SyncResult } from "@/services/mockDb";
import type { SyncTarget } from "@/services/db/syncTarget";
import { FirebaseSyncTarget } from "@/services/db/firebase/firebaseSyncTarget";
import { loadBusinessData } from "@/services/db/firebase/businessDataLoader";
import { auditRepository } from "@/services/db/firebase/repositories";
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
import type { CatalogEntry, ShopOverride } from "@/services/catalog/catalogTypes";
import { decideLookup, upsertVerified, applyAiCandidate, observeScan } from "@/services/catalog/localCatalogProvider";
import { planAutoVerify } from "@/services/catalog/catalogAutoVerify";
import { isCatalogWritable } from "@/services/catalog/sanitizeCatalog";
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
}

const DEFAULT_SETTINGS: Settings = {
  businessId: DEMO_BUSINESS_ID,
  aiLookupEnabled: false,
  primaryProvider: "mock",
  fallbackProvider: "mock",
  dailyLookupLimit: 25,
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
  /** Repair a bad alias: unlink it (stops resolving; soft delete, scan history kept). Audited. */
  unlinkAlias: (aliasId: string) => void;
  /** Repair a bad alias: move it to the correct product. Audited. */
  moveAlias: (aliasId: string, toProductId: string) => void;
  /** Append a private feedback/event-log entry (the "smarter over time" substrate). */
  recordFeedback: (
    type: FeedbackEventType,
    payload: { code: string; productId?: string | null; meta?: Record<string, string | number | boolean> },
  ) => void;
  /** Import products + approved aliases from CSV text (MVP). Writes via the durable queue + audits. */
  importProductsCsv: (text: string) => CsvImportSummary;
  /** Audit a CSV export (called by the export UI). Fire-and-forget; never blocks. */
  auditCsvExport: (kind: string, rowCount: number) => void;
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
function buildApprovedAliasesForCodes(params: {
  product: Product;
  codes: string[];
  existingAliases: Alias[];
  businessId: string;
  sessionId: string;
  idFactory: () => string;
  now: () => string;
}): { aliases: Alias[]; queued: PendingSyncItem[]; conflicts: { code: string; otherProductId: string }[] } {
  const { product, codes, existingAliases, businessId, sessionId, idFactory, now } = params;
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
      source: "human_review",
      confidence: 1,
      approved: true,
      createdAt: now(),
      updatedAt: now(),
      createdBy: "human",
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
      aiLookupLogs: [],
      breaker: initBreaker(),
      aiStatus: { ...DEFAULT_AI_STATUS },
      catalog: [],
      shopOverrides: [],
      feedbackEvents: [],
      lastCleanupBackup: null,
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

        const event: ScanEvent = {
          id: scanEventId,
          businessId,
          sessionId,
          rawCode: cleaned.rawCode,
          cleanCode: cleaned.cleanCode,
          normalizedCandidates: cleaned.normalizedCandidates,
          matchedProductId: resolution.productId,
          matchType: resolution.matchType,
          status: isKnown ? "known" : resolution.resolverStatus === "conflict" ? "conflict" : "needs_review",
          resolverStatus: resolution.resolverStatus,
          codeType: resolution.codeType,
          reason: resolution.reason,
          quantityDelta: isKnown ? 1 : 0,
          quantityAfterScan: 0,
          createdAt,
          source: "scan",
          notes: resolution.reason,
          syncStatus: "pending",
          idempotencyKey: keyFor("INCREMENT_COUNT"),
          syncError: null,
        };

        if (isKnown && resolution.productId) {
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

        // The scan row shows "Decoding..." while the pipeline runs, or - if it cannot - the gate
        // reason combined with the deterministic resolver reason (so vendor-label/no-match context
        // is preserved alongside the why-no-AI explanation).
        const passiveReason = autoGate.allowed ? autoGate.reason : `${resolution.reason} ${autoGate.reason}`;
        event.decodeStatus = existingOpen?.decodeStatus ?? (autoGate.allowed ? "decoding" : "needs_review");
        event.reason = existingOpen?.reason ?? passiveReason;

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
            reason: passiveReason,
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
          if (decision.shouldResolveWithoutAi && decision.hit) {
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
          if (autoGate.allowed) void get().liveDecode(review.id);
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
          set((s) => ({
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
          }));
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

        try {
          const decodeOnce = async () => {
            const res = await fetch("/api/ai-lookup", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                mode: "decode",
                rawCode: rawCodeSanitized,
                cleanCode: cleanCodeSanitized,
                codeType,
                confidenceThreshold: 0.85,
                allowImageSuggestions: s.allowImageSuggestions,
                budgetMs: s.decodeBudgetMs ?? 13000,
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
                    suggestedProductName: best?.productName ?? "",
                    suggestedBrand: best?.brand ?? "",
                    suggestedCategory: best?.category ?? "",
                    suggestedSpecsShort: best?.specsShort ?? "",
                    suggestedSpecsFull: best?.specsFull ?? "",
                    suggestedPrimarySku: best?.primarySku ?? "",
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
            name: cleanName,
            brand: best?.brand ?? "",
            category: best?.category ?? "",
            specsShort: best?.specsShort ?? "",
            specsFull: best?.specsFull ?? "",
            primarySku: best?.primarySku ?? "",
            primaryBarcode: best?.primaryBarcode || review.cleanCode,
            gtin: best?.gtin ?? "",
            upc: best?.upc ?? "",
            ean: best?.ean ?? "",
            imageUrl: s.allowImageSuggestions ? (best?.imageUrl ?? "") : "",
            productUrl: best?.productUrl ?? "",
          };

          const autoAddOn = s.autoAddDecodedProducts ?? true; // master gate: false = manual review for all
          if (autoAddOn && (plan.status === "auto_verify" || plan.status === "auto_count") && isUsableProductName(best?.productName ?? "")) {
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
            const reviewReason = honest || plan.blockingReasons[0] || plan.reason || "Needs review";
            set((st) => ({
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
          productId = `prod-${idFactory()}`;
          const np = payload.newProduct ?? {};
          const newProduct: Product = {
            id: productId,
            businessId: state.businessId,
            name: np.name ?? review.cleanCode,
            brand: np.brand ?? "",
            category: np.category ?? "",
            specsShort: np.specsShort ?? "",
            specsFull: np.specsFull ?? "",
            primarySku: np.primarySku ?? "",
            primaryBarcode: np.primaryBarcode ?? review.cleanCode,
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
          normalizedCode:
            review.normalizedCandidates[review.normalizedCandidates.length - 1] ?? review.cleanCode,
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

        set({ products, aliases, needsReviewQueue, scanFeed, lastMismatchWarning: null, lastAliasConflicts: null });

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
            const built = buildApprovedAliasesForCodes({
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
            sourceUrls: review.sourceUrls,
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

        // Optionally apply this code to the current session count immediately.
        if (payload.applyToCount) {
          get().processScan(review.rawCode);
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

      auditCsvExport: (kind, rowCount) => {
        emitAudit({ entityType: "Export", entityId: kind, action: "csv_export", metadata: { kind, rowCount } });
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
          breaker: initBreaker(),
          lastCleanupBackup: null,
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
    };
  };
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
  idFactory: () => crypto.randomUUID(),
  now: () => new Date().toISOString(),
  persistName: "sis-scan-v1",
};

export const useScanStore = create<ScanState>()(
  persist(buildScanInitializer(appDeps), {
    name: "sis-scan-v1",
    version: 4,
    storage: createJSONStorage(() => localStorage),
    skipHydration: true,
    // v3 hotfix: earlier versions could persist AI-auto-accepted (poisoned) products/aliases.
    // We cannot reliably tell poisoned from good learned data, so reset products/aliases to clean
    // verified seed and clear session/queues. User settings are preserved (merged with new
    // defaults). Use the in-app "Clear local cache" button for a full wipe including the mock DB.
    // v4 (Sec-4): the customer-data wipe of any legacy sensitive localStorage keys (aliases/catalog/
    // raw codes) is enforced by the role-aware `partialize` below on the first post-hydration write
    // (which defaults to the customer-safe shape until the user is proven to be the platformOwner).
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
  };
  return create<ScanState>()(buildScanInitializer(deps));
}
