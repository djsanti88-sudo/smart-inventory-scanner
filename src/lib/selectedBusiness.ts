"use client";

// The business the user has selected to scan against (Firebase backend). Persisted locally so the
// selection survives a refresh; the actual authority is the user's real Firestore membership, which the
// scan page re-verifies before calling setBusinessContext. We NEVER fabricate a businessId here.

const KEY = "sis-selected-business-v1";
export const SELECTED_BUSINESS_CHANGED_EVENT = "sis:selected-business-changed";

export function getSelectedBusinessId(): string | null {
  if (typeof window === "undefined" || !window.localStorage) return null;
  try {
    return window.localStorage.getItem(KEY) || null;
  } catch {
    return null;
  }
}

export function setSelectedBusinessId(businessId: string): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    window.localStorage.setItem(KEY, businessId);
  } catch {
    // ignore quota/serialization errors
  }
}

export function clearSelectedBusinessId(): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

/** Whether the app is running against the cloud backend (vs the local mock).
 *  Legacy name, kept because BusinessContextGate and its five suites mock this module by this
 *  export; the implementation lives once in @/services/config/backend. */
export { isCloudBackendEnabled as isFirebaseBackend } from "@/services/config/backend";
