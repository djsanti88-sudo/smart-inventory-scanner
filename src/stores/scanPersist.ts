// Sec-4: role-aware localStorage persistence for the scan store. The customer browser must NEVER persist
// the reusable code database (aliases / global catalog / shop overrides / barcodes / raw+clean+normalized
// codes / decode traces). This module is the SINGLE place that decides what reaches disk, so it is pure and
// unit-testable in isolation (no store, no Firebase). The store's `partialize` delegates here.

import { sanitizeProduct, sanitizeReview, sanitizeScanEvent } from "@/services/security/serializers";
import { effectiveClientAccessLevel, type AccessLevel } from "@/services/security/roleAccess";

// Minimal shape of the persistable fields we read off the store state. Typed loosely on purpose so this
// stays decoupled from the (large) ScanState type and free of import cycles.
export interface PersistableScanState {
  userId: string | null;
  businessId: string;
  sessionId: string;
  currentSession: unknown;
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
}

/** Resolve the persistence access level from the signed-in uid (defaults to customer when unknown). */
export function persistAccessLevel(userId: string | null): AccessLevel {
  return effectiveClientAccessLevel({ uid: userId });
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
    sessionId: s.sessionId,
    currentSession: s.currentSession,
    settings: s.settings,
    pendingSyncQueue: s.pendingSyncQueue,
    syncedScanEventIds: s.syncedScanEventIds,
    simulateSyncFailure: s.simulateSyncFailure,
    // Task 3.5: snapshot lines are already the product-facing shape (productId, name, qty - no raw
    // codes), the same fields a customer already sees in finalCounts, so this is safe for every role.
    countSnapshots: s.countSnapshots,
  };
  if (level === "platform") {
    return {
      ...base,
      products: s.products,
      aliases: s.aliases,
      scanFeed: s.scanFeed,
      finalCounts: s.finalCounts,
      needsReviewQueue: s.needsReviewQueue,
      lastCleanupBackup: s.lastCleanupBackup,
      catalog: s.catalog,
      shopOverrides: s.shopOverrides,
      feedbackEvents: s.feedbackEvents,
    };
  }
  return {
    ...base,
    products: s.products.map((p) => sanitizeProduct(p, "business")),
    finalCounts: s.finalCounts.map((c) => ({ ...c, aliasesSeen: [] })),
    // P1 (2026-06-22): a customer MUST keep their own pending Needs-Review items + scan feed across a
    // reload (otherwise their unfinished work is lost and can never be approved/counted). Persist a
    // SANITIZED copy: only act-on-it fields + the user's own cleanCode; every provider/decode internal and
    // every OTHER reusable code is stripped (sanitizeReview/sanitizeScanEvent), so no reusable alias/catalog
    // data reaches disk.
    needsReviewQueue: (s.needsReviewQueue as Array<Record<string, unknown>>).map((r) => sanitizeReview(r, "business")),
    scanFeed: (s.scanFeed as Array<Record<string, unknown>>).map((e) => sanitizeScanEvent(e, "business")),
  };
}
