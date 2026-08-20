import {
  adminAuth,
  adminDb,
  BIZ,
  UID,
  EMAIL,
  PASSWORD,
  KNOWN_PRODUCT_ID,
  KNOWN_BARCODE,
  ALIAS_CODE,
  TWO_ACCOUNT_FIXTURES,
  type AccountTenantFixture,
} from "./admin";
import type { Firestore } from "firebase-admin/firestore";

async function clearCollection(db: Firestore, path: string) {
  const snap = await db.collection(path).get();
  if (snap.empty) return;
  const batch = db.batch();
  for (const doc of snap.docs) batch.delete(doc.ref);
  await batch.commit();
}

async function createOrReuseUser(fixture: { uid: string; email: string; password: string }) {
  try {
    await adminAuth().createUser({ uid: fixture.uid, email: fixture.email, password: fixture.password });
  } catch (e) {
    const code = (e as { code?: string }).code ?? "";
    if (!code.includes("already-exists") && !code.includes("uid-already-exists")) throw e;
  }
}

async function clearTenant(db: Firestore, businessId: string) {
  await Promise.all([
    clearCollection(db, `businesses/${businessId}/products`),
    clearCollection(db, `businesses/${businessId}/aliases`),
    clearCollection(db, `businesses/${businessId}/scanEvents`),
    clearCollection(db, `businesses/${businessId}/inventoryCounts`),
    clearCollection(db, `businesses/${businessId}/countSessions`),
    clearCollection(db, `businesses/${businessId}/unknownCodeReviews`),
    clearCollection(db, `businesses/${businessId}/auditLog`),
    clearCollection(db, `businesses/${businessId}/_appliedKeys`),
  ]);
}

async function seedTwoAccountTenant(db: Firestore, fixture: AccountTenantFixture) {
  await createOrReuseUser(fixture);
  await clearTenant(db, fixture.businessId);

  await db.doc(`businesses/${fixture.businessId}`).set({
    name: fixture.businessName,
    createdBy: fixture.uid,
  });
  await db.doc(`businessMembers/${fixture.businessId}_${fixture.uid}`).set({
    businessId: fixture.businessId,
    userId: fixture.uid,
    role: "owner",
  });
  await db.doc(`userProfiles/${fixture.uid}`).set({
    authUserId: fixture.uid,
    email: fixture.email,
    defaultBusinessId: fixture.businessId,
  });

  await db.doc(`businesses/${fixture.businessId}/products/${fixture.productId}`).set({
    businessId: fixture.businessId,
    name: fixture.productName,
    brand: `Tenant ${fixture.label}`,
    category: "Isolation Proof",
    primaryBarcode: fixture.markerBarcode,
    aliases: [fixture.markerBarcode, fixture.scanBarcode],
    verified: true,
    source: "manual",
  });
  await db.doc(`businesses/${fixture.businessId}/aliases/alias-${fixture.label.toLowerCase()}-marker`).set({
    businessId: fixture.businessId,
    productId: fixture.productId,
    cleanCode: fixture.markerBarcode,
    normalizedCode: fixture.markerBarcode,
    aliasType: "barcode",
    approved: true,
    source: "manual",
  });
  await db.doc(`businesses/${fixture.businessId}/aliases/alias-${fixture.label.toLowerCase()}-scan`).set({
    businessId: fixture.businessId,
    productId: fixture.productId,
    cleanCode: fixture.scanBarcode,
    normalizedCode: fixture.scanBarcode,
    aliasType: "barcode",
    approved: true,
    source: "manual",
  });

  const nowIso = `2026-08-20T12:00:0${fixture.label === "A" ? "1" : "2"}.000Z`;
  await db.doc(`businesses/${fixture.businessId}/countSessions/${fixture.sessionId}`).set({
    id: fixture.sessionId,
    businessId: fixture.businessId,
    name: `Tenant ${fixture.label} Active Session`,
    status: "active",
    location: `Bay ${fixture.label}`,
    startedBy: fixture.uid,
    startedAt: nowIso,
    createdAt: nowIso,
    updatedAt: nowIso,
  });
  await db.doc(`businesses/${fixture.businessId}/scanEvents/${fixture.seededEventId}`).set({
    id: fixture.seededEventId,
    businessId: fixture.businessId,
    sessionId: fixture.sessionId,
    countSessionId: fixture.sessionId,
    rawCode: fixture.markerBarcode,
    cleanCode: fixture.markerBarcode,
    normalizedCode: fixture.markerBarcode,
    matchedProductId: fixture.productId,
    quantityDelta: 1,
    status: "known",
    syncStatus: "synced",
    scannedBy: fixture.uid,
    scannedAt: nowIso,
    createdAt: nowIso,
  });
  await db.doc(`businesses/${fixture.businessId}/inventoryCounts/${fixture.sessionId}_${fixture.productId}`).set({
    id: `${fixture.sessionId}_${fixture.productId}`,
    businessId: fixture.businessId,
    countSessionId: fixture.sessionId,
    productId: fixture.productId,
    countedQuantity: 1,
    scanEventIds: [fixture.seededEventId],
    updatedAt: nowIso,
  });
  await db.doc(`businesses/${fixture.businessId}/unknownCodeReviews/${fixture.seededReviewId}`).set({
    id: fixture.seededReviewId,
    businessId: fixture.businessId,
    countSessionId: fixture.sessionId,
    rawCode: `${fixture.label}-review-marker`,
    cleanCode: `${fixture.label}-review-marker`,
    normalizedCode: `${fixture.label}-review-marker`,
    status: "open",
    decodeStatus: "needs_review",
    evidenceStrength: "none",
    reason: `Tenant ${fixture.label} review marker`,
    createdBy: fixture.uid,
    createdAt: nowIso,
    reviewedAt: nowIso,
  });
}

