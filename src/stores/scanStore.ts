"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  Alias,
  AiLookupLog,
  InventoryCount,
  InventorySession,
  PendingSyncItem,
  Product,
  ProvenanceTier,
  ResolverResult,
  ScanEvent,
  Settings,
  SyncOperation,
  UnknownCodeReview,
} from "@/types";
import { cleanScanCode } from "@/scanning/clean/scanCleaner";
import type { MismatchVerdict } from "@/products/match/productMismatchGuard";
import { detectCodeType } from "@/products/match/codeTypeDetector";
import { resolveScan } from "@/products/match/resolver";
import { isLikelyMisreadGtin } from "@/products/barcodes/misread";
import { gradeBarcode } from "@/products/barcodes/barcodeTrust";
import { isCloudBackendEnabled } from "@/sync-database/backend";
import type { DatabaseService } from "@/sync-database/databaseService";
import { incrementInventoryCount } from "@/inventory/ledger";
import { buildIdempotencyKey } from "@/inventory/idempotency";
import { MockDb, getMockDb, type IncrementPayload, type SyncResult } from "@/sync-database/mock/mockDb";
import { FirebaseSyncTarget } from "@/sync-database/cloud/firebaseSyncTarget";
import { loadBusinessData } from "@/sync-database/cloud/businessDataLoader";
import { auditRepository, catalogRepository } from "@/sync-database/cloud/repositories";
import { getDb } from "@/authentication/firebaseClient";
import {
  initBreaker,
  type BreakerState,
} from "@/decoding/limits/circuitBreaker";
import { isUsableProductName } from "@/decoding/decode";
import { getIdentityConfidenceBand } from "@/decoding/identityConfidenceBand";
import type { CatalogEntry, ShopOverride } from "@/products/catalog/catalogTypes";
import { decideLookup, observeScan } from "@/products/catalog/localCatalogProvider";
import { prefixFloorName, type PrefixFloorResult } from "@/products/catalog/prefixFloor";
import { detectIdentityContextConflict, conflictReason } from "@/decoding/scanContextFirewall";
import { toMasterAwareStoreEntry } from "@/products/catalog/sanitizeCatalog";
import {
  decodeCorroborated as decodeCorroboratedGate,
} from "@/stores/scanGates";
import type { CatalogSourceTier, CatalogVerifiedBy } from "@/products/catalog/catalogTypes";
import { appendFeedback, type FeedbackEvent, type FeedbackEventType } from "@/shared/feedback/feedback";
import type { CountSnapshot } from "@/reports/variance/varianceReport";
import {
  buildSessionHistoryEntry,
  appendSessionHistory,
  type SessionHistoryEntry,
} from "@/sessions/history/sessionHistory";
import { toAuditEvent } from "@/users-businesses/account/audit";
import type { ImportConflict } from "@/import/csvImport";
import { getSeed, DEMO_BUSINESS_ID } from "@/seed/seedData";
import { buildPersistedScanState, type PersistableScanState } from "@/stores/scanPersist";
import { createCoalescedFailSoftPersistStorage, createAsyncCoalescedFailSoftPersistStorage } from "@/stores/scanPersistStorage";
import { createIdbBacking } from "@/stores/idbBacking";
import { emptyTenantState } from "@/stores/scanReset";
import { DEFAULT_SETTINGS } from "@/stores/scanDefaults";
export { DEFAULT_SETTINGS } from "@/stores/scanDefaults";
import { clearSelectedBusinessId } from "@/users-businesses/selectedBusiness";
import {
  persistKeyForUid,
  migrateLegacyBlobOnce,
  migrateLegacyBlobOnceAsync,
  removePersistedKeyEverywhere,
  hasMeaningfulLegacyBlobAsync,
  LEGACY_PERSIST_KEY,
} from "@/stores/scanPersistNamespace";
import { mergeReloadedProductsAndAliases, mergeReloadedReviews } from "@/sync-database/queue/reloadMergePolicy";
import type { AiStatus } from "@/types";
import type { ImportPreviewRow, ImportReviewContext, UniversalImportApplySummary } from "@/import/importSchema";
import { PERSISTED_FIELD_SHAPES, recomputeSyncStatus, sanitizePersistedScanShape, scanStoreMigrate } from "@/stores/scan/persistShape";
export { sanitizePersistedScanShape, scanStoreMigrate } from "@/stores/scan/persistShape";
import { buildAdoptionResyncItems, rescopePlaceholderQueueItem, rescopePlaceholderRecord } from "@/stores/scan/adoption";
import { provisionalPlaceholderName } from "@/stores/scan/placeholders";
import { generalDecodeQueue, resetTokenBucket } from "@/stores/scan/decodePacer";
import { evaluateAutoDecode, isPlatformOwnerForGateBypass } from "@/stores/scan/decodeGates";
import { makeQueueItem, stampScanEventLocation } from "@/stores/scan/queueItem";
import { createStoreInternals } from "@/stores/scan/internals";
import { createSyncInternals } from "@/stores/scan/syncInternals";
import { createCatalogSlice } from "@/stores/scan/catalogSlice";
import { createSessionSlice } from "@/stores/scan/sessionSlice";
import { createReviewSlice } from "@/stores/scan/reviewSlice";
import { createDecodeSlice } from "@/stores/scan/decodeSlice";

/** Result summary of a CSV product import (shown in the UI). */
export interface CsvImportSummary {
  rowsParsed: number;
  productsCreated: number;
  aliasesCreated: number;
  duplicates: number;
  conflicts: ImportConflict[];
  /**
   * QA Task 7 (owner decision, catalog semantics): count of existing-barcode rows whose product had
   * its descriptive fields (name/brand/category/specsShort/location) refreshed from the row. Never
   * implies a quantity change - InventoryCount is untouched by a catalog re-import.
   */
  refreshed: number;
}

const UNIT_COST_HEADERS = ["unit_cost", "unit cost", "cost", "unitcost"];

function parseUnitCost(row: Record<string, string>): number | undefined {
  for (const key of Object.keys(row)) {
    if (UNIT_COST_HEADERS.includes(key.trim().toLowerCase())) {
      const raw = row[key]?.trim();
      if (!raw) continue;
      const value = Number(raw);
      if (Number.isFinite(value)) return value;
    }
  }
  return undefined;
}

function importedRowCodes(row: Record<string, string>): Set<string> {
  const vendorRaw = row.vendor_codes || row.vendor || row.vendor_code || "";
  const values = [
    row.sku,
    row.primary_sku,
    row.barcode,
    row.primary_barcode,
    row.gtin,
    row.upc,
    row.ean,
    ...vendorRaw.split(/[|;]/),
  ];
  const codes = new Set<string>();
  for (const raw of values) {
    if (!raw?.trim()) continue;
    const cleaned = cleanScanCode(raw);
    if (cleaned.cleanCode) codes.add(cleaned.cleanCode);
    for (const candidate of cleaned.normalizedCandidates) codes.add(candidate);
  }
  return codes;
}

export function applyImportedUnitCosts(rows: Record<string, string>[], products: Product[]): void {
  const costsByCode = new Map<string, number>();
  for (const row of rows) {
    const unitCost = parseUnitCost(row);
    if (unitCost === undefined) continue;
    for (const code of importedRowCodes(row)) costsByCode.set(code, unitCost);
  }
  for (const product of products) {
    const unitCost = product.aliases.map((code) => costsByCode.get(code)).find((value) => value !== undefined);
    if (unitCost !== undefined) product.unitCost = unitCost;
  }
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
  /** Ids of the "Unidentified item" provisionals minted by the delete to carry the deleted counts
   *  (TOP-LEVEL LAW: quantity never vanishes). Optional: older persisted backups lack it. Undo uses
   *  it to remove the now-empty provisionals after restoring the original rows. */
  mintedProvisionalIds?: string[];
}

/**
 * Task 2 (honest daily-cap copy): thrown by decodeOnce when /api/ai-lookup returns 429 with
 * reasonCode "daily_cap" (the server-side daily AI spend cap, not a self-inflicted rate limit).
 * This is a genuinely different failure than a transient rate limit - there is NO automatic
 * decode-on-cap-reset queue anywhere in the app (verified: only the sync retry queue and the
 * manual "Retry live decode" button exist), so the caught reason must not retry and must not
 * promise a retry that will never happen.
 */
export class DailyCapReachedError extends Error {
  readonly reasonCode: "daily_cap" | "account_daily_cap";
  /** P2 (Task 8): the $0 prefix floor the server threaded through the 429 body when the GS1 company
   *  prefix knows the company, so the cap-blocked row is named "<Brand> / product unconfirmed" instead
   *  of a bare "Unidentified item". Undefined when the code has no known prefix (unchanged behavior). */
  readonly floor?: PrefixFloorResult;
  /** F1/F4: distinguishes the GLOBAL server cap ("daily_cap") from the PER-ACCOUNT cap
   *  ("account_daily_cap", route.ts:311/331) so the row can carry the honest, account-specific copy. */
  readonly accountScoped: boolean;
  constructor(message = "Daily AI lookup cap reached", floor?: PrefixFloorResult, accountScoped = false) {
    super(message);
    this.name = "DailyCapReachedError";
    this.floor = floor;
    this.accountScoped = accountScoped;
    this.reasonCode = accountScoped ? "account_daily_cap" : "daily_cap";
  }
}

/**
 * AM-1(a) (owner-reported 36-70s browser blocks): thrown when the client-side decode fetch is
 * aborted by our own AbortController (timeout = decodeBudgetMs + 7000ms margin). The server-side
 * server decode deadline (L2, see pipeline.ts) is the primary fix - it bounds total work so the
 * request itself finishes fast - but the client must never trust the network to behave: an abort
 * here is NOT a retry case (the decode keeps running server-side; there is nowhere to retry TO), it
 * is an honest "still working, check back" signal that keeps the scan row open and reviewable.
 */
export class DecodeAbortedError extends Error {
  readonly reasonCode = "decode_aborted" as const;
  constructor(message = "Decode client-side abort timeout") {
    super(message);
    this.name = "DecodeAbortedError";
  }
}

const DEFAULT_AI_STATUS: AiStatus = {
  liveEnabled: true,
  autoDecodeOnScan: true,
  openaiConfigured: false,
  freeDecodeAvailable: false,
  dailyLimit: 100,
  missingKeys: ["OPENAI_API_KEY"],
  emergencyStop: false,
  lastAttemptAt: null,
  lastProvider: "",
  lastFailureReason: "",
  killSwitchOn: false,
  killSwitchStatusUnknown: false,
};

/**
 * What counts as "corroborated" for auto-count, shared by liveDecode + backgroundVerifyDeep so the rule
 * cannot drift. The app-verified exact code OR the internet_two_source_size path (brand from the strong GS1
 * prefix + two independent Internet sources agreeing on the size, set app-side by the route race). The
 * local DB is never involved. Every OTHER gate clause (verified status, confidence >= 0.8, tireOk,
 * no context conflict, autoAddOn) is enforced separately and unchanged.
 */
// Re-exported from the pure gate module (src/stores/scanGates.ts) so existing importers
// (scanStore.autocount.test.ts imports it from "./scanStore") keep working unchanged.
export const decodeCorroborated = decodeCorroboratedGate;

