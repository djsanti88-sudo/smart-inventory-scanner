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

// Seeds the Firebase EMULATOR before the Firebase-backed Playwright run: a real Auth user (so the spec
// signs in through the real login UI), a business + owner membership, and one known product with two
// approved alias codes. Runs inside `firebase emulators:exec`, so the emulator host env vars are set and
// the Admin SDK talks to the emulator (no cloud, no secrets).
export default async function globalSetup() {
  const auth = adminAuth();
  const db = adminDb();

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
