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

function getOrCreate(storage: Storage, key: string, idFactory?: () => string): string {
  const existing = storage.getItem(key);
  if (existing) return existing;
  const fresh = idFactory ? idFactory() : crypto.randomUUID();
  storage.setItem(key, fresh);
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
