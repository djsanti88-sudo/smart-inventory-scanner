// Per-uid persist namespacing for the scan store. The anon/mock path keeps the legacy global key
// "sis-scan-v1" byte-for-byte so demos and every existing test are unaffected; a signed-in user gets
// their own "sis-scan-<uid>" key so two users on one browser never share persisted state.

import { createIdbBacking, type AsyncBacking } from "@/stores/idbBacking";

const LEGACY_KEY = "sis-scan-v1";

/** Exported alias so async consumers can import the literal key by name. */
export const LEGACY_PERSIST_KEY = LEGACY_KEY;

export function persistKeyForUid(uid: string | null): string {
  return uid ? `sis-scan-${uid}` : LEGACY_KEY;
}

function idb(): AsyncBacking | null {
  try {
    return createIdbBacking();
  } catch {
    return null;
  }
}

function ls(): Pick<Storage, "getItem" | "setItem" | "removeItem"> | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Whether the legacy pre-account global blob holds MEANINGFUL tenant data worth adopting (drives the
 * adopt banner). N2: sign-out's wipe write deposits an effectively-empty blob (session/snapshot residue
 * only, no scans/counts/reviews) into sis-scan-v1, which used to make the banner appear on a browser with
 * nothing to adopt. So a blob that parses cleanly but has empty-or-absent scanFeed AND finalCounts AND
 * needsReviewQueue is treated as ABSENT. Conservative on failure: a missing key, or a blob that cannot be
 * parsed, still counts as present (we never suppress the banner for something we could not inspect).
 */
// Shared predicate so the sync (localStorage-only) and async (IDB-aware) meaningful-blob checks
// can never drift from each other. null -> false (nothing present); unparseable-but-present ->
// true (conservative: never suppress the banner for something we could not inspect); else true
// iff scanFeed OR finalCounts OR needsReviewQueue is non-empty.
function legacyBlobIsMeaningful(raw: string | null): boolean {
  if (raw === null) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return true; // unreadable but present: conservatively surface it rather than silently hide it
  }
  const state = (parsed as { state?: { scanFeed?: unknown[]; finalCounts?: unknown[]; needsReviewQueue?: unknown[] } })?.state;
  const hasScans = Array.isArray(state?.scanFeed) && state.scanFeed.length > 0;
  const hasCounts = Array.isArray(state?.finalCounts) && state.finalCounts.length > 0;
  const hasReviews = Array.isArray(state?.needsReviewQueue) && state.needsReviewQueue.length > 0;
  return hasScans || hasCounts || hasReviews;
}

export function hasLegacyBlob(storage: Storage): boolean {
  return legacyBlobIsMeaningful(storage.getItem(LEGACY_KEY));
}

/**
 * OWNER-INITIATED adopt of the legacy global blob into the signed-in owner's per-uid key. Must only be
 * called from an explicit adopt action (BusinessContextGate's adopt banner), NEVER automatically on
 * sign-in: an automatic copy would hand the previous local inventory to whichever account signs in
 * first on a shared browser. Idempotent: never overwrites an existing per-uid key. On a successful
 * copy the legacy blob is DELETED so it cannot be inherited twice or leak to a later sign-in.
 * Folds in the P1-handoff fix: legacy v7 feed rows may carry a literal quantityDelta:0 (pre-D1) that
 * applyScanEventOnce's `?? 1` does not correct, so any 0 is normalized to 1 during the copy. The
 * copied blob keeps the legacy version (>= 5, above the destructive reset boundary), so
 * scanStoreMigrate runs normally on the copied key at next hydration.
 */
