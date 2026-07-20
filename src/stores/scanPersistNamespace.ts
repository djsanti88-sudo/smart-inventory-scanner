// Per-uid persist namespacing for the scan store. The anon/mock path keeps the legacy global key
// "sis-scan-v1" byte-for-byte so demos and every existing test are unaffected; a signed-in user gets
// their own "sis-scan-<uid>" key so two users on one browser never share persisted state.

const LEGACY_KEY = "sis-scan-v1";

export function persistKeyForUid(uid: string | null): string {
  return uid ? `sis-scan-${uid}` : LEGACY_KEY;
}

/** Whether the legacy pre-account global blob exists on this browser (drives the adopt banner). */
export function hasLegacyBlob(storage: Storage): boolean {
  return storage.getItem(LEGACY_KEY) !== null;
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
