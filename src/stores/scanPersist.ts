// Sec-4: role-aware localStorage persistence for the scan store. The customer browser must NEVER persist
// the reusable code database (aliases / global catalog / shop overrides / barcodes / raw+clean+normalized
// codes / decode traces). This module is the SINGLE place that decides what reaches disk, so it is pure and
// unit-testable in isolation (no store, no Firebase). The store's `partialize` delegates here.

import { sanitizeProduct, sanitizeReview, sanitizeScanEvent } from "@/services/security/serializers";
import { effectiveClientAccessLevel, isLocalRuntime, type AccessLevel } from "@/users-businesses/roles/roleAccess";

// Minimal shape of the persistable fields we read off the store state. Typed loosely on purpose so this
// stays decoupled from the (large) ScanState type and free of import cycles.
export interface PersistableScanState {
  userId: string | null;
  businessId: string;
  sessionId: string;
  currentSession: unknown;
  location: string;
  recentLocations: string[];
  settings: unknown;
  pendingSyncQueue: unknown[];
  syncedScanEventIds: unknown[];
  simulateSyncFailure: boolean;
  products: Array<Record<string, unknown>>;
  aliases: unknown[];
  scanFeed: unknown[];
  finalCounts: Array<Record<string, unknown>>;
  needsReviewQueue: unknown[];
  lastCleanupBackup: unknown;
  catalog: unknown[];
  shopOverrides: unknown[];
  feedbackEvents: unknown[];
  countSnapshots: unknown[];
  firstScanAt: string | null;
  sessionHistory: unknown[];
}

/**
 * Resolve the PERSISTENCE access level from the signed-in uid (defaults to customer when unknown).
 *
 * QA Task 6 (data survival): the no-login / open-access LOCAL runtime is the owner's OWN device (no cloud
 * backend, userId always null). Persist stripping must NOT run there or the owner's own data - aliases +
 * product barcodes - is silently destroyed on every reload, turning a KNOWN scan into an unknown. So local
 * runtime persists at the full "platform" shape. This override lives HERE, on the persist seam only, and
 * is deliberately NOT in effectiveClientAccessLevel (the UI role hint) - decoupling data survival from UI
 * customer gating so the customer role-gating + Model/name sanitization guarantee stays intact & provable.
 * A genuine signed-in customer on a REAL cloud backend still resolves to "business" and stays stripped.
 */
export function persistAccessLevel(userId: string | null): AccessLevel {
  if (isLocalRuntime()) return "platform";
  return effectiveClientAccessLevel({ uid: userId });
}

// Finding #16 mitigation (c): cap the APPEND-ONLY DIAGNOSTIC ledgers that grow one entry per scan so the
// persisted blob stops scaling linearly with session length. Only the newest entries are kept (ring
// buffer), the same convention countSnapshots/feedbackEvents already use in-memory. These ledgers are
// safe to bound: syncedScanEventIds is a dedup ledger whose only job is to stop re-applying items STILL
// in pendingSyncQueue (applied items leave the queue, so old ids are dead weight); feedbackEvents is a
// private local event log. CUSTOMER DATA (scanFeed / finalCounts / needsReviewQueue / pendingSyncQueue)
// is NEVER capped here - dropping any of it would lose counts, unfinished review work, or unsynced
// writes, which the TOP-LEVEL LAW forbids.
const SYNCED_SCAN_ID_CAP = 1000;
const FEEDBACK_EVENT_PERSIST_CAP = 500;

/** Keep only the last `cap` entries of an append-only array (newest retained). Pure.
 *  Defensive (2026-08-16, TOP-LEVEL LAW class fix): `partialize` runs on EVERY set(), including one
 *  that happens to run before scanStore's own shape sanitizer has had a chance to repair a corrupted
 *  live field (e.g. a raw test/defect path that force-writes a wrong-shape value directly into the
 *  store). A non-array input must never throw out of persistence - it degrades to [] instead. */
function capTail<T>(arr: T[], cap: number): T[] {
  if (!Array.isArray(arr)) return [];
  return arr.length > cap ? arr.slice(arr.length - cap) : arr;
}