// Task 3.5: cap the count-snapshot ring buffer (same pattern as FEEDBACK_EVENT_CAP) so the variance/
// shrinkage report's history stays useful without growing localStorage unbounded.
const COUNT_SNAPSHOT_CAP = 12;
export function trustedExactProbeCandidate(code: string): boolean {
  const value = code.trim();
  const grade = gradeBarcode({ barcode: value });
  if (grade.placeholder) return false;
  // The exact corpus admits short numeric shop identifiers, invalid-check-digit spellings certified
  // from source evidence, and bounded scanner-safe mixed labels. Merely probing these shapes grants no
  // trust: settlement still requires the server attestation, opaque canonical id, and index digest.
  return /^\d{3,14}$/.test(value)
    || (/^(?=.{5,64}$)(?=.*\d)[A-Za-z0-9 ._%+'():/-]+$/.test(value));
}

// The local optimistic session store. Known scans update this store immediately - the UI never
// waits on a server round-trip. Sync to the (mock) backend happens AFTER the user sees feedback,
// using idempotency keys so a retry can never double-count.

// The storage half of these dependencies (db, cloudBackend, trustedExactProbeEnabled,
// loadBusinessData, audit, lookupGlobalCatalog) now lives in @/sync-database/databaseService as the
// DatabaseService port, so "what would a replacement backend have to provide?" is answerable without
// reading this file. Extending it means the two cannot drift: a new storage capability added here
// without declaring it there is a type error.
//
// What remains below is what is genuinely NOT storage - an id factory, a clock, and a persistence key
// - kept injectable so tests can make both deterministic.
export interface ScanStoreDeps extends DatabaseService {
  idFactory: () => string;
  now: () => string;
  persistName: string | null; // null disables persistence (used by tests)
}

export { AUTO_SESSION_INACTIVITY_MINUTES } from "@/sessions/auto/autoSession";
const RECENT_LOCATIONS_CAP = 8;

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
  /** Phase 3: refresh-populated cloud session history (Task 7's refreshFromCloud writes it; the
   *  cloud paths of listSessions/reopenSession read it). Always [] on the mock/local path. */
  sessions: InventorySession[];
  sessionId: string;
  settings: Settings;

  // deterministic lookup data (seeded; learned aliases are appended and persisted)
  products: Product[];
  aliases: Alias[];

  // live session data
  scanFeed: ScanEvent[]; // newest first
  finalCounts: InventoryCount[];
  needsReviewQueue: UnknownCodeReview[];
  // Task 3.5: rolling snapshots of finalCounts for the variance/shrinkage report. Capped ring buffer
  // (same append-and-slice-oldest pattern as feedbackEvents/appendFeedback), most-recent-last.
  countSnapshots: CountSnapshot[];
  /** Owner feature (2026-07-22): automatically saved history of past scan sessions, newest first.
   *  Written the moment a session ends or rotates away (before scanFeed/finalCounts are wiped) - the
   *  shop owner never has to do anything. Capped ring buffer (see sessionHistory.ts for the caps). */
  sessionHistory: SessionHistoryEntry[];

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

  // shared barcode knowledge (local, offline-first abstraction; a cloud-backed store could replace
  // this later without callers changing, since access always goes through localCatalogProvider.ts)
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
  // Phase 3: this device's stable identity (localStorage-persisted UUID). Null until first read
  // (e.g. non-browser/test contexts, or before the store has touched deviceIdentity). Used only to
  // derive idempotent auto-session ownership - never part of the count/ledger identity.
  deviceId: string | null;
  /** Phase 3: the location to stamp on the NEXT scan (defaults to the session's location; changing
   *  it does not retroactively edit past scans). */
  location: string;
  /** Phase 3: capped ring buffer of recently-used location strings for this business, newest last -
   *  same append-and-slice-oldest pattern as countSnapshots (scanStore.ts:1289-1309). */
  recentLocations: string[];
  /** P6 C2: ISO timestamp of this business's FIRST counted scan (any path - known, provisional, or
   *  conflict), set exactly once. Null until then. Drives the /scan first-run banner
   *  (scanFeed.length === 0 && firstScanAt === null). Local Zustand-persisted state only (MOCK-BACKEND
   *  rule, review F5) - live-auth mode mirroring this to the business doc is explicitly deferred to a
   *  future task, not built here. Reset to null on business switch / sign-out via emptyTenantState. */
  firstScanAt: string | null;
  /** Task 2 (persist-failure surface, 2026-08-09): non-null once the async coalesced persist wrapper's
   *  onPersistFailure has fired at least once (write/migrate/demoted - see scanPersistStorage.ts).
   *  Latches on the FIRST failure (see setPersistDegraded) so a storm of repeated failures does not
   *  spam re-renders; the kind recorded is always the first one seen. Never cleared automatically -
   *  this reflects "this device's storage has shown a failure this session", not live health. Only the
   *  async/IndexedDB persist path can report this (the plain localStorage-only fallback wrapper has no
   *  onPersistFailure hook), so this stays null forever in SSR/jsdom-without-indexedDB/non-persisted
   *  test stores - that is expected, not a bug. */
  persistDegraded: { kind: "write" | "migrate" | "demoted" } | null;

  // actions
  setHasHydrated: (v: boolean) => void;
  /** Task 2: latch-set persistDegraded on the first onPersistFailure callback; a no-op on later calls
   *  (the flag never un-latches within a session). */
  setPersistDegraded: (kind: "write" | "migrate" | "demoted") => void;
  /** Set the signed-in business context (Firebase backend). Enables cloud sync + drains the queue. */
  setBusinessContext: (businessId: string, userId: string) => void;
  /** Pre-sign-out drain guard (F1): if the pending-sync queue is non-empty, attempt one awaited cloud
   *  drain (wrapped so a network failure cannot throw out of sign-out), then return how many items STILL
   *  could not sync. Returns 0 for an empty queue without touching the drain. The UI uses the count to
   *  decide the honest confirm copy - resetForSignOut itself stays a full, unconditional wipe. */
  prepareSignOut: () => Promise<number>;
  /** Sign-out: wipes tenant state to the anon baseline, clears the selected-business key, removes the
   *  signed-out user's per-uid localStorage key, and re-points persist at the anon key. */
  resetForSignOut: () => void;
  /** Re-point persist at this uid's key and rehydrate (no legacy-blob migration). Returns a promise
   *  that resolves once rehydrate has applied, so callers can await it before reading state. */
  rehydrateForUid: (uid: string) => Promise<void>;
  /** Owner-initiated: migrate the legacy pre-account blob into this uid's key, then rehydrate. */
  adoptLegacyLocalData: (uid: string) => Promise<void>;
  startSession: (name: string, location: string) => void;
  /** Mark the current session completed (status=completed, completedAt set) and persist it. */
  finishSession: () => void;
  /** Owner PIN lock. setOwnerPin/resetOwnerPin manage the single owner PIN (stored as a salted hash);
   *  lockSession freezes a session (requires a PIN to be set); unlockSession verifies the entered PIN. */
  setOwnerPin: (pin: string) => Promise<boolean>;
  resetOwnerPin: () => void;
  verifyOwnerPin: (pin: string) => Promise<boolean>;
  hasOwnerPin: () => boolean;
  lockSession: (sessionId: string) => boolean;
  unlockSession: (sessionId: string, pin: string) => Promise<boolean>;
  /** Browse-and-reopen. listSessions returns every saved session (newest first). reopenSession switches the
   *  active context to a saved session and reloads its counts from the durable store. */
  listSessions: () => InventorySession[];
  reopenSession: (sessionId: string) => boolean;
  /** Idempotent per (account, device, time-window): reuses the current session if it is still
   *  ACTIVE, owned by THIS device, and within the inactivity window; otherwise auto-opens a fresh
   *  auto-named session stamped with this device's id. Safe to call on every mount/scan - a no-op
   *  when a valid session already exists. */
  ensureAutoSession: () => void;
  /** Phase 3 cross-device inbound sync: a manual, one-shot refresh (NOT a live listener - see the
   *  sync scout's Trap C on why a listener wired to a naive replace would violate the TOP-LEVEL LAW).
   *  MERGES additively: products/aliases/sessions upsert by id; finalCounts upsert by
   *  (sessionId,productId) EXCEPT rows this device still has an unsynced pendingSyncQueue entry for,
   *  which are left untouched (a stale remote read must never regress a not-yet-synced local count).
   *  No-op on the mock/local backend. Never touches scanFeed. */
  refreshFromCloud: () => Promise<void>;
  /** Set the location to stamp on subsequent scans, and record it in recentLocations (capped,
   *  deduped, most-recent-last). Empty/whitespace-only input is ignored (never stored). */
  setLocation: (location: string) => void;
  processScan: (rawInput: string) => ScanEvent | null;
  syncPending: (force?: boolean) => void;
  retrySync: () => void;
  setOnline: (online: boolean) => void;
  setSimulateSyncFailure: (on: boolean) => void;
  updateSettings: (partial: Partial<Settings>) => void;
  /** Public entry point: ENQUEUES the decode (see the module-level bounded decode queue) and resolves
   *  once it actually runs. Never call `runLiveDecodeOnce` directly outside this queue - that would
   *  bypass the MAX_CONCURRENT_DECODES bound a rapid scan burst relies on. */
  liveDecode: (reviewId: string, options?: { deterministicOnly?: boolean; invalidationGeneration?: number }) => Promise<void>;
  /** The real decode work (network call + evidence gate + count/needs-review routing). Only ever
   *  invoked FROM the `liveDecode` queue wrapper - see the module-level `enqueueDecode`/`drainDecodeQueue`. */
  runLiveDecodeOnce: (reviewId: string, options?: { deterministicOnly?: boolean; invalidationGeneration?: number }) => Promise<void>;
  /** DECODE-EVERYTHING fallback: when the AI decode is SKIPPED (circuit breaker open / rate-limited / AI
   *  unavailable / offline / cap), still COUNT the scan as an UNVERIFIED, reviewable provisional row with a
   *  SAFE label (never fabricated manufacturer anatomy for non-GS1 codes; never an approved alias / verified
   *  product). Idempotent (no double count). The review stays OPEN so a retry can identify it. */
  applyDecodeFallback: (reviewId: string, reason: string) => void;
  /** Idempotent primitive: count one provisional row for `code` (create it if absent), keyed by an
   *  already-existing scan-feed row. Safe to call any number of times for the same code (never double
   *  counts). Used synchronously by processScan and by applyDecodeFallback. Returns the product id the
   *  code is counted under: the already-counted product on the idempotent-hit path, else the freshly
   *  minted provisional's id. markWrong depends on this return to target the CORRECT provisional when
   *  the marked-wrong product is itself a provisional sharing the same primaryBarcode (Task 9 finding:
   *  an unordered products.find could pick the OLD provisional and inflate the total).
   *  `opts.verifyEventId` (FINDING 2, Codex clean-room review, 2026-08-16): the "already counted for
   *  this code" idempotent shortcut is normally correct - repeat scans/enrichment calls for a code that
   *  is already counted must be a no-op. But the Layer C recovery fallback (processScan's outer catch)
   *  calls this AFTER an unexpected throw, when it cannot trust that ANY existing count for this code
   *  actually includes THIS physical scan's own event - the ledger entry that made the shortcut fire
   *  could be exactly the corrupted/stale record that caused the throw in the first place. When
   *  `verifyEventId` is set, the shortcut only fires if that id is actually present in the matched
   *  product's ledger row; otherwise this call force-counts the scan against the SAME product (never
   *  minting a duplicate product row for a code that already has one). */
  ensureProvisionalCount: (
    code: string,
    reason: string,
    opts?: { freshTransferKeys?: boolean; countIfFeedMissing?: boolean; verifyEventId?: string },
  ) => string;
  /** F5 bundle-surgery (wave 2, 2026-07-20): fire-and-forget enrichment for a provisional row's bare
   *  "Unidentified item (...)" label. Called AFTER the row already appears + counts (never before -
   *  TOP-LEVEL LAW is unaffected). Fetches /api/prefix-floor for the DERIVED-tier (2.3MB corpus) brand
   *  the client-safe SEED/LEARNED lookup couldn't see, and upgrades the row's name/brand ONLY if the
   *  row still carries the exact bare fallback label for this code (never clobbers a decoded name, an
   *  already-resolved prefix-floor name, or a human edit that happened while the fetch was in flight).
   *  Offline/failed fetch/no-hit = silent no-op, never an error, never a re-throw. */
  enrichPrefixFloorLabel: (code: string, productId: string) => void;
  /** Flip every not-yet-resolved scan-feed row for `cleanCode` to the "verified" decode badge (shared by
   *  the 4 auto-verify / catalog-hit sites so their badge-flip guard cannot drift). A row already counted
   *  synchronously is status "known" (not "resolved"), so it is still flipped; a row already "verified" or
   *  "resolved" is left untouched. `reason` overrides the row reason when non-empty, else keeps the row's.
   *  P5 Task 5: `provenance` is optional and additive - only the runLiveDecodeOnce call site (which has a
   *  DecodeDecision in scope) passes "app_verified"; the other call sites (global-catalog hit, etc.) omit
   *  it and the row's provenance is simply left unset (badge falls back to the plain "Verified" label). */
  markFeedRowVerified: (cleanCode: string, reason: string, provenance?: ScanEvent["provenance"]) => void;
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
      // "tenant_approval" = a tenant's own human confirmation (feed-row Approve / typed identity): same
      // trust as "human" for THAT tenant's product + alias, but never writes the device-shared verified
      // catalog (platform/app-verified knowledge stays separate from tenant knowledge).
      origin?: "human" | "tenant_approval" | "ai" | "catalog" | "auto_verify" | "auto_count";
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
  /** Build 3: batch-approve the Suggested pile. Groups `reviewIds` into slices of 25 (readability/per-row
   *  containment only - no per-chunk commit, no state isolation between chunks, one synchronous pass) and
   *  calls the EXACT same path as the single-row "Approve suggestion" button (resolveUnknown "create_new",
   *  applyToCount: true, NO origin field, newProduct built from the review's suggested* fields,
   *  selectedAliasCodes = every discovered identifier) for each id - no new approval semantics, no change
   *  to the trust/poison-guard rules, idempotency is resolveUnknown's own open-status guard. A row that
   *  throws, has no open suggestion, or is already resolved/ignored is recorded and the loop continues; it
   *  never aborts the rest of the batch. */
  batchApprove: (reviewIds: string[]) => { approved: string[]; failed: Array<{ id: string; reason: string }> };
  /** Task 9b (owner-ratified 2026-07-14): approve the feed row's PENDING inline suggestion. Routes
   *  through the EXISTING human-approval core (batchApprove -> resolveUnknown "create_new"), so the
   *  idempotency-keyed alias write, poison guard, dedup guard, and provisional upgrade are inherited,
   *  never re-implemented. No-op unless the row's suggestion.status is "pending" (double-tap safe). */
  approveSuggestion: (scanEventId: string) => void;
  /** Best-guess identity (owner decision 2026-08-19): confirm a HUMAN-TYPED identity for a feed row
   *  (the "Identify" / "Edit" confirm sheet). Thin wrapper: it locates the row's still-awaiting review
   *  (open or parked-suggested, creating one when the row has none) and hands the typed fields to the
   *  EXISTING human-approval core, resolveUnknown "create_new" - so the tenant approved alias, count
   *  upgrade, and idempotency come from that one path and are never re-implemented here. Writes tenant
   *  data only: no corpus, no learned tier, no shared cache. No-op on an empty name or a row whose
   *  suggestion is already settled (double-tap safe). */
  confirmRowIdentity: (scanEventId: string, fields: { name: string; brand?: string; category?: string }) => void;
  /** Task 9b: decline the feed row's PENDING inline suggestion ("Not this product"). Renames the
   *  counted provisional row to the prefix floor (or the safe Unidentified placeholder) FIRST, and
   *  ONLY THEN creates/reopens the OPEN Needs Review item (decline is now the only suggestion path
   *  that creates one). No-op unless suggestion.status is "pending" (double-tap safe). */
  declineSuggestion: (scanEventId: string) => void;
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
  /** Phase 6: edit safe product fields (name/brand/category/specs/sku/image/location/unit cost). No alias trust change. */
  correctProduct: (
    productId: string,
    fields: Partial<Pick<Product, "name" | "brand" | "category" | "specsShort" | "specsFull" | "primarySku" | "imageUrl" | "location" | "unitCost">>,
  ) => void;
  /** Phase 6: mark a counted product wrong - deactivate its scanned-code aliases, remove the session count,
   *  reopen Needs Review for the code, and request a correction recheck. Returns the reopened review id. */
  markWrong: (productId: string, opts?: { reason?: string }) => Promise<string | null>;
  /** Phase 6: reopen (or create) an OPEN Needs Review item for a clean code; clears stale suggestions.
   *  Phase 4: an optional importContext carries the import row's quantity + suggestion so an import-origin
   *  review is fully staged (never live-decoded - Phase 4 makes zero /api/ai-lookup calls). */
  reopenNeedsReview: (cleanCode: string, reason: string, importContext?: ImportReviewContext) => string | null;
  /** Phase 4 Task 10: resolve a universal-import preview into store writes. Exact rows resolve via the
   *  human-origin create path (approved) and may auto-count; every non-exact/unmatched row is staged as
   *  Needs Review carrying its quantity and never auto-counts. Duplicate cleanCodes across rows are
   *  aggregated BEFORE any review/count is created so each unique code yields exactly one review/count
   *  carrying the TOTAL quantity (C5). The only write path for a universal import - preview/mapping/match
   *  stay read-only until this is called. */
  applyUniversalImport: (rows: ImportPreviewRow[]) => UniversalImportApplySummary;
  /** Phase 6: correction-only decode recheck. Cost-guarded (one per code unless retry). Never auto-saves. */
  correctionRecheck: (reviewId: string, opts?: { retry?: boolean; reason?: string }) => Promise<void>;
  /** Append a private feedback/event-log entry (the "smarter over time" substrate). */
  recordFeedback: (
    type: FeedbackEventType,
    payload: { code: string; productId?: string | null; meta?: Record<string, string | number | boolean> },
  ) => void;
  /** Task 3.5: capture the CURRENT finalCounts as a labeled CountSnapshot for the variance/shrinkage
   *  report. Prepends to countSnapshots (capped at 12, oldest evicted) and returns the created snapshot. */
  snapshotCount: (label: string) => CountSnapshot;
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

// D3 FIX (shared by ALL THREE orphan-transfer sites: runLiveDecodeOnce's fast-decode auto-link merge,
// backgroundVerifyDeep's deep-verify merge, and resolveUnknown's merge): move an orphan placeholder's
// count onto the merge target, UNIONING the anti-double-count ledger fields (scanEventIds / aliasesSeen /
// appliedIdempotencyKeys) so orphan history survives the merge and a replayed event id stays a no-op.
// Deduped unions keep a repeated merge idempotent. Pure: returns a new array, never mutates. A null
// targetId (or a zero-quantity orphan) just drops the orphan row - identical to each site's old behavior.
// SESSION-SCOPED (root-cause fix 2026-07-22): refreshFromCloud's additive cross-session merge can
// leave finalCounts holding rows for the SAME productId from a DIFFERENT session. Matching the
// target by productId alone (the old behavior) could pour the orphan's quantity onto a foreign
// session's row - which the session-filtered counts table then hides, deflating the visible total
// (the feed-124/counts-122 class). Each orphan row now merges only into a target row of ITS OWN
// session, mirroring incrementInventoryCount's (productId, sessionId) scoping. Exported for tests.
export function transferOrphanCount(
  finalCounts: InventoryCount[],
  oid: string,
  targetId: string | null,
  nowIso: string,
): InventoryCount[] {
  const orphanRows = finalCounts.filter((c) => c.productId === oid);
  let next = finalCounts.filter((c) => c.productId !== oid);
  if (!targetId) return next; // no merge target: drop (identical to each call site's old behavior)
  for (const orphanRow of orphanRows) {
    if (orphanRow.quantity <= 0) continue;
    const targetRow = next.find((c) => c.productId === targetId && c.sessionId === orphanRow.sessionId);
    next = targetRow
      ? next.map((c) =>
          c.productId === targetId && c.sessionId === orphanRow.sessionId
            ? {
                ...c,
                quantity: c.quantity + orphanRow.quantity,
                scanEventIds: Array.from(new Set([...c.scanEventIds, ...orphanRow.scanEventIds])),
                aliasesSeen: Array.from(new Set([...c.aliasesSeen, ...orphanRow.aliasesSeen])),
                appliedIdempotencyKeys: Array.from(new Set([...c.appliedIdempotencyKeys, ...orphanRow.appliedIdempotencyKeys])),
                updatedAt: nowIso,
              }
            : c,
        )
      : [...next, { ...orphanRow, productId: targetId, updatedAt: nowIso }];
  }
  return next;
}

export function buildScanInitializer(deps: ScanStoreDeps) {
  const { db, idFactory, now } = deps;
  const cloudBackend = deps.cloudBackend ?? false;
  const trustedExactProbeEnabled = deps.trustedExactProbeEnabled ?? cloudBackend;

  return (
    set: (partial: Partial<ScanState> | ((s: ScanState) => Partial<ScanState>)) => void,
    get: () => ScanState,
  ): ScanState => {
    const seed = getSeed();
    // Per-store, non-persisted marker for the narrow deterministic-only request. A rapid repeat can
    // then distinguish its own trusted-exact lookup from an ordinary AI decode that happens to share
    // the same provisional row/review shape.
    const trustedExactProbeReviewIds = new Set<string>();
    // A trusted-exact probe is deliberately NOT a review until it misses. Keeping its minimal context
    // outside Zustand means the navigation badge/table cannot observe a transient open review before an
    // authenticated exact hit settles.
    const trustedExactProbes = new Map<string, UnknownCodeReview>();
    const trustedExactProbeIdsByCode = new Map<string, string>();
    let trustedExactProbeGeneration = 0;
    // TASK T3 fix (2026-08-06, audit-9 finding B): the deterministicOnly probe's reasonCode
    // "trusted_exact_not_available" (server allowlist not configured / this business is not in it)
    // must not be swallowed if the decode path it then continues into also misses. This set remembers
    // (by reviewId, which materializeTrustedExactMiss/the continuation call always reuse - see
    // materializeTrustedExactMiss below) which in-flight reviews had that specific config-gap probe
    // outcome, so the eventual settle site can compose an honest reason instead of the generic
    // "not found anywhere" bucket that a genuinely nonexistent code also produces.
    const trustedExactConfigGapReviewIds = new Set<string>();
    const clearTrustedExactProbes = () => {
      trustedExactProbeGeneration++;
      trustedExactProbeReviewIds.clear();
      trustedExactProbes.clear();
      trustedExactProbeIdsByCode.clear();
      trustedExactConfigGapReviewIds.clear();
    };

    // LAYER B (persist-corruption defect, 2026-08-13): defense in depth for processScan, see its call
    // site. Reuses the same field list + coercion rule as sanitizePersistedScanShape (LAYER A, the
    // persist `merge` sanitizer) but operates on the LIVE store state via get()/set(), so a wrong-shape
    // value that reached state through any path other than rehydration (test setup, a future bug) is
    // still repaired in place before it can throw inside resolveScan/ensureProvisionalCount/etc.
    // Idempotent and cheap when the state is already well-shaped (the overwhelmingly common case): no
    // fields differ, so no set() call happens at all. Returns the names of any field that had to be
    // fixed, for the caller's own log message.
    const sanitizeLiveScanStateShape = (): string[] => {
      const current = get();
      const sanitized = sanitizePersistedScanShape(current as unknown as Record<string, unknown>);
      // Every field the shared shape table knows about (array container, array member, object, or
      // nullable-object) - not just the array-shaped ones - so a wrong-shape `settings`/`currentSession`/
      // `lastCleanupBackup` is repaired here too, not only wrong-shape collections.
      const candidateFields = Object.keys(PERSISTED_FIELD_SHAPES);
      const fixed = candidateFields.filter(
        (field) => (current as unknown as Record<string, unknown>)[field] !== sanitized[field],
      );
      if (fixed.length > 0) {
        set(Object.fromEntries(fixed.map((field) => [field, sanitized[field]])) as Partial<ScanState>);
      }
      return fixed;
    };

    const { enqueueAndSync, emitAudit, nextReviewDecisionAt, buildReviewDecisionWrite, persistReviewDecision } =
      createStoreInternals({ set, get, deps, idFactory, now });

    const catalogSlice = createCatalogSlice({ set, get, deps, idFactory, now, emitAudit, enqueueAndSync });

    // Owner feature (2026-07-22): automatically archive the CURRENT session's live scanFeed into
    // sessionHistory the instant it ends or rotates away - called BEFORE the caller wipes scanFeed/
    // finalCounts, so a session with at least one scan is never silently lost. A zero-scan session is
    // not recorded (buildSessionHistoryEntry returns null in that case). Never throws into the caller.
    const archiveCurrentSessionIfAny = () => {
      const s = get();
      if (!s.currentSession) return;
      const getProductName = (matchedProductId: string | null) => {
        const product = matchedProductId ? s.products.find((p) => p.id === matchedProductId) : undefined;
        return product?.name ?? "Unidentified item";
      };
      const entry = buildSessionHistoryEntry(s.currentSession, s.scanFeed, getProductName, now());
      if (!entry) return;
      set((cur) => ({ sessionHistory: appendSessionHistory(cur.sessionHistory, entry) }));
    };

    const sessionSlice = createSessionSlice({
      set, get, idFactory, now, emitAudit, enqueueAndSync, cloudBackend,
      clearTrustedExactProbes, archiveCurrentSessionIfAny,
    });

    const reviewSlice = createReviewSlice({
      set, get, idFactory, now, emitAudit, enqueueAndSync,
      nextReviewDecisionAt, buildReviewDecisionWrite, persistReviewDecision,
    });

    const decodeSlice = createDecodeSlice({
      set, get, deps, idFactory, now, emitAudit, enqueueAndSync, buildReviewDecisionWrite, persistReviewDecision, cloudBackend,
      trustedExactProbes, trustedExactProbeIdsByCode, trustedExactProbeReviewIds, trustedExactConfigGapReviewIds,
      getTrustedExactProbeGeneration: () => trustedExactProbeGeneration,
    });

    // P6 C2: set-once stamp of this business's first EVER counted scan (any path). Called AFTER the
    // count has already been applied at each call site (never before - TOP-LEVEL LAW: counting is never
    // gated on this). Idempotent: a no-op once firstScanAt is already set, so re-scans/re-entries never
    // overwrite the original timestamp. Local Zustand-persisted state only (MOCK-BACKEND rule, review
    // F5) - live-auth mode mirroring this to the business doc is deferred, not built here.
    const markFirstScanIfNeeded = () => {
      if (get().firstScanAt != null) return;
      set({ firstScanAt: now() });
    };

    const { queueItemIdentity, physicalProductKey, applyIndependentProductPhysically, syncPendingCloud, drainCloudOnce } =
      createSyncInternals({ set, get, deps });
    let businessLoadGeneration = 0;

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
      sessions: [],
      settings: DEFAULT_SETTINGS,
      products: seed.products,
      aliases: seed.aliases,
      scanFeed: [],
      finalCounts: [],
      needsReviewQueue: [],
      countSnapshots: [],
      sessionHistory: [],
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
      deviceId: null,
      location: "Main",
      recentLocations: [],
      firstScanAt: null,
      persistDegraded: null,

      setHasHydrated: (v) => set({ _hasHydrated: v }),
      setPersistDegraded: (kind) =>
        set((s) => {
          // Latch on the first kind seen, with ONE exception (F4, 2026-08-09): "demoted" is not a
          // data-loss event (a blocked IndexedDB plus a working localStorage fallback is the design,
          // and the UI shows calm copy for it), so a REAL write/migrate failure that follows must be
          // able to upgrade the latch - otherwise the calm copy stays on screen while writes are
          // genuinely being dropped. A real kind never downgrades back to "demoted".
          if (!s.persistDegraded) return { persistDegraded: { kind } };
          if (s.persistDegraded.kind === "demoted" && kind !== "demoted") return { persistDegraded: { kind } };
          return s;
        }),

      setBusinessContext: (businessId, userId) => {
        const loadGeneration = ++businessLoadGeneration;
        const needsLoad = cloudBackend && !!deps.loadBusinessData;
        // REFRESH GUARD (data-loss fix): a page refresh re-resolves the SAME (businessId, userId)
        // this store already holds and calls setBusinessContext again (BusinessContextGate runs on
        // every mount). That is NOT a tenant switch, so it must never wipe scanFeed/finalCounts/
        // needsReviewQueue/settings/firstScanAt/recentLocations. The cloud loader can restore durable
        // feed/review rows, but it cannot restore this device's unsynced local work, so wiping first
        // would still lose scans and open reviews on reload. Only an ACTUAL tenant/user change (the
        // isolation law below) replaces tenant state before loading the new tenant.
        const contextState = get();
        const sameTenant = contextState.businessId === businessId && contextState.userId === userId;
        // Bug #41 (data-loss race): a scan processed while THIS session still held the placeholder
        // (cloud mode, sign-in bootstrap not yet resolved - userId still null) counted locally and
        // queued for sync tagged with DEMO_BUSINESS_ID. That is not a real tenant switch (no real
        // tenant was ever active in this session), so it must not go through the wipe-and-isolate
        // branch below: the tenant-aware drain (:1731-ish, recomputeSyncStatus above) only matches
        // queue items whose businessId equals the CURRENT tenant, and the placeholder id never
        // becomes the current tenant again - those items would sit stranded forever, never synced,
        // while the UI's own syncStatus derivation would misreport them as already "synced" (see
        // recomputeSyncStatus: it also filters the queue by the CURRENT businessId).
        // Only trigger the rescope path when there is actual placeholder-tagged activity to save -
        // a fresh store's first-ever setBusinessContext call (the ordinary sign-up/cloud-init shape
        // pinned by many existing tests) has an empty scanFeed/pendingSyncQueue/needsReviewQueue and
        // must keep taking the normal wipe-to-clean-slate branch below unchanged.
        const hasPlaceholderActivity =
          contextState.scanFeed.some((e) => e.businessId === DEMO_BUSINESS_ID) ||
          contextState.pendingSyncQueue.some((item) => item.businessId === DEMO_BUSINESS_ID) ||
          contextState.needsReviewQueue.some((r) => r.businessId === DEMO_BUSINESS_ID);
        const isBootstrapResolution =
          cloudBackend &&
          !sameTenant &&
          contextState.businessId === DEMO_BUSINESS_ID &&
          contextState.userId === null &&
          hasPlaceholderActivity;
        if (sameTenant) {
          set({
            businessContextReady: true,
            businessDataLoaded: !needsLoad,
            lastSyncError: null,
          });
        } else if (isBootstrapResolution) {
          // RE-SCOPE ON HYDRATION: keep every placeholder-scoped record (never wipe scanFeed/
          // finalCounts/needsReviewQueue/sessions/products/aliases/settings/pendingSyncQueue) and
          // re-point its businessId (plus queue payload + idempotencyKey) onto the real business.
          // Counts/rows are never lost or doubled - idempotencyKeys keep every non-businessId
          // segment, so an item already applied server-side (if that ever happened) still dedupes,
          // and every future retry of a rescoped item keeps hitting its own new stable identity.
          // The syncPending() call further below (shared with the other two branches) then drains
          // the now-correctly-scoped queue immediately.
          clearTrustedExactProbes();
          // The set this branch is about to rescope IS the adopted set - capture it BEFORE rewriting
          // businessId, so the re-sync rebuild below knows precisely which entities came from the
          // placeholder/mock phase (never touching anything that already belonged to a live tenant).
          const adoptedEventIds = new Set(
            contextState.scanFeed.filter((e) => e.businessId === DEMO_BUSINESS_ID).map((e) => e.id),
          );
          const adoptedReviewIds = new Set(
            contextState.needsReviewQueue.filter((r) => r.businessId === DEMO_BUSINESS_ID).map((r) => r.id),
          );
          const rescopedProducts = contextState.products.map((p) => rescopePlaceholderRecord(p, businessId));
          const rescopedScanFeed = contextState.scanFeed.map((e) => rescopePlaceholderRecord(e, businessId));
          const rescopedFinalCounts = contextState.finalCounts.map((c) => rescopePlaceholderRecord(c, businessId));
          const rescopedReviews = contextState.needsReviewQueue.map((r) => rescopePlaceholderRecord(r, businessId));
          const rescopedQueue = contextState.pendingSyncQueue.map((item) =>
            rescopePlaceholderQueueItem(item, businessId),
          );
          // ADOPTION RE-SYNC: rebuild the sync work for adopted rows the mock backend already flagged
          // "synced" (queue empty). Dedupes by idempotencyKey against the rescoped queue, so the
          // ordinary not-yet-drained shape adds nothing. See buildAdoptionResyncItems.
          const resyncItems = buildAdoptionResyncItems({
            businessId,
            scanFeed: rescopedScanFeed,
            finalCounts: rescopedFinalCounts,
            needsReviewQueue: rescopedReviews,
            products: rescopedProducts,
            existingQueue: rescopedQueue,
            adoptedEventIds,
            adoptedReviewIds,
            idFactory,
            now,
          });
          const nextQueue = resyncItems.length > 0 ? [...rescopedQueue, ...resyncItems] : rescopedQueue;
          // Honest UI: rows with queued work read "pending" until the drain actually lands them, so
          // the adopted inventory never claims a cloud save that has not happened yet.
          const recomputed = recomputeSyncStatus({
            businessId,
            scanFeed: rescopedScanFeed,
            finalCounts: rescopedFinalCounts,
            needsReviewQueue: rescopedReviews,
            pendingSyncQueue: nextQueue,
          });
          set({
            businessId,
            userId,
            businessContextReady: true,
            businessDataLoaded: !needsLoad,
            lastSyncError: null,
            products: rescopedProducts,
            aliases: contextState.aliases.map((a) => rescopePlaceholderRecord(a, businessId)),
            sessions: contextState.sessions.map((s) => rescopePlaceholderRecord(s, businessId)),
            currentSession: contextState.currentSession
              ? rescopePlaceholderRecord(contextState.currentSession, businessId)
              : contextState.currentSession,
            scanFeed: recomputed.scanFeed,
            finalCounts: recomputed.finalCounts,
            needsReviewQueue: recomputed.needsReviewQueue,
            settings: rescopePlaceholderRecord(contextState.settings, businessId),
            pendingSyncQueue: nextQueue,
            // F-5 class closure (2026-08-09): aiLookupLogs carries businessId too and was not being
            // rescoped at all - a platformOwner reading logs after adoption would still see the
            // placeholder tenant id on pre-adoption entries.
            aiLookupLogs: contextState.aiLookupLogs.map((l) => rescopePlaceholderRecord(l, businessId)),
          });
        } else {
          clearTrustedExactProbes();
          // Isolation: every tenant-owned local surface must be cleared synchronously before the async
          // loader restores the selected tenant. Otherwise the prior tenant is briefly visible, and
          // settings or a surface absent from the remote result can linger indefinitely.
          const cleared = emptyTenantState();
          set({
            businessId,
            userId,
            businessContextReady: true,
            businessDataLoaded: !needsLoad,
            lastSyncError: null,
            products: cleared.products,
            aliases: cleared.aliases,
            sessions: cleared.sessions,
            // The old tenant's session must not survive: ensureAutoSession would ADOPT it (spreading
            // its old businessId) and enqueue foreign SAVE_SESSIONs the new tenant's rules deny
            // forever. cleared.currentSession is null, so the next scan mints a fresh session here.
            // NOTE: pendingSyncQueue is deliberately NOT filtered here - the sync drain is tenant-aware
            // (tenantQueueIsolation.store.test.ts), so foreign-tenant items are preserved and drain
            // when their own tenant becomes active again, never clogging under the wrong tenant.
            currentSession: cleared.currentSession,
            sessionId: cleared.sessionId,
            scanFeed: cleared.scanFeed,
            finalCounts: cleared.finalCounts,
            needsReviewQueue: cleared.needsReviewQueue,
            countSnapshots: cleared.countSnapshots,
            settings: cleared.settings,
            firstScanAt: cleared.firstScanAt,
            recentLocations: cleared.recentLocations,
            location: "Main",
            syncedScanEventIds: [],
            lastMismatchWarning: null,
            lastAliasConflicts: null,
            lastCategoryWarning: null,
            aiLookupLogs: [],
            shopOverrides: [],
            feedbackEvents: [],
            lastCleanupBackup: null,
            lastProductDeleteBackup: null,
            lastIdentifierBackfill: null,
            // Tenant isolation: the previous tenant's archived scan log (codes + product names) must
            // never bleed into the next tenant's History page.
            sessionHistory: cleared.sessionHistory,
          });
        }
        const loader = deps.loadBusinessData;
        if (cloudBackend && loader) {
          // Load THIS business's products/aliases from Firestore (pending-aware and never across
          // tenant switches), then drain anything queued. Failure is surfaced, not fatal to the local
          // UI. The pending-aware finalCounts merge below keeps this device's unsynced increments
          // authoritative, so no pre-drain is needed: a local row still referenced by an unsynced
          // INCREMENT_COUNT queue item wins over the remote snapshot until it syncs.
          void (async () => {
            try {
              const data = await loader(businessId, userId);
              if (
                loadGeneration !== businessLoadGeneration ||
                get().businessId !== businessId ||
                get().userId !== userId
              ) {
                return;
              }
              // Reconstruct the active count session + its finalCounts (survive-refresh). Prefer the most
              // recent ACTIVE session; else the most recent overall. finalCounts are the persisted count
              // lines for that session, mapped back to store shape. No session -> keep current defaults.
              const byStartedAtDesc = (a: InventorySession, b: InventorySession) =>
                (b.startedAt ?? "").localeCompare(a.startedAt ?? "");
              const sessions = [...data.sessions].sort(byStartedAtDesc);
              const restored = sessions.find((s) => s.status === "active") ?? sessions[0] ?? null;
              set((cur) => {
                const mergedIdentities = mergeReloadedProductsAndAliases({
                  businessId,
                  localProducts: cur.products,
                  remoteProducts: data.products,
                  localAliases: cur.aliases,
                  remoteAliases: data.aliases,
                  pendingSyncQueue: cur.pendingSyncQueue,
                });
                const next: Partial<ScanState> = {
                  products: mergedIdentities.products,
                  aliases: mergedIdentities.aliases,
                  needsReviewQueue: Array.isArray(data.reviews)
                    ? mergeReloadedReviews({
                        businessId,
                        localReviews: cur.needsReviewQueue,
                        remoteReviews: data.reviews,
                        pendingSyncQueue: cur.pendingSyncQueue,
                      })
                    : cur.needsReviewQueue,
                  businessDataLoaded: true,
                };
                if (restored) {
                  // Same-tenant refresh guard (part 2): the synchronous guard above preserves the local
                  // feed/counts, so this restore must not quietly re-introduce the wipe by REPLACING
                  // finalCounts with the remote snapshot - that snapshot has not seen this device's
                  // unsynced increments, so a refresh with pending work would show a feed of N against
                  // counts of N-k (the exact feed-vs-counts divergence class the guard exists to stop).
                  // Mirror refreshFromCloud's pending-aware merge: a local row still referenced by an
                  // unsynced INCREMENT_COUNT queue item is authoritative until it syncs; otherwise the
                  // remote row wins. A tenant switch starts from a wiped store (empty local counts, empty
                  // queue), so that path degrades to the plain remote restore this used to be.
                  next.currentSession = cur.currentSession?.id === restored.id ? cur.currentSession : restored;
                  next.sessionId = restored.id;
                  const tenantPendingQueue = cur.pendingSyncQueue.filter((it) => it.businessId === businessId);
                  const pendingCountItems = tenantPendingQueue.filter((it) => it.operation === "INCREMENT_COUNT");
                  const pendingCountKeys = new Set(
                    pendingCountItems
                      .map((it) => {
                        const payload = it.payload as Partial<IncrementPayload> | undefined;
                        const productId = payload?.productId;
                        if (!productId) return null;
                        return `${payload.sessionId ?? it.sessionId}|${productId}`;
                      })
                      .filter((key): key is string => !!key),
                  );
                  const pendingCountEntityIds = new Set(pendingCountItems.map((it) => it.entityId));
                  // Seed from the restored session's rows PLUS any row this device still has unsynced
                  // work for: one a pendingSyncQueue item references (any sessionId), or one belonging
                  // to cur.currentSession when that session itself has not synced yet. Otherwise a local
                  // row from a different/unsynced session (e.g. this device's own active session, when
                  // the remote answers with a different restored session) was silently dropped instead
                  // of merged - unsynced local work would vanish on a business-context refresh.
                  const pendingSessionIds = new Set(tenantPendingQueue.map((it) => it.sessionId));
                  const unsyncedCurrentSessionId =
                    cur.currentSession && cur.currentSession.syncStatus !== "synced" ? cur.currentSession.id : null;
                  const countsByKey = new Map(
                    cur.finalCounts
                      .filter(
                        (c) =>
                          c.sessionId === restored.id ||
                          pendingSessionIds.has(c.sessionId) ||
                          pendingCountKeys.has(`${c.sessionId}|${c.productId}`) ||
                          pendingCountEntityIds.has(c.id) ||
                          pendingCountEntityIds.has(`${c.sessionId}_${c.productId}`) ||
                          (unsyncedCurrentSessionId !== null && c.sessionId === unsyncedCurrentSessionId),
                      )
                      .map((c) => [`${c.sessionId}|${c.productId}`, c]),
                  );
                  for (const remote of data.counts) {
                    if (remote.sessionId !== restored.id) continue;
                    const key = `${remote.sessionId}|${remote.productId}`;
                    const local = countsByKey.get(key);
                    const localIsPending =
                      !!local &&
                      (pendingCountKeys.has(key) ||
                        pendingCountEntityIds.has(local.id) ||
                        pendingCountEntityIds.has(`${local.sessionId}_${local.productId}`));
                    if (localIsPending) continue; // guard: unsynced local wins
                    countsByKey.set(key, remote);
                  }
                  next.finalCounts = [...countsByKey.values()];
                  const pendingScanEventIds = new Set(
                    tenantPendingQueue
                      .map((it) => it.scanEventId ?? it.entityId)
                      .filter((id): id is string => !!id),
                  );
                  if (Array.isArray(data.scanEvents)) {
                    const remoteFeed = data.scanEvents
                      .filter((e) => e.sessionId === restored.id)
                      .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
                    const feedById = new Map(remoteFeed.map((e) => [e.id, e]));
                    for (const local of cur.scanFeed) {
                      if (local.sessionId !== restored.id) continue;
                      if (local.syncStatus === "synced" && !pendingScanEventIds.has(local.id)) continue;
                      feedById.set(local.id, local);
                    }
                    next.scanFeed = [...feedById.values()].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
                  }
                }
                return next;
              });
            } catch (e) {
              if (
                loadGeneration !== businessLoadGeneration ||
                get().businessId !== businessId ||
                get().userId !== userId
              ) {
                return;
              }
              // Surface the error but mark loaded so the UI does not hang forever (sync still paused on error).
              set({ lastSyncError: e instanceof Error ? e.message : "Failed to load business data", businessDataLoaded: true });
            }
            if (
              loadGeneration !== businessLoadGeneration ||
              get().businessId !== businessId ||
              get().userId !== userId
            ) {
              return;
            }
            get().syncPending();
          })();
        } else {
          get().syncPending(); // drain anything queued now that we have a real business context
        }
      },

      prepareSignOut: async () => {
        // F1: never destroy unsynced work silently. An empty queue is the common case - return 0 WITHOUT
        // invoking the drain at all (no needless network on a clean sign-out). Otherwise attempt exactly
        // one awaited drain via the established retry path (force=true so an offline flag does not skip
        // it), then report how many items STILL could not sync so the UI can warn honestly. The whole
        // drain is wrapped so a network/provider failure can never throw out of the sign-out handler.
        if (get().pendingSyncQueue.length === 0) return 0;
        try {
          // Cloud path: syncPendingCloud returns the awaitable mutex-chained drain. Mock/local path:
          // syncPending(true) is synchronous, so there is nothing to await - the queue is already
          // reconciled by the time this returns. Either way we then re-read the queue length.
          if (cloudBackend) {
            await syncPendingCloud(true);
          } else {
            get().syncPending(true);
          }
        } catch {
          // Swallow: a failed drain must not abort sign-out. The count below reflects what survived.
        }
        return get().pendingSyncQueue.length;
      },

      resetForSignOut: () => {
        clearTrustedExactProbes();
        // Capture identity BEFORE the reset wipes it: the per-uid key must be removed and the persist
        // middleware re-pointed to the anon key, or the fail-soft coalesced storage would simply
        // rewrite sis-scan-<uid> on the next tick and the "cleared" state would leak right back.
        const uid = get().userId;
        // Re-point persist at the anon key BEFORE the wipe below. Firebase's own SDK auth persistence
        // is cleared by fbSignOut (auth.ts:66-69) in the UI sign-out handlers - that call is the
        // authority for SDK state; this action owns only app state. Guarded on deps.persistName so the
        // non-persisted test store (createTestScanStore, persistName: null) never touches the
        // module-level app store. Doing this BEFORE the wipe (not after) is what stops the coalesced
        // writer from resurrecting the uid key: the coalescer keeps only one pending slot (latest
        // name+value), so once persist is re-pointed, the wipe's own write below targets the anon key
        // and overwrites any older pending write still queued for the uid key. The direct
        // localStorage.removeItem(persistKeyForUid(uid)) further down stays authoritative regardless.
        if (deps.persistName) {
          const persistApi = (useScanStore as unknown as {
            persist?: { setOptions: (o: { name: string }) => void };
          }).persist;
          if (persistApi) persistApi.setOptions({ name: persistKeyForUid(null) });
        }
        const cleared = emptyTenantState();
        set({
          businessId: DEMO_BUSINESS_ID,
          userId: null,
          businessContextReady: !cloudBackend,
          businessDataLoaded: !cloudBackend,
          products: cleared.products,
          aliases: cleared.aliases,
          sessions: cleared.sessions,
          scanFeed: cleared.scanFeed,
          finalCounts: cleared.finalCounts,
          needsReviewQueue: cleared.needsReviewQueue,
          settings: cleared.settings,
          firstScanAt: cleared.firstScanAt,
          recentLocations: cleared.recentLocations,
          pendingSyncQueue: [],
          syncedScanEventIds: [],
          lastSyncError: null,
          // N2: the wipe write also deposits tenant-scoped SESSION IDENTITY + variance SNAPSHOTS into the
          // persisted blob. Clear them too so a signed-out browser holds no residue of the prior tenant's
          // session/report data (and does not spuriously look "non-empty" to legacyBlobIsMeaningful,
          // the shared predicate behind hasMeaningfulLegacyBlobAsync). countSnapshots
          // is the variance ring buffer; currentSession/sessionId are the active-session identity.
          // sessionId is typed `string` (non-nullable), so it is cleared to "" rather than null.
          // sessionHistory carries the tenant's scanned codes - same residue rule.
          countSnapshots: cleared.countSnapshots,
          sessionHistory: [],
          currentSession: cleared.currentSession,
          sessionId: cleared.sessionId,
        });
        if (typeof window !== "undefined" && window.localStorage) {
          try {
            clearSelectedBusinessId(); // sis-selected-business-v1 is NOT uid-namespaced: explicit clear
            if (uid) {
              // F-4 fix (resurrection leak, 2026-08-09): cancel any coalesced write still pending for
              // this key FIRST (the wrapper's own removeItem does this, plus deletes from backing) - or
              // that pending write could land after removePersistedKeyEverywhere and resurrect the key.
              if (deps.persistName) scanPersistBackingStorage.removeItem(persistKeyForUid(uid));
              removePersistedKeyEverywhere(persistKeyForUid(uid));
            }
          } catch {
            // ignore storage errors: the in-memory reset above already holds
          }
        }
      },

      rehydrateForUid: (uid: string) => {
        if (typeof window === "undefined" || !window.localStorage) return Promise.resolve();
        // Re-point storage at this uid's key and rehydrate from it. NO legacy migration here:
        // adopting the pre-account blob is an explicit owner action (adoptLegacyLocalData), never an
        // automatic side effect of signing in (shared-browser inheritance hazard).
        if (!deps.persistName) return Promise.resolve(); // non-persisted test store: nothing to re-point
        const persistApi = (useScanStore as unknown as {
          persist?: { setOptions: (o: { name: string }) => void; rehydrate: () => Promise<void> | void };
        }).persist;
        if (persistApi) {
          persistApi.setOptions({ name: persistKeyForUid(uid) });
          // Returned so callers (BusinessContextGate) can AWAIT rehydrate before calling
          // setBusinessContext - only then does the store's businessId/userId reflect the persisted
          // state, letting the same-tenant refresh guard above actually match on a real refresh.
          return Promise.resolve(persistApi.rehydrate()).then(() => sweepEmptyLegacyResidue());
        }
        return Promise.resolve();
      },

      adoptLegacyLocalData: async (uid: string) => {
        if (typeof window === "undefined" || !window.localStorage) return;
        // OWNER-INITIATED adopt: copy sis-scan-v1 into this uid's key (normalizing quantityDelta:0),
        // DELETE the legacy blob, then hydrate from the adopted key. Returns the rehydrate promise so
        // callers can await it before setBusinessContext (same ordering rule as the main gate path).
        // IDB-aware: when IndexedDB is the active persist backing, migrate through the async/IDB path
        // so the copy actually lands where the store will read it from; otherwise fall back to the
        // original synchronous localStorage-only migration.
        if (typeof indexedDB !== "undefined") {
          await migrateLegacyBlobOnceAsync(uid);
        } else {
          migrateLegacyBlobOnce(uid, window.localStorage);
        }
        // B4 fix (owner-reported false-safety copy, 2026-08-09): the migrate call above has now COPIED
        // the anon blob to this uid's key AND DELETED the legacy blob (migrateLegacyBlobOnce(Async)'s own
        // contract: throws propagate BEFORE that delete, so a throw from the block above always means
        // the anon blob is still intact - "pre-copy"). Everything from this point on runs AFTER the copy
        // has landed, so a failure here is a genuinely different situation: the anon blob no longer
        // exists, and the per-uid key now HOLDS the adopted data. Tag any such failure so the caller
        // (BusinessContextGate) never claims "your local data is still safe" (false) and never offers
        // "start fresh" (which would re-point persist at a per-uid key that now silently contains the
        // just-adopted inventory instead of a fresh empty one).
        try {
          // F-4 fix (resurrection leak, 2026-08-09): migrateLegacyBlobOnce(Async) deletes the legacy key
          // by writing straight to the raw backing store(s), bypassing this store's own coalesced-write
          // wrapper entirely. If a scan happened under the placeholder tenant moments before this adopt
          // (still-pending, not yet flushed - the wrapper batches ~6 writes/scan into at most one write
          // per tick), that pending write's target name/value are untouched by the raw delete above and
          // can still flush AFTER it, re-creating "sis-scan-v1" with the previous user's stale scan data.
          // On a shared device the NEXT sign-in would then see the adopt banner offering that resurrected
          // (and by then orphaned) inventory. Cancel any such pending write for the legacy key now that
          // the copy has landed - this never removes anything not already removed above, it only stops a
          // stale in-flight write for THIS key from landing later.
          if (deps.persistName) scanPersistBackingStorage.removeItem(LEGACY_PERSIST_KEY);
          return await get().rehydrateForUid(uid);
        } catch (err) {
          const tagged = err instanceof Error ? err : new Error(String(err));
          (tagged as Error & { postCopyAdoptFailure?: true }).postCopyAdoptFailure = true;
          throw tagged;
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

      snapshotCount: (label) => {
        const s = get();
        const productById = new Map(s.products.map((p) => [p.id, p]));
        const snapshot: CountSnapshot = {
          id: idFactory(),
          label,
          takenAt: now(),
          lines: s.finalCounts.map((c) => ({
            productId: c.productId,
            name: productById.get(c.productId)?.name ?? "",
            qty: c.quantity,
          })),
        };
        // Same capped-ring-buffer shape as appendFeedback: append newest, slice off the oldest once
        // over the cap, so the most recent snapshot is always last.
        set((cur) => {
          const next = [...cur.countSnapshots, snapshot];
          return { countSnapshots: next.length > COUNT_SNAPSHOT_CAP ? next.slice(next.length - COUNT_SNAPSHOT_CAP) : next };
        });
        return snapshot;
      },

      ...sessionSlice,

      refreshFromCloud: async () => {
        if (!cloudBackend || !deps.loadBusinessData) return; // mock/local path: already the source of truth
        const state = get();
        if (!state.businessContextReady || !state.userId || !state.businessId) return;
        const businessId = state.businessId;
        const userId = state.userId;
        const loadGeneration = ++businessLoadGeneration;
        let data;
        try {
          data = await deps.loadBusinessData(businessId, userId);
        } catch (e) {
          if (
            loadGeneration !== businessLoadGeneration ||
            get().businessId !== businessId ||
            get().userId !== userId
          ) {
            return;
          }
          set({ lastSyncError: e instanceof Error ? e.message : "Failed to refresh from the cloud" });
          return;
        }
        if (
          loadGeneration !== businessLoadGeneration ||
          get().businessId !== businessId ||
          get().userId !== userId
        ) {
          return;
        }
        set((cur) => {
          const tenantPendingQueue = cur.pendingSyncQueue.filter((it) => it.businessId === businessId);
          // Products/aliases: one shared pending-aware reload policy with setBusinessContext.
          // Remote rows replace non-pending local rows and add remote-only rows, but this device's
          // still-unsynced SAVE_PRODUCT / RESOLVE_ALIAS rows remain authoritative until they drain.
          // A locally archived product also stays archived against stale active remote snapshots.
          const mergedIdentities = mergeReloadedProductsAndAliases({
            businessId,
            localProducts: cur.products,
            remoteProducts: data.products,
            localAliases: cur.aliases,
            remoteAliases: data.aliases,
            pendingSyncQueue: cur.pendingSyncQueue,
          });
          const sessionsById = new Map(cur.sessions.map((s) => [s.id, s]));
          // Preserve previously refreshed history and fold in the current session before applying
          // the remote list, so a refresh never silently drops this device's own active session.
          if (cur.currentSession) sessionsById.set(cur.currentSession.id, cur.currentSession);
          for (const s of data.sessions) sessionsById.set(s.id, s);

          // finalCounts: additive upsert by (sessionId,productId), EXCEPT any row still referenced by
          // a pending (unsynced) queue item - that row's local value is authoritative until it syncs.
          const pendingCountItems = tenantPendingQueue.filter((it) => it.operation === "INCREMENT_COUNT");
          const pendingCountKeys = new Set(
            pendingCountItems
              .map((it) => {
                const payload = it.payload as Partial<IncrementPayload> | undefined;
                const productId = payload?.productId;
                if (!productId) return null;
                return `${payload.sessionId ?? it.sessionId}|${productId}`;
              })
              .filter((key): key is string => !!key),
          );
          const pendingCountEntityIds = new Set(pendingCountItems.map((it) => it.entityId));
          // Products THIS device archived before the merge (its own deletes) - distinguishes a
          // local delete from one performed on another device (see the archived branch below).
          const locallyArchivedIds = new Set(cur.products.filter((p) => p.status === "archived").map((p) => p.id));
          const countsByKey = new Map(cur.finalCounts.map((c) => [`${c.sessionId}|${c.productId}`, c]));
          const mergedProductsById = new Map(mergedIdentities.products.map((product) => [product.id, product]));
          for (const remote of data.counts) {
            const key = `${remote.sessionId}|${remote.productId}`;
            const local = countsByKey.get(key);
            // pendingCountKeys deliberately does NOT require a local row: the delete-transfer's
            // zero-out increment targets a (sessionId, productId) row that no longer exists locally
            // (it was repointed onto the provisional), yet the remote copy must still not be
            // re-added while that op is pending.
            const localIsPending =
              pendingCountKeys.has(key) ||
              (!!local &&
                (pendingCountEntityIds.has(local.id) ||
                  pendingCountEntityIds.has(`${local.sessionId}_${local.productId}`)));
            if (localIsPending) continue; // guard: unsynced local wins
            if (mergedProductsById.get(remote.productId)?.status === "archived") {
              // Delete-transfer guard (reviewed defect 2026-07-22): a remote count row keyed to a
              // LOCALLY-archived product is the backend's not-yet-transferred (or stale-snapshot)
              // copy of a product THIS device deleted. deleteProductsInternal already repointed
              // those units onto a minted provisional, so re-adding the remote row here would
              // double-count them (2 became 4). The archived-product merge guard above keeps a
              // local archive authoritative, so this holds even after the transfer ops drained.
              if (locallyArchivedIds.has(remote.productId)) continue;
              // Cross-device delete (reviewed defect 2026-07-22): the archive came from the REMOTE
              // (this device's copy was still active - ANOTHER device deleted it). The remote row
              // is the post-transfer zeroed truth; skipping it would keep the stale local row
              // alive NEXT TO the remote provisional row (2 became 4 on every other device), so
              // fall through and let the remote (zeroed) row replace the stale local one.
            }
            countsByKey.set(key, remote);
          }

          return {
            products: mergedIdentities.products,
            aliases: mergedIdentities.aliases,
            needsReviewQueue: Array.isArray(data.reviews)
              ? mergeReloadedReviews({
                  businessId,
                  localReviews: cur.needsReviewQueue,
                  remoteReviews: data.reviews,
                  pendingSyncQueue: cur.pendingSyncQueue,
                })
              : cur.needsReviewQueue,
            sessions: [...sessionsById.values()],
            finalCounts: [...countsByKey.values()],
            lastSyncError: null,
          };
        });
      },

      setLocation: (location) => {
        const trimmed = location.trim();
        if (!trimmed) return;
        set((s) => {
          const withoutDup = s.recentLocations.filter((l) => l !== trimmed);
          const next = [...withoutDup, trimmed];
          return {
            location: trimmed,
            recentLocations: next.length > RECENT_LOCATIONS_CAP ? next.slice(next.length - RECENT_LOCATIONS_CAP) : next,
          };
        });
      },

      processScan: (rawInput) => {
        // LAYER C / OUTER SAFETY NET (third-review hardening, 2026-08-16; widened FOURTH-review,
        // 2026-08-16): LAYER A (persist merge) and LAYER B (sanitizeLiveScanStateShape, just below)
        // close every KNOWN wrong-shape variant found so far. But a reviewer has now found this class
        // of bug FOUR times - the only way to guarantee the TOP-LEVEL LAW against a still-unknown
        // variant is to make processScan itself structurally incapable of letting a throw escape
        // without first committing a safe row. FINDING 1 (independent Codex clean-room review,
        // 2026-08-16): the try used to start AFTER session initialization (ensureAutoSession, which
        // calls getOrCreateDeviceId -> raw localStorage.getItem/setItem) - a throw there (Safari private
        // mode, blocked cookies, full quota) escaped processScan entirely with no Layer C log, no
        // fallback row, no count. The try now starts at the very top of this action so NOTHING in its
        // synchronous body - including session init - sits outside the safety net. `cleanedCaught` and
        // `scanEventIdCaught` are hoisted `let`s (assigned inside the try, never re-declared) purely so
        // the catch can still identify which physical scan needs recovering.
        let cleanedCaught: ReturnType<typeof cleanScanCode> | undefined;
        let scanEventIdCaught: string | undefined;
        try {
        // TOP-LEVEL LAW / Phase 3 defect F1: a scanned code must ALWAYS appear on the feed and count,
        // even when the current session is locked (owner PIN) or completed (Finish). Those guards
        // decide the session's own frozen/read-only status; they must never make a physical scan
        // vanish. So instead of dropping the scan, ROTATE to a fresh active session and count it
        // there - reusing the exact mechanism ensureAutoSession/mount already use for a stale/absent
        // session - leaving the locked/completed session and its counts untouched and auditable.
        // Callers (the scan page) also call ensureAutoSession before every scan batch; this is the
        // hard backstop for any path (including the internal resolveUnknown -> processScan re-apply
        // call) that does not.
        if (!get().sessionId || !get().currentSession || get().currentSession?.locked || get().currentSession?.status === "completed") {
          get().ensureAutoSession();
        }
        const scanLocation = get().location;
        const scanDeviceId = get().deviceId;
        const cleaned = cleanScanCode(rawInput);
        cleanedCaught = cleaned;
        if (!cleaned.cleanCode) return null;

        // LAYER B (persist-corruption defect, 2026-08-13): defense in depth alongside LAYER A's persist
        // `merge` sanitizer above. `ensureProvisionalCount`'s ordering already enforces the TOP-LEVEL
        // LAW that every scan appears + counts - but that guarantee only holds if nothing BEFORE (or
        // called FROM) it can throw. `products`/`aliases` are filtered/mapped/found across the resolver,
        // the alias matcher, AND ensureProvisionalCount itself (all reading live store state via get()),
        // so a wrong-shape value reaching this far - from any future path, not just the persist boundary
        // LAYER A already closes - would throw somewhere in that chain and silently drop the scan.
        // Sanitize the STORE STATE itself (not just a local copy) so every subsequent get() in this
        // call, including nested action calls like ensureProvisionalCount, sees well-shaped data too.
        // Loudly logged, never silently swallowed.
        const stateShapeIssues = sanitizeLiveScanStateShape();
        if (stateShapeIssues.length > 0) {
          console.error(
            `[scanStore] processScan: store state had wrong-shape field(s) (${stateShapeIssues.join(", ")}); ` +
              `reset to [] so this scan still appears and counts (TOP-LEVEL LAW).`,
          );
        }
        const { products, aliases, businessId, sessionId } = get();
        // Deterministic resolver only. AI is never consulted here. Known requires verified/approved.
        // Wrapped: any unexpected throw inside resolution degrades this scan to "unidentified" (still
        // appears + counts via the needs_review path below) instead of propagating out of processScan
        // and silently dropping the row.
        let resolution: ResolverResult;
        try {
          resolution = resolveScan(cleaned, products, aliases, businessId);
        } catch (err) {
          console.error(
            `[scanStore] resolveScan threw for code '${cleaned.cleanCode}'; degrading to unidentified ` +
              `so the scan still appears and counts (TOP-LEVEL LAW).`,
            err,
          );
          resolution = {
            rawCode: cleaned.rawCode,
            cleanCode: cleaned.cleanCode,
            normalizedCandidates: cleaned.normalizedCandidates,
            codeType: "messy",
            resolverStatus: "needs_review",
            matchType: "unknown",
            productId: null,
            confidence: 0,
            reason: "Internal error while resolving this code; it was routed to Needs Review as unidentified.",
          };
        }
        const scanEventId = idFactory();
        scanEventIdCaught = scanEventId;
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
        // PHASE 2 re-scan dedup: the deterministic resolver only returns "known" for an APPROVED alias /
        // VERIFIED product. A weak AI suggestion is counted as a PROVISIONAL product (verified:false, NO
        // approved alias), which the resolver intentionally misses - so a re-scan would re-decode / duplicate.
        // Bridge it deterministically: if a STILL-COUNTED, UNVERIFIED product carries this exact code as an
        // identifier, count THAT product (exact identifier match only, never fuzzy, no AI). A human approval
        // later flips it verified + approved, after which the resolver matches it as a normal Known.
        let provMatchId: string | null = null;
        if (!countable && !knownConflict) {
          const countedIds = new Set(get().finalCounts.map((c) => c.productId));
          const ids = [cleaned.cleanCode, ...(cleaned.normalizedCandidates ?? [])];
          provMatchId =
            products.find(
              (p) =>
                countedIds.has(p.id) &&
                p.status !== "archived" &&
                p.provisional === true &&
                [p.primaryBarcode, p.gtin, p.upc, p.ean, p.primarySku].map((c) => (c ?? "").trim()).some((c) => !!c && ids.includes(c)),
            )?.id ?? null;
        }
        const pendingTrustedExactReview = provMatchId
          ? get().needsReviewQueue.find(
              (review) =>
                trustedExactProbeReviewIds.has(review.id)
                && review.provisionalProductId === provMatchId
                && review.sessionId === sessionId
                && review.cleanCode === cleaned.cleanCode
                && review.status === "open"
                && review.decodeStatus === "decoding",
            ) ?? [...trustedExactProbes.values()].find(
              (probe) =>
                probe.provisionalProductId === provMatchId
                && probe.sessionId === sessionId
                && probe.cleanCode === cleaned.cleanCode,
            )
          : undefined;
        const effectiveProductId = resolution.productId ?? provMatchId;
        const effectiveCountable = countable || !!provMatchId;
        if (knownConflict === "category_context_conflict") {
          // Phase 9: surface the non-blocking category warning banner (the scan still routes to review).
          set({ lastCategoryWarning: { code: cleaned.cleanCode, productName: matchedProduct?.name ?? "this product", reason: knownConflict } });
        }

        const event: ScanEvent = stampScanEventLocation(
          {
            id: scanEventId,
            businessId,
            sessionId,
            rawCode: cleaned.rawCode,
            cleanCode: cleaned.cleanCode,
            normalizedCandidates: cleaned.normalizedCandidates,
            matchedProductId: effectiveProductId,
            matchType: resolution.matchType,
            status: effectiveCountable ? "known" : resolution.resolverStatus === "conflict" ? "conflict" : "needs_review",
            resolverStatus: resolution.resolverStatus,
            codeType: resolution.codeType,
            reason: pendingTrustedExactReview?.reason
              ?? (provMatchId ? "Counted (suggested - awaiting your confirmation)." : resolution.reason),
            decodeStatus: pendingTrustedExactReview ? "decoding" : provMatchId ? "suggested" : undefined,
            quantityDelta: effectiveCountable ? 1 : 0,
            quantityAfterScan: 0,
            createdAt,
            source: "scan",
            notes: resolution.reason,
            syncStatus: "pending",
            idempotencyKey: keyFor("INCREMENT_COUNT"),
            syncError: null,
          },
          scanLocation,
          scanDeviceId,
        );

        // BEST GUESS ON EVERY SCAN OF THE CODE (owner decision 2026-08-19): a repeat scan of a code whose
        // best guess is already on screen carries the SAME pending suggestion (and its confirm controls)
        // onto this new row, instead of a bare row with no identity. Display only - the decode that
        // produced it settled long ago, so this costs nothing and re-decodes nothing.
        // Never on a deterministically KNOWN row: that identity is settled, a guess would only muddy it.
        const awaitingReview = isKnown
          ? undefined
          : get().needsReviewQueue.find(
              (r) =>
                r.cleanCode === cleaned.cleanCode &&
                (r.status === "open" || r.status === "suggested") &&
                isUsableProductName(r.suggestedProductName),
            );
        if (awaitingReview) {
          event.suggestion = {
            productName: awaitingReview.suggestedProductName,
            brand: awaitingReview.suggestedBrand,
            confidence: awaitingReview.confidence,
            // No status passed: a review still awaiting a human is by definition not a verified identity.
            band: getIdentityConfidenceBand({
              confidence: awaitingReview.confidence,
              evidenceStrength: awaitingReview.evidenceStrength,
              exactCodeEvidenceVerifiedByApp: awaitingReview.exactCodeEvidenceVerifiedByApp,
            }),
            status: "pending",
          };
        }

        if (effectiveCountable && effectiveProductId) {
          // Deterministic increment in local state FIRST (instant UI, no server round-trip).
          const { counts, count } = incrementInventoryCount(get().finalCounts, event, idFactory);
          event.quantityAfterScan = count.quantity;

          set((s) => ({
            scanFeed: [event, ...s.scanFeed],
            finalCounts: counts.map((c) =>
              c.productId === event.matchedProductId && c.sessionId === event.sessionId
                ? { ...c, location: scanLocation }
                : c,
            ),
          }));
          // P6 C2: written AFTER the count above is applied - never before (TOP-LEVEL LAW).
          markFirstScanIfNeeded();

          const incPayload: IncrementPayload = {
            businessId,
            sessionId,
            productId: effectiveProductId,
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
          // OWNER RULE "scan N = count N": even a known-but-context-conflicted scan must COUNT (the physical
          // item is on the shelf). Count it provisionally against a SAFE "Unidentified item" placeholder -
          // never against the suspect/poisoned matched product - and keep the review open so a human confirms
          // the real identity. ensureProvisionalCount is idempotent PER CODE (mints the placeholder once and
          // counts it once) - it never counts a REPEAT physical scan of the same conflicted code (F-02,
          // TOP-LAW). Detect a repeat the same way the provMatchId bridge does for non-conflict provisionals
          // (2208-2222): if a safe placeholder for this code is ALREADY counted, mint a FRESH counting event
          // (this scan's own scanEventId + idempotency keys) directly against that placeholder - never
          // against the poisoned resolution.productId - so N repeated conflict scans produce N counts.
          const conflictCandidates = [cleaned.cleanCode, ...(cleaned.normalizedCandidates ?? [])];
          const conflictCountedIds = new Set(get().finalCounts.map((c) => c.productId));
          const repeatPlaceholderId =
            get().products.find(
              (p) =>
                conflictCountedIds.has(p.id) &&
                p.status !== "archived" &&
                p.provisional === true &&
                [p.primaryBarcode, p.gtin, p.upc, p.ean, p.primarySku]
                  .map((c) => (c ?? "").trim())
                  .some((c) => !!c && conflictCandidates.includes(c)),
            )?.id ?? null;
          if (repeatPlaceholderId) {
            const repeatEvent: ScanEvent = {
              ...event,
              matchedProductId: repeatPlaceholderId,
              status: "known",
              quantityDelta: 1,
              decodeStatus: "suggested",
            };
            const { counts, count } = incrementInventoryCount(get().finalCounts, repeatEvent, idFactory);
            repeatEvent.quantityAfterScan = count.quantity;
            set((s) => ({
              scanFeed: s.scanFeed.map((e) => (e.id === repeatEvent.id ? repeatEvent : e)),
              finalCounts: counts.map((c) =>
                c.productId === repeatEvent.matchedProductId && c.sessionId === repeatEvent.sessionId
                  ? { ...c, location: scanLocation }
                  : c,
              ),
            }));
            // P6 C2: written AFTER the count above is applied - never before (TOP-LEVEL LAW).
            markFirstScanIfNeeded();
            const repeatIncPayload: IncrementPayload = {
              businessId,
              sessionId,
              productId: repeatPlaceholderId,
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
                payload: repeatEvent,
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
                payload: repeatIncPayload,
                idempotencyKey: keyFor("INCREMENT_COUNT"),
                scanEventId,
              }),
            ]);
            get().recordFeedback("conflict_detected", { code: cleaned.cleanCode });
            return repeatEvent;
          }
          get().ensureProvisionalCount(cleaned.cleanCode, conflictText);
          // STABLE-ID FIX: the placeholder now exists (minted just above); stamp its id onto this review
          // (new or pre-existing open one) so resolveUnknown can re-link by id after a customer reload
          // instead of by reconstructed name (see provisionalProductId doc comment in types.ts).
          const conflictPlaceholder = get().products.find(
            (p) => p.provisional === true && p.status !== "archived" && p.primaryBarcode === cleaned.cleanCode,
          );
          if (conflictPlaceholder) {
            set((s) => ({
              needsReviewQueue: s.needsReviewQueue.map((r) =>
                r.cleanCode === cleaned.cleanCode && r.status === "open" && !r.provisionalProductId
                  ? { ...r, provisionalProductId: conflictPlaceholder.id }
                  : r,
              ),
            }));
          }
          get().recordFeedback("conflict_detected", { code: cleaned.cleanCode });
          return event;
        }

        // Unknown or conflict. AGGRESSIVE AUTO DECODE: if AI is on and a key is configured, run the
        // live decode pipeline automatically instead of dropping straight to passive Needs Review.
        const settings = get().settings;
        const today = createdAt.slice(0, 10);
        const dailyCount = settings.lastResetDate === today ? settings.dailyLookupCount : 0;
        let autoGate = evaluateAutoDecode({
          aiEnabled: settings.aiLookupEnabled,
          status: get().aiStatus,
          online: get().online,
          dailyCount,
          dailyLimit: settings.dailyLookupLimit,
          breaker: get().breaker,
          now: new Date(createdAt).getTime(),
          platformOwner: isPlatformOwnerForGateBypass(get().userId),
        });
        // A3 (owner-ratified 2026-07-15, narrowed by AM-2): a code whose GS1 check digit fails can
        // never decode correctly because every downstream identity lookup keys off the code - dispatching the
        // decode here only burns time and cap budget chasing a doomed lookup. Skip auto-decode
        // entirely; the row stays a normal, aliasable needs_review row (never "decoding") with the
        // additive misread reason already set by the resolver. Overriding here (rather than after
        // row creation) keeps decodeStatus honest from the very first render - never "decoding" then
        // silently reverted. A valid unknown GTIN is never affected by this check.
        // QA HARDENING FIX #6 (live-proven): captured once and reused below at the catalog-first seam -
        // a misread code must never mint a fabricated identity there either (see that call site).
        const misread = isLikelyMisreadGtin(cleaned.cleanCode);
        if (misread) {
          autoGate = { allowed: false, reason: "Scan misread - decode was not attempted." };
        }
        const deterministicCandidate = trustedExactProbeCandidate(cleaned.cleanCode);
        const deterministicLookupEligible = trustedExactProbeEnabled
          && get().online
          && deterministicCandidate;
        const lookupPending = autoGate.allowed || deterministicLookupEligible;

        const existingOpen = get().needsReviewQueue.find(
          (r) => r.cleanCode === cleaned.cleanCode && r.status === "open",
        );

        // Customer-safe split: the feed REASON is the deterministic resolver explanation only (product-
        // facing, no AI/provider/Settings mechanics). The auto-decode "why" (e.g. lookup not configured)
        // goes to decodeNote, which LiveScanFeed shows ONLY to platformOwner. The internal gate reason
        // text is unchanged (still used for aiLookupLogs/diagnostics).
        event.decodeStatus = existingOpen?.decodeStatus ?? (lookupPending ? "decoding" : "needs_review");
        event.reason = existingOpen?.reason ?? resolution.reason;
        event.decodeNote = existingOpen?.decodeNote ?? autoGate.reason;

        set((s) => ({ scanFeed: [event, ...s.scanFeed] }));

        // OWNER RULE "scan N = count N": count EVERY unresolved scan immediately, synchronously, before any
        // network work. The AI/catalog lookup below only ENRICHES this provisional row (name/verified); it
        // can never again decide whether the scan counts. ensureProvisionalCount is idempotent, so the later
        // decode handlers (which filter on status !== "known") find nothing to re-count.
        get().ensureProvisionalCount(cleaned.cleanCode, resolution.reason);

        if (deterministicLookupEligible) {
          // Repeats share the in-flight probe, while each physical scan has already received its own
          // synchronous feed/count event above.
          if (trustedExactProbeIdsByCode.has(cleaned.cleanCode)) return event;
          const mintedPlaceholder = get().products.find(
            (p) => p.provisional === true && p.status !== "archived" && p.primaryBarcode === cleaned.cleanCode,
          );
          const probe: UnknownCodeReview = {
            id: idFactory(), businessId, sessionId, rawCode: cleaned.rawCode, cleanCode: cleaned.cleanCode,
            normalizedCandidates: cleaned.normalizedCandidates,
            suggestedProductName: "", suggestedBrand: "", suggestedCategory: "", suggestedSpecsShort: "", suggestedSpecsFull: "",
            suggestedPrimarySku: "", suggestedPrimaryBarcode: "", suggestedGtin: "", suggestedUpc: "", suggestedEan: "",
            suggestedImageUrl: "", suggestedProductUrl: "", suggestedAliases: [], sourceUrls: [], verifiedFacts: [], guesses: [],
            reason: resolution.reason, decodeNote: autoGate.reason, providerName: "", confidence: 0, hasSuggestion: false,
            decodeStatus: "decoding", evidenceStrength: "none", exactCodeEvidenceVerifiedByApp: false, crossCheckDecision: "",
            status: "open", createdAt, resolvedAt: null, resolvedBy: null, resolutionAction: null, syncStatus: "pending",
            idempotencyKey: keyFor("SAVE_UNKNOWN_SCAN"), provisionalProductId: mintedPlaceholder?.id ?? null,
            suggestedLinkProductId: resolution.nearMatchSuggestion?.productId,
          };
          trustedExactProbes.set(probe.id, probe);
          trustedExactProbeIdsByCode.set(probe.cleanCode, probe.id);
          trustedExactProbeReviewIds.add(probe.id);
          void get().liveDecode(probe.id, {
            deterministicOnly: true,
            invalidationGeneration: trustedExactProbeGeneration,
          }).then(
            () => trustedExactProbeReviewIds.delete(probe.id),
            () => trustedExactProbeReviewIds.delete(probe.id),
          );
          return event;
        }

        if (!existingOpen) {
          // STABLE-ID FIX: ensureProvisionalCount just ran synchronously above, so this code's placeholder
          // product (if one was minted) already exists in state. Capture its id now so resolveUnknown can
          // re-link this review to it by id later, even after a customer reload strips the placeholder's
          // `provisional` flag and identifier fields (see provisionalProductId doc comment in types.ts).
          const mintedPlaceholder = get().products.find(
            (p) => p.provisional === true && p.status !== "archived" && p.primaryBarcode === cleaned.cleanCode,
          );
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
            decodeStatus: lookupPending ? "decoding" : "needs_review",
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
            provisionalProductId: mintedPlaceholder?.id ?? null,
            // QA Task 8 (owner-approved 2026-07-15): review-only "Did you mean <X>?" near-match SKU
            // suggestion from the deterministic resolver (distance<=1, single candidate only - see
            // resolver.ts findNearMatchSuggestion). Reuses the EXACT same one-tap "Link to <product>"
            // UI/path as the identity-merge suggest_link (NeedsReviewTable's suggestedLinkProductId),
            // which already routes exclusively through the human-approved link_existing action. This
            // NEVER auto-counts and NEVER auto-aliases - resolverStatus/decodeStatus above are
            // untouched (still a normal needs_review row awaiting a human).
            suggestedLinkProductId: resolution.nearMatchSuggestion?.productId,
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

          // Every trusted-exact candidate gets the isolated deterministic-only request first. A valid
          // GTIN miss may later enter the unchanged ordinary queue; non-GTIN, misread, and gate-blocked
          // misses remain counted/reviewable without provider egress.
          // CATALOG-FIRST (offline-first, saves AI tokens): private shop override -> verified shared
          // catalog. A verified hit resolves + counts with NO AI, even with no key / offline. AI only
          // runs on a miss or a weak/conflicting catalog hit.
          // QA HARDENING FIX #6 (live-proven, 2026-07-16): a misread (bad-check-digit) GTIN must NEVER
          // attach a fabricated identity here either. `codeSet.has(entry.normalizedBarcode)` in
          // localCatalogProvider.ts has no check-digit awareness, so a bad code that happens to
          // string-match a seeded catalog entry's normalizedBarcode (e.g. a coincidental zero-pad
          // collision) would otherwise mint a named product via resolveUnknown("create_new",
          // {origin:"catalog"}) - the exact bug that attached "Healthyholics" to an invalid UPC. Skip
          // computing `decision` entirely when misread (cleaner than gating the `if` below): this also
          // avoids polluting the catalog's timesScanned/observeScan bookkeeping with a bad-code hit.
          // The row already fell through to needs_review with the honest misread reason set above.
          const codes = [cleaned.cleanCode, ...cleaned.normalizedCandidates];
          const decision = misread
            ? { source: "none" as const, hit: null, shouldResolveWithoutAi: false, shouldTryAi: true }
            : decideLookup(get().catalog, get().shopOverrides, codes, businessId);
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
            get().markFeedRowVerified(
              cleaned.cleanCode,
              `Matched from ${fromOverride ? "shop override" : "verified catalog"} - no AI used.`,
            );
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
            // FIX 5: swallow a rejection here (e.g. a dev-assert throw from the GC1 hard invariant)
            // so it never becomes an unhandled promise rejection - siblings already do this (line ~1138).
            void get().cloudCatalogResolve(review.id, codes).catch(() => {});
          } else if (autoGate.allowed) {
            void get().liveDecode(review.id);
          } else {
            // AI decode SKIPPED. Only fire the provisional fallback when decode was INTENDED but blocked
            // by a TRANSIENT cause (circuit breaker, rate-limit, offline, cap). When AI is explicitly
            // disabled or keys are missing, the scan goes to Needs Review without a provisional count
            // (the user chose not to decode — do not fabricate a product).
            const s = get();
            const aiIntended = s.settings.aiLookupEnabled && s.aiStatus.openaiConfigured;
            if (aiIntended) {
              get().applyDecodeFallback(
                review.id,
                `${autoGate.reason ?? "AI decode unavailable."} Counted as unverified; retry to identify.`.trim(),
              );
            }
          }
        }
        return event;
        } catch (outerErr) {
          // LAYER C catch: log loudly (never silently swallowed) and guarantee the row still appears
          // and counts. ensureProvisionalCount is idempotent - if a scanFeed row for this code was
          // already committed by an earlier branch before the throw, it repoints THAT row instead of
          // minting a duplicate; if none exists yet, it mints both the safe placeholder product and a
          // synthetic backing scanFeed row so the physical scan is never lost.
          //
          // FINDING 1 continued: `cleanedCaught` may still be unset (the throw happened before it was
          // ever assigned, e.g. inside ensureAutoSession/getOrCreateDeviceId before the fail-soft fix,
          // or some still-unknown FIFTH variant). cleanScanCode is pure and cheap - recompute it here,
          // defensively, so this recovery path still has a code to recover even in that case.
          let recoveredCleanCode: string;
          try {
            recoveredCleanCode = cleanedCaught ? cleanedCaught.cleanCode : cleanScanCode(rawInput).cleanCode;
          } catch (cleanErr) {
            console.error(
              `[scanStore] processScan: even recomputing the clean code failed for raw input; the scan ` +
                `cannot be recovered. This is the true last resort.`,
              cleanErr,
            );
            recoveredCleanCode = "";
          }
          console.error(
            `[scanStore] processScan: unexpected error while processing code '${recoveredCleanCode}'; ` +
              `routing to Needs Review as unidentified so the scan still appears and counts (TOP-LEVEL LAW).`,
            outerErr,
          );
          if (!recoveredCleanCode) {
            return get().scanFeed[0] ?? null;
          }
          try {
            get().ensureProvisionalCount(
              recoveredCleanCode,
              "Internal error while processing this scan; it was routed to Needs Review as unidentified.",
              // FINDING 2 FIX: pass THIS scan's own event id so ensureProvisionalCount's idempotent
              // shortcut cannot be fooled by an unrelated/stale existing count for the same code - see
              // its doc comment. Only meaningful when scanEventId was actually minted before the throw.
              scanEventIdCaught ? { verifyEventId: scanEventIdCaught } : undefined,
            );
          } catch (fallbackErr) {
            // True last resort: even the safe fallback path itself threw. Still never rethrow out of
            // processScan (that would be the original silent-drop defect all over again) - log and
            // return whatever the feed already shows for this code, if anything.
            console.error(
              `[scanStore] processScan: fallback ensureProvisionalCount ALSO threw for code ` +
                `'${recoveredCleanCode}'; the scan may not have counted. This is the true last resort.`,
              fallbackErr,
            );
          }
          // FINDING 3 (recovery must prove itself, not just claim success): assert a committed feed row
          // AND ledger application actually exist for THIS scan before calling the recovery successful.
          // A caller (or a human reading the log) must be able to tell "recovered" apart from "lost" -
          // returning an older same-code row as if it were proof of success is exactly how the original
          // loss stayed invisible.
          const recoveredState = get();
          const ownRecoveredRow = scanEventIdCaught
            ? recoveredState.scanFeed.find((e) => e.id === scanEventIdCaught)
            : recoveredState.scanFeed.find((e) => e.cleanCode === recoveredCleanCode);
          const ledgerHasOwnEvent =
            !!ownRecoveredRow &&
            recoveredState.finalCounts.some(
              (c) => c.productId === ownRecoveredRow!.matchedProductId && Array.isArray(c.scanEventIds) && c.scanEventIds.includes(ownRecoveredRow!.id),
            );
          if (!ownRecoveredRow || !ledgerHasOwnEvent) {
            console.error(
              `[scanStore] processScan: LAYER C RECOVERY FAILED for code '${recoveredCleanCode}' ` +
                `(scanEventId=${scanEventIdCaught ?? "unminted"}) - no feed row and/or ledger entry for THIS ` +
                `scan exists after the fallback ran. This scan may not have counted. Do not treat the ` +
                `return value of this call as proof of success.`,
            );
          }
          return ownRecoveredRow ?? recoveredState.scanFeed.find((e) => e.cleanCode === recoveredCleanCode) ?? null;
        }
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
          businessId: state.businessId,
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

      // Explicit user-facing retry: re-arm any items quarantined by a terminal failure (e.g. Firestore
      // permission-denied) so this drain can re-attempt them. Automatic drains (timer/online/enqueue)
      // intentionally keep skipping "quarantined" status - only this explicit action re-attempts a
      // terminal failure, so a fix to the underlying cause (e.g. a rules bug) is not stranded forever.
      // syncError is preserved until a successful apply clears it (see the ok-branch in drainCloudOnce).
      retrySync: () => {
        set((cur) => ({
          pendingSyncQueue: cur.pendingSyncQueue.map((item) =>
            item.status === "quarantined" ? { ...item, status: "error" } : item,
          ),
        }));
        get().syncPending(true);
      },

      setOnline: (online) => {
        set({ online });
        if (online) get().syncPending(true);
      },

      setSimulateSyncFailure: (on) => set({ simulateSyncFailure: on }),

      ...decodeSlice,

      updateSettings: (partial) => set((s) => ({ settings: { ...s.settings, ...partial } })),

      ensureProvisionalCount: (code, reason, opts) => {
        const st0 = get();
        const freshTransferKeys = opts?.freshTransferKeys === true;
        const countIfFeedMissing = opts?.countIfFeedMissing !== false;
        // IDEMPOTENT: if this code is already counted (any path), do nothing - never double count.
        const counted = new Set(st0.finalCounts.map((c) => c.productId));
        const existing = st0.products.find(
          (p) =>
            counted.has(p.id) &&
            p.status !== "archived" &&
            [p.primaryBarcode, p.gtin, p.upc, p.ean, p.primarySku].map((c) => (c ?? "").trim()).includes(code),
        );
        if (existing) {
          if (!opts?.verifyEventId) return existing.id;
          // FINDING 2 FIX (Codex clean-room review, 2026-08-16): do not trust "a count already exists
          // for this code" as proof THIS physical scan's own event was ever applied - the caller (the
          // Layer C recovery fallback) only reaches this opt-in path after an unexpected throw, and the
          // existing ledger row may be exactly the stale/corrupted record that caused it. Verify the
          // event id is actually present before treating this as a genuine idempotent no-op.
          const ledgerRow = st0.finalCounts.find(
            (c) => c.productId === existing.id && c.sessionId === st0.sessionId,
          );
          const alreadyLanded =
            Array.isArray(ledgerRow?.scanEventIds) && ledgerRow.scanEventIds.includes(opts.verifyEventId);
          if (alreadyLanded) return existing.id;
          // Not landed: force-count THIS scan against the SAME existing product now - never mint a
          // duplicate product row for a code that already has one, and never silently drop the scan
          // just because an (unrelated or stale) count for the same code happened to already exist.
          const forceReason = reason || "Recovered count (existing ledger entry for this code did not include this scan).";
          const forcedEvent: ScanEvent = {
            id: opts.verifyEventId,
            businessId: st0.businessId,
            sessionId: st0.sessionId,
            rawCode: code,
            cleanCode: code,
            normalizedCandidates: [],
            matchedProductId: existing.id,
            matchType: "unknown",
            status: "known",
            resolverStatus: "needs_review",
            codeType: detectCodeType(code),
            reason: forceReason,
            quantityDelta: 1,
            quantityAfterScan: 0,
            createdAt: now(),
            source: "scan",
            notes: forceReason,
            syncStatus: "pending",
            syncError: null,
            idempotencyKey: buildIdempotencyKey(st0.businessId, st0.sessionId, opts.verifyEventId, "INCREMENT_COUNT"),
          };
          const forced = incrementInventoryCount(st0.finalCounts, forcedEvent, idFactory);
          forcedEvent.quantityAfterScan = forced.count.quantity;
          set((st) => ({
            finalCounts: forced.counts,
            scanFeed: st.scanFeed.some((e) => e.id === forcedEvent.id)
              ? st.scanFeed.map((e) =>
                  e.id === forcedEvent.id
                    ? { ...e, matchedProductId: existing.id, status: "known" as const, quantityAfterScan: forcedEvent.quantityAfterScan, quantityDelta: 1 }
                    : e,
                )
              : [forcedEvent, ...st.scanFeed],
          }));
          // P6 C2: written AFTER the count above is applied - never before (TOP-LEVEL LAW).
          markFirstScanIfNeeded();
          const forcedIncPayload: IncrementPayload = {
            businessId: st0.businessId,
            sessionId: st0.sessionId,
            productId: existing.id,
            scanEventId: forcedEvent.id,
            quantityDelta: 1,
            idempotencyKey: forcedEvent.idempotencyKey,
          };
          enqueueAndSync([
            makeQueueItem({
              idFactory, now, businessId: st0.businessId, sessionId: st0.sessionId,
              entityType: "ScanEvent", entityId: forcedEvent.id, operation: "SAVE_SCAN_EVENT",
              payload: forcedEvent,
              idempotencyKey: buildIdempotencyKey(st0.businessId, st0.sessionId, forcedEvent.id, "SAVE_SCAN_EVENT"),
              scanEventId: forcedEvent.id,
            }),
            makeQueueItem({
              idFactory, now, businessId: st0.businessId, sessionId: st0.sessionId,
              entityType: "InventoryCount", entityId: forced.count.id, operation: "INCREMENT_COUNT",
              payload: forcedIncPayload,
              idempotencyKey: forcedEvent.idempotencyKey,
              scanEventId: forcedEvent.id,
            }),
          ]);
          return existing.id;
        }
        // Code-type aware label: a SAFE "Unidentified item" + the scanned code. NEVER fabricate manufacturer
        // anatomy here (no decode response). PREFIX FLOOR (Plan C Task 3): unless the GS1 prefix maps to a
        // known brand, in which case the row states the brand with confidence and flags the product
        // unconfirmed - see prefixFloorName. Label text comes from the shared provisionalPlaceholderName
        // helper so resolveUnknown's reload-resilient provOrphanId fallback can reconstruct the identical
        // name purely from the code, even after the customer persist split strips this row's identity fields.
        const ct = detectCodeType(code);
        const floor = prefixFloorName(code, ct);
        const fbName = provisionalPlaceholderName(code);
        const provId = `prod-${idFactory()}`;
        const provProduct: Product = {
          id: provId, businessId: st0.businessId, name: fbName, brand: floor?.brand ?? "", category: "", specsShort: "",
          specsFull: "", primarySku: "", primaryBarcode: code, gtin: "", upc: "", ean: "", vendorCodes: [],
          aliases: [], imageUrl: "", productUrl: "", location: "", notes: "", status: "active", source: "ai_openai",
          confidence: 0, verified: false, provisional: true, provenanceTier: "provisional", createdAt: now(), createdBy: "ai", updatedAt: now(), updatedBy: "ai",
        };
        const ev = st0.scanFeed.find((e) => e.cleanCode === code && e.status !== "known");
        let counts = st0.finalCounts;
        let qty = 0;
        let countId: string | null = null;
        // LAW FIX: no matching scanFeed row exists for this code (e.g. a persist-trimmed feed, or a
        // review whose backing event was otherwise lost) is NOT a reason to silently count nothing -
        // this function still mints the provisional product below, and a scan that already went to
        // Needs Review must still count once it is resolved. Mint a SYNTHETIC BACKING EVENT (same
        // precedent as markWrong's feed-trim safety net, scanStore.ts ~5622) so replayLedgerCounts can
        // reproduce the quantity from feed events alone - never a naked quantity bump.
        const countedEvent = ev
          ? { ...ev, matchedProductId: provId, status: "known" as const, quantityDelta: 1 }
          : countIfFeedMissing
            ? ({
              id: idFactory(),
              businessId: st0.businessId,
              sessionId: st0.sessionId,
              rawCode: code,
              cleanCode: code,
              normalizedCandidates: [],
              matchedProductId: provId,
              matchType: "unknown",
              status: "known" as const,
              resolverStatus: "needs_review",
              codeType: ct,
              reason: reason || "Recovered count (scan record was missing)",
              quantityDelta: 1,
              quantityAfterScan: 0,
              createdAt: now(),
              source: "scan",
              notes: reason || "Recovered count (scan record was missing)",
              syncStatus: "pending",
              syncError: null,
              idempotencyKey: "",
            } as ScanEvent)
            : null;
        if (!ev && countedEvent) {
          countedEvent.idempotencyKey = buildIdempotencyKey(st0.businessId, st0.sessionId, countedEvent.id, "INCREMENT_COUNT");
        } else if (freshTransferKeys && countedEvent && ev) {
          // F-03: markWrong/orphan-transfer callers repoint an EXISTING feed row that may already have
          // been synced under its PREVIOUS (wrong) identity. Reusing its inherited idempotencyKey here
          // would resend the SAME key against a DIFFERENT productId - Firestore's applied-key dedupe
          // stores the ORIGINAL marker (targetId = old productId) and rejects the mismatched replay as
          // idempotency_conflict (retryable:false), so the correction never reaches the backend. Mint a
          // FRESH transfer key (never the original counting key) so this repoint is a genuinely new,
          // never-before-applied write.
          countedEvent.idempotencyKey = buildIdempotencyKey(st0.businessId, ev.sessionId, `${ev.id}:transfer:${provId}`, "INCREMENT_COUNT");
        }
        if (countedEvent) {
          const r = incrementInventoryCount(counts, countedEvent, idFactory);
          counts = r.counts.map((c) =>
            c.productId === countedEvent.matchedProductId && c.sessionId === countedEvent.sessionId
              ? { ...c, location: countedEvent.location }
              : c,
          );
          qty = r.count.quantity;
          countId = r.count.id;
          countedEvent.quantityAfterScan = qty;
        }
        set((st) => ({
          products: [...st.products, provProduct],
          finalCounts: counts,
          needsReviewQueue: st.needsReviewQueue.map((r) =>
            r.cleanCode === code && r.status === "open"
              ? {
                  ...r,
                  decodeStatus: "needs_review",
                  reason: r.reason || reason,
                  suggestedProductName: r.suggestedProductName || fbName,
                  // STABLE-ID FIX: this placeholder (provId, minted just above) belongs to THIS review's
                  // code. Stamp its id so resolveUnknown can re-link by id after a customer reload, instead
                  // of by reconstructed name (see provisionalProductId doc comment in types.ts). Only set
                  // when not already stamped (idempotent; never clobber a value set earlier).
                  provisionalProductId: r.provisionalProductId ?? provId,
                }
              : r,
          ),
          scanFeed: ev
            ? st.scanFeed.map((e) =>
                e.id === ev.id
                  ? {
                      ...e,
                      matchedProductId: provId,
                      status: "known",
                      quantityAfterScan: qty,
                      // Preserve an IN-FLIGHT "Decoding..." badge (a live decode is actually running) so the
                      // documented "Decoding -> Verified / Suggested / Conflict / Needs review" UI stays visible;
                      // only stamp "suggested" when there is no decode in flight.
                      decodeStatus: e.decodeStatus === "decoding" ? "decoding" : "suggested",
                      // D1 FIX: the stored feed event and the counted delta are the SAME FACT - the row a
                      // provisional count was applied from must carry the delta it contributed (North-star #2:
                      // sum(feed deltas) === quantity). And the fake optimistic "synced" stamp is GONE: the
                      // row's syncStatus is derived from pendingSyncQueue membership (see the reconcile at
                      // scanStore.ts:907-922) and only reads "synced" after a real sync ack.
                      quantityDelta: 1,
                      reason: e.reason || reason,
                    }
                  : e,
              )
            // No matching feed row: prepend the synthetic backing event so the feed still carries the
            // exact fact that was counted (North-star #2: sum(feed deltas) === quantity), same
            // precedent as markWrong's residual-repoint synthetic event.
            : countedEvent
              ? [countedEvent, ...st.scanFeed]
              : st.scanFeed,
        }));
        // P6 C2: written AFTER the count above is applied - never before (TOP-LEVEL LAW) - and only
        // when this call actually counted something (countedEvent), never on a no-op/idempotent re-entry.
        if (countedEvent) markFirstScanIfNeeded();
        // D1 FIX: a provisional count is real inventory. Enqueue its ledger writes through the SAME sync
        // queue mechanism every counted scan uses. SAVE_SCAN_EVENT + INCREMENT_COUNT mirror the countable
        // branch's two ops (scanStore.ts:1397-1422); SAVE_PRODUCT for the freshly minted provisional is a
        // NEW op on the scan path (precedent: resolveUnknown's SAVE_PRODUCT enqueue, :3912-3930). The
        // INCREMENT_COUNT key is the event's own key minted in processScan - reused verbatim, never
        // regenerated (Idempotent Sync Rules).
        if (countedEvent && countId) {
          const bId = st0.businessId;
          const sId = countedEvent.sessionId;
          const incPayload: IncrementPayload = {
            businessId: bId, sessionId: sId, productId: provId, scanEventId: countedEvent.id,
            quantityDelta: 1, idempotencyKey: countedEvent.idempotencyKey,
          };
          // F-03: the SAVE_SCAN_EVENT key normally reconstructs deterministically from the event's own id
          // (safe on the FIRST-ever sync of that id). A freshTransferKeys repoint reuses an id that may
          // ALREADY be synced under the previous identity, so it needs the SAME `:transfer:${provId}`
          // suffix as the INCREMENT_COUNT key above (never the bare id) or Firestore's applied-key dedupe
          // rejects the corrected payload as idempotency_conflict.
          const saveScanEventKey = freshTransferKeys
            ? buildIdempotencyKey(bId, sId, `${countedEvent.id}:transfer:${provId}`, "SAVE_SCAN_EVENT")
            : buildIdempotencyKey(bId, sId, countedEvent.id, "SAVE_SCAN_EVENT");
          enqueueAndSync([
            // Task 1b fix (same recipe as correctProduct, commit 024c849): a bare
            // `businessId:sessionId:provId:SAVE_PRODUCT` key collides with resolveUnknown's later
            // orphan-merge SAVE_PRODUCT for this SAME id (it reuses provOrphanId - scanStore.ts ~4791),
            // which would otherwise be swallowed as "alreadyApplied" and the resolved identity would
            // never reach the backend. Suffix `:provisional` so the first (placeholder) write and any
            // later distinct write to this id mint different keys; the key is still minted once here and
            // reused verbatim on every retry of THIS item, so retry dedupe is unaffected.
            makeQueueItem({
              idFactory,
              now,
              businessId: bId,
              sessionId: sId,
              entityType: "Product",
              entityId: provId,
              operation: "SAVE_PRODUCT",
              payload: provProduct,
              idempotencyKey: buildIdempotencyKey(bId, sId, `${provId}:provisional`, "SAVE_PRODUCT"),
              scanEventId: null,
              syncLane: freshTransferKeys ? undefined : "independent_product",
            }),
            makeQueueItem({ idFactory, now, businessId: bId, sessionId: sId, entityType: "ScanEvent", entityId: countedEvent.id, operation: "SAVE_SCAN_EVENT", payload: countedEvent, idempotencyKey: saveScanEventKey, scanEventId: countedEvent.id }),
            makeQueueItem({ idFactory, now, businessId: bId, sessionId: sId, entityType: "InventoryCount", entityId: countId, operation: "INCREMENT_COUNT", payload: incPayload, idempotencyKey: countedEvent.idempotencyKey, scanEventId: countedEvent.id }),
          ]);
        } else if (!countedEvent) {
          const bId = st0.businessId;
          const sId = st0.sessionId;
          enqueueAndSync([
            makeQueueItem({
              idFactory,
              now,
              businessId: bId,
              sessionId: sId,
              entityType: "Product",
              entityId: provId,
              operation: "SAVE_PRODUCT",
              payload: provProduct,
              idempotencyKey: buildIdempotencyKey(bId, sId, `${provId}:provisional`, "SAVE_PRODUCT"),
              scanEventId: null,
            }),
          ]);
        }
        // F5 bundle-surgery: the row already appeared + counted above (TOP-LEVEL LAW unaffected). Only
        // worth an enrichment fetch when the client-safe (SEED/LEARNED) lookup found nothing - a
        // DERIVED-tier hit is still possible server-side.
        if (!floor) get().enrichPrefixFloorLabel(code, provId);
        return provId;
      },

      ...reviewSlice,

      ...catalogSlice,

      pendingCount: () => get().pendingSyncQueue.length,

      clearSession: () => {
        clearTrustedExactProbes();
        set({
          scanFeed: [],
          finalCounts: [],
          needsReviewQueue: [],
          pendingSyncQueue: [],
          syncedScanEventIds: [],
          lastSyncError: null,
        });
      },

      clearLocalCache: () => {
        clearTrustedExactProbes();
        // Clear ONLY browser-local data. In CLOUD mode we must NEVER call db.reset() (FirebaseSyncTarget
        // guards against a destructive cloud wipe and throws) and must NEVER reseed mock data over the
        // real cloud catalog - the cloud data re-loads on the next page load. In MOCK mode, reset the
        // local MockDb and reload clean seed (the original behavior).
        if (!cloudBackend) db.reset();
        if (typeof window !== "undefined" && window.localStorage) {
          try {
            // F-4 fix (resurrection leak, 2026-08-09): cancel any coalesced write still pending for
            // these keys FIRST via the wrapper's own removeItem, before the direct dual-store delete -
            // otherwise a write already queued for "sis-scan-v1" (or the per-uid key) can land AFTER
            // this clears it, resurrecting the just-wiped blob for the next user on a shared device.
            if (deps.persistName) scanPersistBackingStorage.removeItem("sis-scan-v1");
            removePersistedKeyEverywhere("sis-scan-v1");
            const currentUid = get().userId;
            if (currentUid) {
              if (deps.persistName) scanPersistBackingStorage.removeItem(persistKeyForUid(currentUid));
              removePersistedKeyEverywhere(persistKeyForUid(currentUid));
            }
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

    };
  };
}

// --- App store (persisted) ---------------------------------------------------------------------

// Backend selection: Firebase (cloud/emulator) when NEXT_PUBLIC_FIREBASE_BACKEND=1, else the local mock
// (default + legacy E2E -> existing behavior unchanged). The Firebase target is constructed ONLY in that
// branch, so the mock/test path never initializes Firebase.
const useFirebaseBackend = isCloudBackendEnabled();
const appDeps: ScanStoreDeps = {
  db: useFirebaseBackend
    ? new FirebaseSyncTarget(getDb(), { emulator: process.env.NEXT_PUBLIC_FIREBASE_USE_EMULATOR === "1" })
    : getMockDb(),
  cloudBackend: useFirebaseBackend,
  trustedExactProbeEnabled: useFirebaseBackend,
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
  // READ-ONLY cloud "brain": the global catalog lookup is enabled by full Firebase backend OR by the
  // dedicated NEXT_PUBLIC_CLOUD_CATALOG flag. The latter lets the LOCAL (mock) backend read the cloud
  // 52k catalog for resolution WITHOUT writing any scans to the cloud (scans stay in the local store).
  lookupGlobalCatalog: (useFirebaseBackend || process.env.NEXT_PUBLIC_CLOUD_CATALOG === "1")
    ? async (codes: string[]): Promise<CatalogEntry | null> => {
        const repo = catalogRepository(getDb());
        const retailRepo = catalogRepository(getDb(), "retailCatalogEntries"); // SEPARATE retail catalog (Open Food Facts)
        const nowIso = new Date().toISOString();
        // toStoreEntry: map the minimal db/types.ts CatalogEntry shape -> the full catalogTypes CatalogEntry
        // shape that the store/resolver expects (toMasterAwareStoreEntry, services/catalog/sanitizeCatalog.ts).
        // Phase 5b Task 4 (GC4 boundary): the tire-master hit ALSO passes raw.id / raw.provenanceTier
        // through onto the store entry's optional masterId/masterProvenanceTier fields, so
        // cloudCatalogResolve can build master candidates for the cross-tier conflict check below.
        // Fix (review HIGH, retail provenance): masterId/masterProvenanceTier are tagged ONLY for hits
        // from the TIRE master catalog (the default `repo`, collection catalogEntries) - see
        // toMasterAwareStoreEntry's isMaster param. The retail catalog (`retailRepo`, Open Food Facts)
        // is a SEPARATE, non-master collection; tagging its hits would run them through the tire-master
        // conflict machinery with a defaulted "corpus_verified" tier they never earned.
        const toStoreEntry = (raw: { id: string; normalizedBarcode: string; name?: string; brand?: string; category?: string; verificationStatus?: string; provenanceTier?: ProvenanceTier }, isMaster = false) =>
          toMasterAwareStoreEntry(raw, isMaster, nowIso);
        let firstAny: CatalogEntry | null = null;
        for (const code of codes) {
          try {
            const raw = await repo.getByBarcode(code);
            if (raw) {
              const entry = toStoreEntry(raw, true);
              if (entry.verificationStatus === "verified") return entry;
              if (!firstAny) firstAny = entry;
            }
          } catch {
            // swallow per-code errors; try the next candidate
          }
          try {
            // RETAIL catalog (Open Food Facts) - a hit IS the product identity, so resolve it as Known
            // (mirrors the tire catalog behavior). Separate collection; never mixed with tires. NOT the
            // master catalog - never tagged with masterId/masterProvenanceTier (see toStoreEntry above).
            const rraw = await retailRepo.getByBarcode(code);
            if (rraw) return toStoreEntry({ ...rraw, verificationStatus: "verified" }, false);
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

// F-4 fix (resurrection leak, 2026-08-09): named module-level instance (was an inline IIFE passed
// straight to `storage:` below, unreachable from anywhere else) so the direct legacy/per-uid key
// deleters in resetForSignOut and clearLocalCache can route through THIS wrapper's own removeItem -
// the only thing that cancels a pending coalesced write for that key (see scanPersistStorage.ts
// removeItem: it clears pendingName/pendingValue AND cancels any in-flight IDB migration copy before
// deleting from backing). Deleting the legacy/localStorage key directly (removePersistedKeyEverywhere
// alone) does not touch this wrapper's pending-write queue, so a write already coalesced for that key
// before the deletion could still land AFTER it, resurrecting a supposedly-deleted blob - on a shared
// device that resurrected sis-scan-v1 is the PREVIOUS user's inventory, offered to the NEXT user via
// the adopt banner (cross-account disclosure).
const scanPersistBackingStorage = (() => {
  const idb = typeof indexedDB !== "undefined" ? createIdbBacking() : null;
  return idb
    ? createAsyncCoalescedFailSoftPersistStorage(() => idb, {
        migrateFrom: typeof localStorage !== "undefined" ? localStorage : undefined,
        // Task 2 (persist-failure surface, 2026-08-09): this hook previously had no listener anywhere
        // (a fail-soft write/migrate/demotion failure was logged via console.warn inside
        // scanPersistStorage.ts and otherwise invisible). `useScanStore` is referenced here inside a
        // closure, not at module-eval time - by the time IndexedDB can actually fail and call this back,
        // module evaluation has long finished and `useScanStore` below is defined, so this is safe.
        // Guarded because a persist failure must never itself throw (it already fails soft upstream).
        onPersistFailure: (kind) => {
          try {
            useScanStore.getState().setPersistDegraded(kind);
          } catch {
            // never let a persist-failure listener throw
          }
        },
      })
    : createCoalescedFailSoftPersistStorage(() => localStorage);
})();

/**
 * Sweep the EMPTY legacy-key residue a per-uid session leaves behind (root-caused 2026-08-09 from the
 * adopt emulator spot-check: after adoption + reload an empty "sis-scan-v1" (+ its "::stamp" sibling)
 * reappeared in IndexedDB).
 *
 * WHY IT APPEARS - entirely product code, no test artifact: `StoreHydrator` calls
 * `useScanStore.persist.rehydrate()` on every page load, while the persist name is still the DEFAULT
 * legacy key (the uid is only known after the async auth bootstrap in BusinessContextGate). Zustand's
 * hydrate ends by invoking `onRehydrateStorage`'s callback -> `setHasHydrated(true)` -> a store `set()`
 * -> the persist middleware's `setItem()` on the CURRENT name. So the initial (empty) state is written
 * straight back to "sis-scan-v1", into whichever backing is primary (IndexedDB since #27, which is why
 * localStorage stayed clean in the proof). Harmless on its own - `legacyBlobIsMeaningful` correctly
 * ignores it, so no adopt banner - but it is a stray per-device trace of a signed-in session sitting in
 * the SHARED (non-namespaced) key, and it makes "is the legacy key gone?" un-assertable after adoption.
 *
 * The fix is a sweep, not a delete-on-sight: only a blob with NO scans, counts, or reviews is removed -
 * exactly the `hasMeaningfulLegacyBlobAsync` predicate the adopt banner itself uses. A real pre-account
 * blob (adoptable, or deliberately kept by "Start fresh (leave it)") is never touched. Routed through
 * the wrapper's own removeItem FIRST so a coalesced write still pending for that key is cancelled
 * rather than left to land afterwards (the F-4 resurrection rule). Never throws.
 */
async function sweepEmptyLegacyResidue(): Promise<void> {
  try {
    if (await hasMeaningfulLegacyBlobAsync()) return; // real adoptable data: leave it exactly as-is
    scanPersistBackingStorage.removeItem(LEGACY_PERSIST_KEY);
    removePersistedKeyEverywhere(LEGACY_PERSIST_KEY); // blob + its "::stamp" sibling, both backings
  } catch {
    // Storage cleanup is best-effort: it must never break sign-in hydration.
  }
}

export const useScanStore = create<ScanState>()(
  persist(buildScanInitializer(appDeps), {
    name: "sis-scan-v1",
    // Task 2 (owner-reported live bug, 2026-07-20): v9 -> v10 bump so every existing install runs
    // the identity-field backfill (enrichProductIdentity fill-if-empty, see backfillProducts.ts)
    // exactly once on next load - a legacy row's blank brand/category/specsShort/specsFull gets
    // filled from its parseable name via the same non-destructive >= 5 migrate branch below.
    // Group C item 11 (owner mandate 2026-07-21): v10 -> v11 bump so every existing install also
    // re-cleans a legacy JUNKY product name into the app's own canonical display form exactly once
    // (see scanStoreMigrate's v11 name re-clean step below).
    // Bug 4 fix (owner mandate 2026-07-21, 310-row review): v11 -> v12 bump so every existing install
    // ALSO re-runs backfillProducts once more to dedupe a brand-duplicated name that an earlier
    // enrichment/backfill pass baked in before canonicalTireDisplayName/enrichProductIdentity learned
    // to collapse duplicate brand-token runs (e.g. "Greenball Greenball Greenball Tow-Master"). The
    // >= 5 migrate branch below already calls backfillProducts unconditionally on every hydrate whose
    // persisted version is below `version`, so this bump alone is sufficient - no separate v12 step
    // needed (backfillProducts itself now dedupes via the fixed canonicalTireDisplayName).
    // "Resolved never lingers in review" fix: v12 -> v13 bump so an install stuck with the old bug
    // (resolveUnknown silently no-op'd on a genuinely settled decode, leaving the review "open"/
    // "suggested" forever) gets a one-time self-heal on next load - see scanStoreMigrate's v13 step.
    // Owner feature (2026-07-22): v13 -> v14 bump so every existing install gains `sessionHistory`
    // defaulted to [] (see scanStoreMigrate's v14 note above).
    version: 14,
    // Finding #16 (critical) CONTAINED MITIGATION: the persist store previously used a plain
    // createJSONStorage(() => localStorage) with NO quota guard, so near the ~5MB quota setItem threw
    // synchronously out of set() inside processScan and bricked the /scan page (fresh tab still broken
    // until localStorage was cleared). This wrapper fails SOFT (never throws out of a scan) and COALESCES
    // the ~6 writes/scan into one per tick (flushed on pagehide/visibilitychange so nothing is lost).
    // Defect #37 layer 3 (fresh-device restore freeze, 2026-08-06): a plain `createJSONStorage(...)`
    // wrapper still runs JSON.stringify of the FULL state synchronously on every single set() call,
    // before this coalescing even sees it (zustand's persist middleware calls storage.setItem from every
    // state change - see scanPersistStorage.ts header). createCoalescedFailSoftPersistStorage implements
    // PersistStorage<S> directly so the stringify itself, not just the disk write, is coalesced to at
    // most one per tick. See scanPersistStorage.ts. IndexedDB migration remains the recommended
    // architectural follow-up.
    // #27: IndexedDB is the primary persist backing (localStorage's ~5MB quota bricked large real-
    // backend sessions ~500 scans in). Feature-detected once at store creation: no indexedDB (SSR,
    // jsdom, lockdown) -> the previous localStorage path, byte-for-byte identical behavior. When IDB
    // is active, migrateFrom copies a legacy localStorage blob forward on first read (copy-then-clear).
    storage: scanPersistBackingStorage,
    skipHydration: true,
    migrate: scanStoreMigrate,
    // LAYER A (persist-corruption defect, 2026-08-13): zustand's `merge` runs on EVERY hydrate,
    // whether or not `migrate` ran (migrate is skipped entirely when the stored version already
    // equals `version` above - exactly the case a wrong-SHAPE-but-current-version blob hits). Route
    // the migrated/raw persisted state through sanitizePersistedScanShape here so a non-array
    // collection field can never reach the live store, regardless of which hydrate path it took.
    merge: (persistedState, currentState) => ({
      ...currentState,
      ...sanitizePersistedScanShape(persistedState),
    }),
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

// TEST/DEV ONLY (never production): expose the in-memory store so the local Playwright scan-matrix proof
// harness can read the FULL unsanitized state (products with verified/provisional, aliases, catalog) that
// the role-aware localStorage persist deliberately strips for customer browsers. Inert in prod builds.
if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
  (window as unknown as { __scanStore?: typeof useScanStore }).__scanStore = useScanStore;
}

/** Factory for tests: a fresh, non-persisted store with injectable deps. */
export function createTestScanStore(overrides?: Partial<ScanStoreDeps>) {
  let n = 0;
  const deps: ScanStoreDeps = {
    db: overrides?.db ?? new MockDb(),
    idFactory: overrides?.idFactory ?? (() => `id-${++n}`),
    now: overrides?.now ?? (() => "2026-06-12T10:00:00.000Z"),
    persistName: null,
    cloudBackend: overrides?.cloudBackend ?? false,
    trustedExactProbeEnabled: overrides?.trustedExactProbeEnabled,
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

/** TEST ONLY: the general decode queue's bulk pacer (`GENERAL_DECODE_RATE_PER_SEC` token bucket) is a
 *  module-level singleton shared by every store instance (mirrors `decodeTaskPromises`/the queues
 *  themselves), so a fake-timer pacing test needs a deterministic starting point instead of inheriting
 *  leftover tokens/timers from whatever ran earlier in the same test file. Never used outside tests. */
export function __resetGeneralDecodePacerForTest(nowMs: number = Date.now()): void {
  if (generalDecodeQueue.pacer) resetTokenBucket(generalDecodeQueue.pacer, nowMs);
}

/** TEST ONLY: the mirror of `__resetGeneralDecodePacerForTest` - empties the bulk pacer's token bucket
 *  so the very next `liveDecode` is genuinely QUEUED (waiting on refill) instead of dispatching
 *  synchronously out of the burst allowance. Lets a test exercise the bulk-session path (in-flight
 *  dedupe of two calls for the same review while the first is still queued) without pasting 1000 codes
 *  first. Never used outside tests. */
export function __drainGeneralDecodePacerForTest(nowMs: number = Date.now()): void {
  const pacer = generalDecodeQueue.pacer;
  if (!pacer) return;
  pacer.tokens = 0;
  pacer.lastRefillAt = nowMs;
}
