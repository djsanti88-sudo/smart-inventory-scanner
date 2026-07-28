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
} from "./admin";
import type { Firestore } from "firebase-admin/firestore";

async function clearCollection(db: Firestore, path: string) {
  const snap = await db.collection(path).get();
  if (snap.empty) return;
  const batch = db.batch();
  for (const doc of snap.docs) batch.delete(doc.ref);
  await batch.commit();
}

// Seeds the Firebase EMULATOR before the Firebase-backed Playwright run: a real Auth user (so the spec
// signs in through the real login UI), a business + owner membership, and one known product with two
// approved alias codes. Runs inside `firebase emulators:exec`, so the emulator host env vars are set and
// the Admin SDK talks to the emulator (no cloud, no secrets).
export default async function globalSetup() {
  const auth = adminAuth();
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
  try {
    await auth.createUser({ uid: UID, email: EMAIL, password: PASSWORD });
  } catch (e) {
    const code = (e as { code?: string }).code ?? "";
    if (!code.includes("already-exists") && !code.includes("uid-already-exists")) throw e;
  }

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
}
