// Stable client-side identity, used ONLY to derive idempotent auto-session keys (Phase 3). Never
// used to decide whether a scan counts - that guarantee comes entirely from the existing
// _appliedKeys transaction (firebaseSyncTarget.ts) and per-event idempotencyKey. Pure: no React,
// no next/*, works against any Storage-shaped object so it is trivially testable without jsdom.
//
// Two distinct identities, matching the two different lifetimes the spec calls for:
//   - deviceId (localStorage): survives closing the tab/browser; identifies "this browser profile
//     on this device." One device may have many tabs; they all share one deviceId.
//   - windowId (sessionStorage): scoped to one tab; a fresh tab gets a fresh windowId. sessionStorage
//     is naturally per-tab in every browser, which is exactly the "window" granularity needed - this
//     is UNRELATED to the app's own InventorySession concept, despite the name collision risk.

export const DEVICE_ID_KEY = "sis-device-id";
export const WINDOW_ID_KEY = "sis-window-id";

// FINDING 1 (Codex clean-room review, 2026-08-16, CRITICAL): a real browser Storage object can throw
// synchronously on getItem or setItem - Safari private mode, blocked cookies, a full quota. This
// function sits ahead of processScan's outer Layer C try/catch (scanStore.ts ensureAutoSession runs
// before that boundary), so an uncaught throw here silently dropped the scan with no feed row, no
// count, and no log: the exact TOP-LEVEL LAW violation Layer C exists to prevent. Fail-soft instead:
// on either call throwing, fall back to a fresh ephemeral (session-only, not persisted) id rather than
// ever propagating the error. Losing device-id persistence for that one call degrades a
// nice-to-have (idempotent auto-session keys); throwing degrades the TOP-LEVEL LAW itself.
function getOrCreate(storage: Storage, key: string, idFactory?: () => string): string {
  const mintFresh = () => (idFactory ? idFactory() : crypto.randomUUID());
  let existing: string | null = null;
  try {
    existing = storage.getItem(key);
  } catch (err) {
    console.error(`[deviceIdentity] storage.getItem('${key}') threw; using an ephemeral id for this call.`, err);
    return mintFresh();
  }
  if (existing) return existing;
  const fresh = mintFresh();
  try {
    storage.setItem(key, fresh);
  } catch (err) {
    console.error(`[deviceIdentity] storage.setItem('${key}') threw; continuing with an ephemeral (unpersisted) id.`, err);
  }
  return fresh;
}

/** Stable per-device id, persisted in localStorage. Minted once, reused forever on this device. */
export function getOrCreateDeviceId(storage: Storage, idFactory?: () => string): string {
  return getOrCreate(storage, DEVICE_ID_KEY, idFactory);
}

/** Stable per-tab id, persisted in sessionStorage. Minted once per tab lifetime. */
export function getOrCreateWindowId(storage: Storage, idFactory?: () => string): string {
  return getOrCreate(storage, WINDOW_ID_KEY, idFactory);
}