/** Same defensive contract as capTail, for array fields that are not capped. A non-array input
 *  degrades to [] instead of throwing out of `.map()`/`.filter()` below. */
function safeArray<T>(arr: T[]): T[] {
  return Array.isArray(arr) ? arr : [];
}

/**
 * Build the object that will be written to localStorage for the given state + access level.
 * platform: the full local view (unchanged legacy behavior). business (customer): product-facing data
 * only - no aliases/catalog/shopOverrides/scanFeed/needsReview/cleanup-backup/feedback, products reduced
 * to the customer-safe shape, and finalCounts stripped of `aliasesSeen` (codes).
 */
export function buildPersistedScanState(
  s: PersistableScanState,
  level: AccessLevel = persistAccessLevel(s.userId),
): Record<string, unknown> {
  const base = {
    businessId: s.businessId,
    // REFRESH GUARD (2026-07-22): setBusinessContext's same-tenant check compares BOTH businessId and
    // userId against the rehydrated store. The persist key is already per-uid (scanPersistNamespace),
    // so storing the uid leaks nothing new - but without it a fresh page load rehydrates userId as
    // null, the guard misses, and every refresh wipes scanFeed/finalCounts/needsReviewQueue.
    userId: s.userId,
    sessionId: s.sessionId,
    currentSession: s.currentSession,
    location: s.location,
    recentLocations: safeArray(s.recentLocations),
    settings: s.settings,
    pendingSyncQueue: safeArray(s.pendingSyncQueue),
    // #16: bounded diagnostic dedup ledger (not customer data - see cap note above).
    syncedScanEventIds: capTail(s.syncedScanEventIds, SYNCED_SCAN_ID_CAP),
    simulateSyncFailure: s.simulateSyncFailure,
    // Task 3.5: snapshot lines are already the product-facing shape (productId, name, qty - no raw
    // codes), the same fields a customer already sees in finalCounts, so this is safe for every role.
    countSnapshots: safeArray(s.countSnapshots),
    // P6 C2: a single ISO timestamp, no codes/identities - safe for every role (drives the /scan
    // first-run banner across reloads).
    firstScanAt: s.firstScanAt,
    // Owner feature (2026-07-22): session history is the shop's own scan history (a shop's scans are
    // their data, so it persists at BOTH access levels). Rows carry only { time, code, productName,
    // quantityDelta } - no cost/price/margin fields exist on this shape, so it is safe at every level.
    sessionHistory: safeArray(s.sessionHistory),
  };
  if (level === "platform") {
    return {
      ...base,
      products: safeArray(s.products),
      aliases: safeArray(s.aliases),
      scanFeed: safeArray(s.scanFeed),
      finalCounts: safeArray(s.finalCounts),
      needsReviewQueue: safeArray(s.needsReviewQueue),
      lastCleanupBackup: s.lastCleanupBackup,
      catalog: safeArray(s.catalog),
      shopOverrides: safeArray(s.shopOverrides),
      // #16: bounded diagnostic event log (private, local; not customer inventory data).
      feedbackEvents: capTail(s.feedbackEvents as unknown[], FEEDBACK_EVENT_PERSIST_CAP),
    };
  }
  return {
    ...base,
    products: safeArray(s.products).map((p) => sanitizeProduct(p, "business")),
    finalCounts: safeArray(s.finalCounts).map((c) => ({ ...c, aliasesSeen: [] })),
    // P1 (2026-06-22): a customer MUST keep their own pending Needs-Review items + scan feed across a
    // reload (otherwise their unfinished work is lost and can never be approved/counted). Persist a
    // SANITIZED copy: only act-on-it fields + the user's own cleanCode; every provider/decode internal and
    // every OTHER reusable code is stripped (sanitizeReview/sanitizeScanEvent), so no reusable alias/catalog
    // data reaches disk.
    needsReviewQueue: safeArray(s.needsReviewQueue as Array<Record<string, unknown>>).map((r) => sanitizeReview(r, "business")),
    scanFeed: safeArray(s.scanFeed as Array<Record<string, unknown>>).map((e) => sanitizeScanEvent(e, "business")),
  };
}
