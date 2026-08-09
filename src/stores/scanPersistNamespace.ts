// Per-uid persist namespacing for the scan store. The anon/mock path keeps the legacy global key
// "sis-scan-v1" byte-for-byte so demos and every existing test are unaffected; a signed-in user gets
// their own "sis-scan-<uid>" key so two users on one browser never share persisted state.

import { createIdbBacking, type AsyncBacking } from "@/stores/idbBacking";
import { decodeLegacyStamped, persistStampKey, readNewestPersistedRaw } from "@/stores/scanPersistStorage";

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
  // P7: a localStorage value may be an atomic `sisv1:<stamp>:<raw>` envelope written by the async
  // wrapper's write-through (which runs whenever IndexedDB is present but failing - exactly the
  // environment P8's fallback routes back here). Decode before parsing; a plain blob decodes to
  // itself, so every pre-existing install is unaffected.
  const raw = decodeLegacyStamped(storage.getItem(LEGACY_KEY)).raw;
  if (!raw) return;
  const normalized = normalizeAdoptedBlob(raw);
  if (normalized === null) return; // unreadable legacy blob: nothing safe to adopt
  storage.setItem(targetKey, normalized);
  storage.removeItem(LEGACY_KEY); // consumed: a second sign-in can never inherit it
  storage.removeItem(persistStampKey(LEGACY_KEY)); // and its sibling stamp (F6)
}

/**
 * Parse the legacy blob and apply the P1-handoff normalization (a literal `quantityDelta: 0` on a
 * legacy v7 feed row, which `applyScanEventOnce`'s `?? 1` does not correct). Returns the re-
 * serialized blob, or null when the blob cannot be parsed. Shared by the sync and async adopt paths
 * so the two can never normalize differently.
 */
function normalizeAdoptedBlob(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const docState = parsed as { state?: { scanFeed?: Array<{ quantityDelta?: number }> } };
  const feed = docState?.state?.scanFeed;
  if (Array.isArray(feed)) {
    for (const row of feed) {
      if (row && row.quantityDelta === 0) row.quantityDelta = 1;
    }
  }
  return JSON.stringify(parsed);
}

// ---------------------------------------------------------------------------------------------
// IDB-aware async variants (#27 IndexedDB migration). IDB is the primary backing when available;
// localStorage is the fallback (SSR/jsdom/lockdown browsers with no indexedDB). These are used by
// BusinessContextGate and scanStore once the persist backing has moved off localStorage.
// ---------------------------------------------------------------------------------------------

/**
 * Reads `key` from BOTH stores and returns the NEWER copy, using the same stamp comparison the persist
 * wrapper hydrates with (readNewestPersistedRaw in scanPersistStorage.ts). Fail-soft: null on any error.
 *
 * F1 (2026-08-09): this used to be IDB-first-then-localStorage, which is not the same rule. Because a
 * failed IndexedDB write is written through to localStorage, the same key can legitimately hold a
 * NEWER blob in localStorage and an OLDER one in IndexedDB - and the two consumers below are the adopt
 * banner's decision and the adopt COPY. Reading IDB-first there meant copying the stale blob onto the
 * per-uid key and then deleting the newer one (silent loss of the newest pre-account scans), and in the
 * inverse direction (a stale empty sign-out wipe blob in IndexedDB) it suppressed the banner entirely.
 * Read-only: unlike the wrapper's getItem this does NOT heal the divergence (no copy-forward, no
 * loser cleanup) - that stays the wrapper's job, on the key it actually owns.
 */
export async function getPersistedBlob(key: string): Promise<string | null> {
  return (await readNewestPersistedRaw(key, idb(), ls())).raw;
}

/** Plain existence check (IDB or localStorage). Use ONLY for a plain "does this key exist" check
 * (e.g. the adopt banner's alreadyOwn check) - never for the legacy-blob adopt-banner decision,
 * which needs the meaningful-data check below (N2). */
export async function hasPersistedBlobAsync(key: string): Promise<boolean> {
  return (await getPersistedBlob(key)) !== null;
}

/**
 * IDB-aware "is there meaningful legacy data to adopt" check (the one BusinessContextGate actually
 * uses). Task 4 (2026-08-09): the localStorage-only sync `hasLegacyBlob` this used to be the "async
 * counterpart" to was removed as dead code (zero production callers). Still built on the SAME
 * `legacyBlobIsMeaningful` predicate as `migrateLegacyBlobOnce(Async)` so the "should we show the
 * banner" and "is there really something to copy" checks can never drift (N2: sign-out's wipe write
 * deposits an effectively-empty blob into the legacy key, and the adopt banner must NOT appear for it).
 */
export async function hasMeaningfulLegacyBlobAsync(): Promise<boolean> {
  return legacyBlobIsMeaningful(await getPersistedBlob(LEGACY_KEY));
}

/**
 * Async counterpart to `migrateLegacyBlobOnce`, IDB-aware. Same contract: idempotent (no-op if the
 * per-uid slot already holds data), copies + normalizes quantityDelta:0 -> 1, then deletes the
 * legacy blob from BOTH stores only after the copy has landed successfully.
 */