// Seeds the Firebase EMULATOR before the Firebase-backed Playwright run: a real Auth user (so the spec
// signs in through the real login UI), a business + owner membership, and one known product with two
// approved alias codes. Runs inside `firebase emulators:exec`, so the emulator host env vars are set and
// the Admin SDK talks to the emulator (no cloud, no secrets).
export default async function globalSetup() {
  const db = adminDb();

  // The orchestrator and external QA cells can reuse a long-lived emulator instead of always running
  // through `firebase emulators:exec`. Start each proof from a clean tenant so a previous learned alias
  // for UNKNOWN_CODE cannot hide the review row and turn this into a false-green/false-red run.
  await Promise.all([
    clearCollection(db, `businesses/${BIZ}/products`),
    clearCollection(db, `businesses/${BIZ}/aliases`),
    clearCollection(db, `businesses/${BIZ}/scanEvents`),
    clearCollection(db, `businesses/${BIZ}/inventoryCounts`),
    clearCollection(db, `businesses/${BIZ}/countSessions`),
    clearCollection(db, `businesses/${BIZ}/unknownReviews`),
    clearCollection(db, `businesses/${BIZ}/auditLog`),
    clearCollection(db, `businesses/${BIZ}/_appliedKeys`),
  ]);

  // Idempotent: a fresh emulator each run, but tolerate a pre-existing user on reuse.
  await createOrReuseUser({ uid: UID, email: EMAIL, password: PASSWORD });

  await db.doc(`businesses/${BIZ}`).set({ name: "FB E2E Co", createdBy: UID });
  await db.doc(`businessMembers/${BIZ}_${UID}`).set({ businessId: BIZ, userId: UID, role: "owner" });

  await db.doc(`businesses/${BIZ}/products/${KNOWN_PRODUCT_ID}`).set({
    businessId: BIZ,
    name: "FB Known Widget",
    brand: "Acme",
    category: "Test",
    primaryBarcode: KNOWN_BARCODE,
    aliases: [KNOWN_BARCODE, ALIAS_CODE],
    verified: true,
    source: "manual",
  });
  await db.doc(`businesses/${BIZ}/aliases/alias-fb-1`).set({
    businessId: BIZ, productId: KNOWN_PRODUCT_ID, cleanCode: KNOWN_BARCODE, normalizedCode: KNOWN_BARCODE,
    aliasType: "barcode", approved: true, source: "manual",
  });
  await db.doc(`businesses/${BIZ}/aliases/alias-fb-2`).set({
    businessId: BIZ, productId: KNOWN_PRODUCT_ID, cleanCode: ALIAS_CODE, normalizedCode: ALIAS_CODE,
    aliasType: "barcode", approved: true, source: "manual",
  });

  for (const fixture of TWO_ACCOUNT_FIXTURES) {
    await seedTwoAccountTenant(db, fixture);
  }
}
