import { initializeApp, getApps, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

// Admin helper for the Firebase EMULATOR only (used by the Playwright global setup to seed a real Auth
// user + business + membership + a known product/aliases, and by the spec to assert persisted state).
// The Admin SDK auto-connects to the emulators when FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST
// are set (firebase emulators:exec sets them). No service-account JSON is ever used.

export const PROJECT_ID = "demo-smart-inventory";
export const BIZ = "biz-e2e-fb";
export const UID = "e2e-fb-user";
export const EMAIL = "fbtester@test.local";
export const PASSWORD = "test1234";

// Pre-seeded known product + two approved alias codes (so "scan known" + "scan alias" both resolve).
export const KNOWN_PRODUCT_ID = "prod-fbtest";
export const KNOWN_BARCODE = "1111111111";
export const ALIAS_CODE = "2222222222";
export const UNKNOWN_CODE = "9999999999";

// ---- Controlled automated pilot (Stage 2): isolated tire-domain business + owner/counter/viewer roles.
// Kept in its OWN business so it never interferes with the firebase-flow spec's business (BIZ).
export const PILOT_BIZ = "biz-pilot";
export const PILOT_COUNTER_UID = "pilot-counter";
export const PILOT_COUNTER_EMAIL = "counter@test.local";
export const PILOT_VIEWER_UID = "pilot-viewer";
export const PILOT_VIEWER_EMAIL = "viewer@test.local";
export const PILOT_ROLE_PASSWORD = "test1234";
// A real tire product (factual spec fields only) + alias SKU; plus an unknown tire code to approve.
export const PILOT_TIRE_PRODUCT_ID = "prod-pilot-tire";
export const PILOT_TIRE_BARCODE = "4019238847352"; // sample GTIN-shaped code for the pilot tire
export const PILOT_TIRE_SKU = "MICH-PS4-2454018"; // alias SKU for the same tire
export const PILOT_TIRE_UNKNOWN = "8888888888"; // unknown tire code -> Needs Review -> approve

function adminApp(): App {
  const existing = getApps().find((a) => a.name === "e2e-fb-admin");
  if (existing) return existing;
  return initializeApp({ projectId: PROJECT_ID }, "e2e-fb-admin");
}

export function adminDb(): Firestore {
  return getFirestore(adminApp());
}

export function adminAuth() {
  return getAuth(adminApp());
}