/**
 * P8 (adoption ignored demotion): the persist wrapper PROBES IndexedDB and demotes to localStorage
 * when it is present-but-broken (Chrome block-site-data, enterprise policy, Safari lockdown) - so in
 * that environment scans persist fine, in localStorage. The adopt path, by contrast, selected the
 * async/IDB route purely on `typeof indexedDB !== "undefined"` (scanStore) and then used IDB
 * EXCLUSIVELY, so Adopt threw and failed forever for exactly those users.
 *
 * The fallback lives here rather than at the scanStore call site so both callers get it: catch the
 * IndexedDB failure and write to localStorage, which is where the live data already is in precisely
 * this environment. The "throws propagate" contract that protects the anon blob (never delete the
 * source unless the copy landed SOMEWHERE) is preserved exactly - it now requires BOTH paths to fail.
 */
async function writeAdoptedBlob(targetKey: string, normalized: string): Promise<void> {
  const backing = idb();
  if (backing) {
    try {
      await backing.setItem(targetKey, normalized);
      return;
    } catch (err) {
      const local = ls();
      if (!local) throw err; // no second store to try: propagate, source stays intact
      try {
        local.setItem(targetKey, normalized);
        return;
      } catch {
        throw err; // BOTH stores failed: propagate the original cause, source stays intact
      }
    }
  }
  const local = ls();
  if (!local) throw new Error("adopt failed: neither IndexedDB nor local storage is available");
  local.setItem(targetKey, normalized);
}

/** Bounded re-copy attempts when the adopt SOURCE changes underneath us (P6). */
const ADOPT_SOURCE_RECHECKS = 3;

/**
 * Async counterpart to `migrateLegacyBlobOnce`, IDB-aware. Same contract: idempotent (no-op if the
 * per-uid slot already holds data), copies + normalizes quantityDelta:0 -> 1, then deletes the
 * legacy blob from BOTH stores only after the copy has landed successfully.
 *
 * P6 (non-atomic source delete): existence-check / read / write / delete were four separate steps
 * with no recheck, so a scan appended to the legacy key BETWEEN the read and the delete was silently
 * destroyed - the delete removed a blob newer than the one that was copied. Cheap fix, no lock: after
 * the target write lands and BEFORE deleting the source, re-read the source; if it no longer matches
 * what was copied, copy the newer content again (bounded retries) and re-check.
 *
 * RESIDUAL RACES, stated honestly rather than papered over:
 *  - The window is narrowed, not closed. A write that lands between the final recheck and the delete
 *    is still lost. Closing it needs a real cross-tab lock (Web Locks / a lock record), which is a
 *    larger change than this defect warrants; the remaining window is a few microtasks wide, versus
 *    the previous window that spanned an entire await'd IndexedDB write.
 *  - If the source keeps advancing past ADOPT_SOURCE_RECHECKS (a scan session actively running into
 *    an adopt - not a realistic user flow, since adopt is an explicit owner action on a signed-in
 *    gate), the last observed content is copied and the source is then deleted.
 *  - DOUBLE ADOPT (two tabs adopting the same blob into two different uid keys) is TOLERATED, not
 *    prevented: the target-exists idempotency check means the second tab is a no-op for ITS OWN key
 *    only, so two distinct uids can each end up with a copy. That is the pre-existing behaviour and
 *    it is not a data-loss bug (nothing is destroyed; both copies are complete), so it is left alone
 *    deliberately - preventing it also needs a cross-tab lock.
 */
export async function migrateLegacyBlobOnceAsync(uid: string): Promise<void> {
  const targetKey = persistKeyForUid(uid);
  if (targetKey === LEGACY_KEY) return;
  if (await hasPersistedBlobAsync(targetKey)) return; // already adopted: leave everything as-is

  for (let attempt = 0; ; attempt++) {
    const copiedRaw = await getPersistedBlob(LEGACY_PERSIST_KEY);
    if (copiedRaw === null) return; // nothing (left) to adopt
    const normalized = normalizeAdoptedBlob(copiedRaw);
    if (normalized === null) return; // unreadable legacy blob: nothing safe to adopt

    await writeAdoptedBlob(targetKey, normalized); // throws propagate BEFORE any source delete

    // P6: the source may have grown while the copy was in flight. Re-read it and, if it changed,
    // copy the newer content instead of deleting a blob we never adopted.
    const sourceNow = await getPersistedBlob(LEGACY_PERSIST_KEY);
    if (sourceNow === null || sourceNow === copiedRaw) break; // unchanged (or already gone): safe
    if (attempt >= ADOPT_SOURCE_RECHECKS) break; // bounded: adopt the last seen content and move on
  }

  removePersistedKeyEverywhere(LEGACY_PERSIST_KEY); // consumed only after the copy landed
}

/** Fail-soft removal of `key` AND its sibling write stamp from both stores. Never throws.
 *  F6: the stamp is part of the key's persisted footprint. Removing only the blob left an orphan
 *  `<key>::stamp` behind, which would then order a blob that no longer exists (and kept one more
 *  per-uid trace of a signed-out user on a shared device). The key format comes from the single
 *  exported `persistStampKey` - never re-spelled here. */
export function removePersistedKeyEverywhere(key: string): void {
  const keys = [key, persistStampKey(key)];
  for (const k of keys) {
    try {
      ls()?.removeItem(k);
    } catch {
      // ignore
    }
    try {
      void idb()
        ?.removeItem(k)
        .catch(() => undefined);
    } catch {
      // ignore
    }
  }
}
