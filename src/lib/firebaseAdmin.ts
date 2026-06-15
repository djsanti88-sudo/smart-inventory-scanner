import "server-only";

import { getApps, initializeApp, cert, applicationDefault, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { getAuth, type Auth } from "firebase-admin/auth";
import { readFileSync } from "node:fs";

// SERVER-ONLY Firebase Admin SDK (bypasses Firestore rules). The `server-only` import makes a build fail
// if this is pulled into a client bundle. Credentials policy:
//  - Emulator (FIRESTORE_EMULATOR_HOST set): no credentials needed; the Admin SDK talks to the emulator.
//  - Real project: a service-account JSON path is read from GOOGLE_APPLICATION_CREDENTIALS or
//    FIREBASE_SERVICE_ACCOUNT_PATH (a LOCAL, git-ignored path). The JSON contents are NEVER inlined here
//    or committed. (Not used in Phase 1 - emulator-only.)

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "demo-smart-inventory";

function adminApp(): App {
  if (getApps().length) return getApps()[0];
  const usingEmulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST);
  if (usingEmulator) {
    return initializeApp({ projectId: PROJECT_ID });
  }
  const saPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (saPath) {
    const sa = JSON.parse(readFileSync(saPath, "utf8"));
    return initializeApp({ credential: cert(sa), projectId: sa.project_id ?? PROJECT_ID });
  }
  // GOOGLE_APPLICATION_CREDENTIALS (path) or workload identity.
  return initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });
}

export function getAdminDb(): Firestore {
  return getFirestore(adminApp());
}

export function getAdminAuth(): Auth {
  return getAuth(adminApp());
}
