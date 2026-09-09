"use client";

import { initializeApp, getApps, getApp, type FirebaseApp } from "firebase/app";
import { getAuth, connectAuthEmulator, type Auth } from "firebase/auth";
import { initializeFirestore, getFirestore, connectFirestoreEmulator, type Firestore } from "firebase/firestore";

// Browser Firebase app (Auth + Firestore). Uses only public NEXT_PUBLIC_FIREBASE_* config. When
// NEXT_PUBLIC_FIREBASE_USE_EMULATOR=1 it connects to the local emulators (no cloud, no secrets). For the
// emulator a dummy apiKey/appId is fine. The Admin SDK / service account is never imported here.

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || "demo-api-key",
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || "demo-smart-inventory.firebaseapp.com",
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "demo-smart-inventory",
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || "demo-smart-inventory.appspot.com",
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || "0",
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || "demo-app-id",
};

const useEmulator = process.env.NEXT_PUBLIC_FIREBASE_USE_EMULATOR === "1";
const AUTH_EMULATOR_URL = process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_URL || "http://127.0.0.1:9099";
const FIRESTORE_EMULATOR_HOST = process.env.NEXT_PUBLIC_FIREBASE_FIRESTORE_EMULATOR_HOST || "127.0.0.1";
const FIRESTORE_EMULATOR_PORT = Number(process.env.NEXT_PUBLIC_FIREBASE_FIRESTORE_EMULATOR_PORT || 8080);

let authWired = false;
let dbWired = false;

function app(): FirebaseApp {
  return getApps().length ? getApp() : initializeApp(firebaseConfig);
}

export function getFirebaseAuth(): Auth {
  const a = getAuth(app());
  if (useEmulator && !authWired) {
    connectAuthEmulator(a, AUTH_EMULATOR_URL, { disableWarnings: true });
    authWired = true;
  }
  return a;
}

export function getDb(): Firestore {
  // ignoreUndefinedProperties: store entities carry optional fields (a known scan never gets a
  // decodeStatus, for example). Firestore rejects `undefined` values outright, which made EVERY
  // known-scan SAVE_SCAN_EVENT fail permanently against the real backend (caught 2026-07-22 when
  // the emulator e2e first ran against the real backend again). With the flag, undefined fields are
  // simply omitted from the written doc. initializeFirestore throws if called after getFirestore
  // for the same app, so fall back to the already-initialized instance.
  // Emulator only: the Java emulator's WebChannel streaming breaks under large Listen snapshots
  // (repeated transport errors observed at 4,500-doc restores), which stalls fresh-device
  // bootstrap indefinitely. Long polling is the documented workaround; production keeps the
  // SDK's default transport auto-detection.
  let d: Firestore;
  try {
    d = initializeFirestore(app(), {
      ignoreUndefinedProperties: true,
      ...(useEmulator ? { experimentalForceLongPolling: true } : {}),
    });
  } catch {
    d = getFirestore(app());
  }
  if (useEmulator && !dbWired) {
    connectFirestoreEmulator(d, FIRESTORE_EMULATOR_HOST, FIRESTORE_EMULATOR_PORT);
    dbWired = true;
  }
  return d;
}

export function isFirebaseEmulator(): boolean {
  return useEmulator;
}
