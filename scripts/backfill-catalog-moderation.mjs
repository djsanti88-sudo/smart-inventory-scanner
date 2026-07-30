#!/usr/bin/env node
// M1 deep-review fix 2 (LEGACY BACKFILL): commit f416404e moved disputedBy/auditLog (raw businessId +
// free-text dispute reasons) off the public catalogEntries/retailCatalogEntries parent docs into a
// locked catalogEntries/{id}/moderation/log subcollection (see catalogDispute.ts,
// catalogModeration.rules.test.ts). That commit fixed the WRITE path going forward but never migrated
// docs that already carried those fields directly on the parent - this script is that one-time
// migration. src/server/catalog/masterAppend.ts's "disputed" remerge path independently migrates a
// SINGLE doc the moment it is re-hit by a fresh ladder decode; this script does the same migration
// proactively across the WHOLE collection so stale legacy data does not sit exposed on the public
// parent doc indefinitely waiting for a re-decode that may never come.
//
// For each catalogEntries / retailCatalogEntries doc still carrying disputedBy and/or auditLog
// directly on the parent:
//   1. Read the doc's moderation/log subdoc (if any).
//   2. Merge the legacy parent fields into it (moderation entries win; only legacy businessIds not
//      already recorded there are folded in - mirrors masterAppend.ts's merge so a business already
//      disputed once is never double-counted toward the 3-distinct-business threshold).
//   3. Write the merged moderation doc (merge: true) and strip disputedBy/auditLog off the parent
//      with FieldValue.delete(), batched (<=400 writes/batch to stay comfortably under Firestore's
//      500-write batch cap since each migrated doc contributes 2 writes).
//
// Idempotent: a doc with no disputedBy/auditLog on the parent is not touched at all, so re-running
// this script after a successful pass is always a safe no-op (nothing left to migrate).
//
// Usage:
//   node scripts/backfill-catalog-moderation.mjs                 # dry-run (default): prints counts, no writes
//   node scripts/backfill-catalog-moderation.mjs --dry-run
//   node scripts/backfill-catalog-moderation.mjs --execute        # performs the migration
//   node scripts/backfill-catalog-moderation.mjs --execute --sa C:\path\service-account.json
//
// Credentials (first match, only needed to connect at all - both dry-run and --execute read live):
//   FIRESTORE_EMULATOR_HOST env var (no credentials; Admin SDK talks to the local emulator) |
//   --sa <path> | FIREBASE_SERVICE_ACCOUNT_JSON | FIREBASE_SERVICE_ACCOUNT_PATH |
//   GOOGLE_APPLICATION_CREDENTIALS
//
// SAFETY: this script has been proven against the Firestore EMULATOR ONLY. Do not run --execute
// against the real cloud project without explicit owner approval in the moment (project doctrine:
// production DB writes are always owner-gated) - it refuses to run against a non-emulator project
// other than the expected one as a guard, but that is not a substitute for owner sign-off.

import { readFileSync } from "node:fs";

const EXPECTED_PROJECT = "smart-inventory-scanner-app";
const CATALOG_COLLECTIONS = ["catalogEntries", "retailCatalogEntries"];
const PAGE_SIZE = 500;
const MAX_WRITES_PER_BATCH = 400; // 2 writes/migrated doc; stays well under Firestore's 500 hard cap.

function argVal(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (f) => process.argv.includes(f);
function die(msg, code = 1) {
  console.error("BLOCKER: " + msg);
  process.exit(code);
}

function usingEmulator() {
  return Boolean(process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST);
}

function loadServiceAccount() {
  let raw;
  const saArg = argVal("--sa");
  if (saArg) raw = readFileSync(saArg, "utf8");
  else if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) raw = readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8");
  else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) raw = readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8");
  if (!raw) die(`credentials required (pass --sa <path>, or set FIREBASE_SERVICE_ACCOUNT_JSON / FIREBASE_SERVICE_ACCOUNT_PATH / GOOGLE_APPLICATION_CREDENTIALS, or run against the emulator with FIRESTORE_EMULATOR_HOST set)`, 2);
  let sa;
  try {
    sa = JSON.parse(raw);
  } catch {
    return die("service account is not valid JSON", 2);
  }
  if (typeof sa.private_key === "string") sa.private_key = sa.private_key.replace(/\\n/g, "\n");
  if (sa.project_id !== EXPECTED_PROJECT) die(`service account project_id is not ${EXPECTED_PROJECT} (refusing to touch the wrong project)`, 2);
  return sa;
}

async function connect() {
  const { initializeApp, cert, getApps } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  if (getApps().length) return getFirestore();
  if (usingEmulator()) {
    const projectId = process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "demo-smart-inventory";
    initializeApp({ projectId });
    console.log(`Connected to Firestore EMULATOR (${process.env.FIRESTORE_EMULATOR_HOST}), project "${projectId}".`);
    return getFirestore();
  }
  const sa = loadServiceAccount();
  initializeApp({ credential: cert(sa), projectId: EXPECTED_PROJECT });
  console.log(`Connected to REAL Firestore project "${EXPECTED_PROJECT}". This is NOT the emulator.`);
  return getFirestore();
}

