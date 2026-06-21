import "server-only";

import { getApps, initializeApp, cert, applicationDefault, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { getAuth, type Auth } from "firebase-admin/auth";
import { readFileSync } from "node:fs";
import { parseServiceAccountJson, serviceAccountJsonFromEnv } from "@/services/firebaseAdmin/serviceAccount";

// SERVER-ONLY Firebase Admin SDK (bypasses Firestore rules). The `server-only` import makes a build fail
// if this is pulled into a client bundle. Credentials policy (first match wins):
//  - Emulator (FIRESTORE_EMULATOR_HOST set): no credentials needed; the Admin SDK talks to the emulator.
//  - Vercel/serverless (production): credentials come from FIREBASE_SERVICE_ACCOUNT_JSON (or the _BASE64
//    fallback) - the raw JSON lives ONLY in a Vercel env var/secret, never on disk and never committed.
//  - Local dev: a service-account JSON path from FIREBASE_SERVICE_ACCOUNT_PATH or
//    GOOGLE_APPLICATION_CREDENTIALS (a LOCAL, git-ignored path). The JSON contents are NEVER inlined here.

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "demo-smart-inventory";

function adminApp(): App {
  if (getApps().length) return getApps()[0];
  const usingEmulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST);
  if (usingEmulator) {
    return initializeApp({ projectId: PROJECT_ID });
  }
  // Production (Vercel/serverless): credentials supplied as an env var, since there is no secret file on
  // disk. This is the primary path on Vercel; it falls through to the local options below when unset.
  const saJson = serviceAccountJsonFromEnv();
  if (saJson) {
    const sa = parseServiceAccountJson(saJson);
    return initializeApp({ credential: cert(sa), projectId: sa.projectId ?? PROJECT_ID });
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