export function migrateLegacyBlobOnce(uid: string, storage: Storage): void {
  const targetKey = persistKeyForUid(uid);
  if (targetKey === LEGACY_KEY) return;
  if (storage.getItem(targetKey)) return; // already adopted: leave everything as-is
  const raw = storage.getItem(LEGACY_KEY);
  if (!raw) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return; // unreadable legacy blob: nothing safe to adopt
  }
  const docState = parsed as { state?: { scanFeed?: Array<{ quantityDelta?: number }> } };
  const feed = docState?.state?.scanFeed;
  if (Array.isArray(feed)) {
    for (const row of feed) {
      if (row && row.quantityDelta === 0) row.quantityDelta = 1;
    }
  }
  storage.setItem(targetKey, JSON.stringify(parsed));
  storage.removeItem(LEGACY_KEY); // consumed: a second sign-in can never inherit it
}

// ---------------------------------------------------------------------------------------------
// IDB-aware async variants (#27 IndexedDB migration). IDB is the primary backing when available;
// localStorage is the fallback (SSR/jsdom/lockdown browsers with no indexedDB). These are used by
// BusinessContextGate and scanStore once the persist backing has moved off localStorage.
// ---------------------------------------------------------------------------------------------

/** Reads `key` from IDB first (when available), falling back to localStorage. Fail-soft: null on any error. */
export async function getPersistedBlob(key: string): Promise<string | null> {
  const backing = idb();
  if (backing) {
    try {
      const value = await backing.getItem(key);
      if (value !== null) return value;
    } catch {
      // fall through to localStorage
    }
  }
  const storage = ls();
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

/** Plain existence check (IDB or localStorage). Use ONLY for a plain "does this key exist" check
 * (e.g. the adopt banner's alreadyOwn check) - never for the legacy-blob adopt-banner decision,
 * which needs the meaningful-data check below (N2). */
export async function hasPersistedBlobAsync(key: string): Promise<boolean> {
  return (await getPersistedBlob(key)) !== null;
}

/**
 * Async counterpart to `hasLegacyBlob`, IDB-aware. Uses the SAME `legacyBlobIsMeaningful`
 * predicate so the two can never drift (N2: sign-out's wipe write deposits an effectively-empty
 * blob into the legacy key, and the adopt banner must NOT appear for it).
 */
export async function hasMeaningfulLegacyBlobAsync(): Promise<boolean> {
  return legacyBlobIsMeaningful(await getPersistedBlob(LEGACY_KEY));
}

/**
 * Async counterpart to `migrateLegacyBlobOnce`, IDB-aware. Same contract: idempotent (no-op if the
 * per-uid slot already holds data), copies + normalizes quantityDelta:0 -> 1, then deletes the
 * legacy blob from BOTH stores only after the copy has landed successfully.
 */
export async function migrateLegacyBlobOnceAsync(uid: string): Promise<void> {
  const targetKey = persistKeyForUid(uid);
  if (targetKey === LEGACY_KEY) return;
  if (await hasPersistedBlobAsync(targetKey)) return; // already adopted: leave everything as-is
  const raw = await getPersistedBlob(LEGACY_PERSIST_KEY);
  if (raw === null) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return; // unreadable legacy blob: nothing safe to adopt
  }
  const docState = parsed as { state?: { scanFeed?: Array<{ quantityDelta?: number }> } };
  const feed = docState?.state?.scanFeed;
  if (Array.isArray(feed)) {
    for (const row of feed) {
      if (row && row.quantityDelta === 0) row.quantityDelta = 1;
    }
  }
  const normalized = JSON.stringify(parsed);
  const backing = idb();
  if (backing) {
    await backing.setItem(targetKey, normalized); // throws propagate: never remove the anon blob on a failed copy
  } else {
    ls()?.setItem(targetKey, normalized);
  }
  removePersistedKeyEverywhere(LEGACY_PERSIST_KEY); // consumed only after the copy landed
}

/** Fail-soft removal of `key` from both stores. Never throws. */
export function removePersistedKeyEverywhere(key: string): void {
  try {
    ls()?.removeItem(key);
  } catch {
    // ignore
  }
  try {
    void idb()
      ?.removeItem(key)
      .catch(() => undefined);
  } catch {
    // ignore
  }
}