/** True if the doc still carries a legacy disputedBy/auditLog field directly on the parent. */
function hasLegacyModerationFields(data) {
  return data && (data.disputedBy !== undefined || data.auditLog !== undefined);
}

/**
 * Merge legacy parent fields into the moderation doc's own data (mirrors
 * src/server/catalog/masterAppend.ts's "disputed" remerge migration): moderation entries win;
 * only legacy businessIds not already present there are folded in, so a business already disputed
 * once is never double-counted toward the 3-distinct-business human_verified demotion threshold.
 */
function mergeModerationData(legacyDisputedBy, legacyAuditLog, modData) {
  const existingModDisputedBy = Array.isArray(modData?.disputedBy) ? modData.disputedBy : [];
  const existingModAuditLog = Array.isArray(modData?.auditLog) ? modData.auditLog : [];
  const legacyDisputedByArr = Array.isArray(legacyDisputedBy) ? legacyDisputedBy : [];
  const legacyAuditLogArr = Array.isArray(legacyAuditLog) ? legacyAuditLog : [];

  const knownBusinessIds = new Set(existingModDisputedBy.map((d) => d?.businessId));
  const mergedDisputedBy = [
    ...existingModDisputedBy,
    ...legacyDisputedByArr.filter((d) => !knownBusinessIds.has(d?.businessId)),
  ];
  const mergedAuditLog = [...legacyAuditLogArr, ...existingModAuditLog];
  return { disputedBy: mergedDisputedBy, auditLog: mergedAuditLog };
}

/** Paginate the whole collection (query-cursor scan), yielding every doc snapshot. */
async function* scanCollection(db, collectionName) {
  let lastDoc;
  for (;;) {
    let q = db.collection(collectionName).orderBy("__name__").limit(PAGE_SIZE);
    if (lastDoc) q = q.startAfter(lastDoc);
    const snap = await q.get();
    if (snap.empty) return;
    for (const doc of snap.docs) yield doc;
    lastDoc = snap.docs[snap.docs.length - 1];
    if (snap.docs.length < PAGE_SIZE) return;
  }
}

async function findLegacyDocs(db, collectionName) {
  const found = [];
  let scanned = 0;
  for await (const doc of scanCollection(db, collectionName)) {
    scanned++;
    const data = doc.data();
    if (hasLegacyModerationFields(data)) {
      found.push({ id: doc.id, disputedBy: data.disputedBy, auditLog: data.auditLog });
    }
  }
  return { scanned, found };
}

async function migrateCollection(db, collectionName, legacyDocs, { FieldValue }) {
  let migrated = 0;
  let pendingWrites = 0;
  let batch = db.batch();

  const flush = async () => {
    if (pendingWrites === 0) return;
    await batch.commit();
    pendingWrites = 0;
    batch = db.batch();
  };

  for (const legacy of legacyDocs) {
    const parentRef = db.collection(collectionName).doc(legacy.id);
    const modRef = parentRef.collection("moderation").doc("log");
    const modSnap = await modRef.get();
    const merged = mergeModerationData(legacy.disputedBy, legacy.auditLog, modSnap.exists ? modSnap.data() : undefined);

    batch.set(modRef, merged, { merge: true });
    batch.update(parentRef, { disputedBy: FieldValue.delete(), auditLog: FieldValue.delete() });
    pendingWrites += 2;
    migrated++;

    if (pendingWrites >= MAX_WRITES_PER_BATCH) await flush();
  }
  await flush();
  return migrated;
}

async function main() {
  const execute = hasFlag("--execute");
  const dryRun = hasFlag("--dry-run") || !execute; // default to dry-run for safety

  const db = await connect();
  const { FieldValue } = await import("firebase-admin/firestore");

  const report = { mode: dryRun ? "DRY-RUN" : "EXECUTE", collections: {} };

  const perCollection = {};
  for (const collectionName of CATALOG_COLLECTIONS) {
    const { scanned, found } = await findLegacyDocs(db, collectionName);
    perCollection[collectionName] = found;
    report.collections[collectionName] = {
      scanned,
      legacyDocsFound: found.length,
      sample: found.slice(0, 5).map((f) => ({
        id: f.id,
        disputedByCount: Array.isArray(f.disputedBy) ? f.disputedBy.length : f.disputedBy !== undefined ? "non-array" : 0,
        auditLogCount: Array.isArray(f.auditLog) ? f.auditLog.length : f.auditLog !== undefined ? "non-array" : 0,
      })),
    };
  }

  if (dryRun) {
    console.log(JSON.stringify(report, null, 2));
    console.log("DRY-RUN: no writes performed. Re-run with --execute to migrate the legacy fields.");
    return;
  }

  for (const collectionName of CATALOG_COLLECTIONS) {
    const legacyDocs = perCollection[collectionName];
    const migrated = await migrateCollection(db, collectionName, legacyDocs, { FieldValue });
    report.collections[collectionName].migrated = migrated;
  }

  console.log(JSON.stringify(report, null, 2));
  console.log("EXECUTE complete: legacy disputedBy/auditLog fields migrated off the public parent docs.");
}

main().catch((e) => {
  console.error("backfill-catalog-moderation failed:", e?.message || e);
  process.exit(1);
});
