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
  PILOT_BIZ,
  PILOT_COUNTER_UID,
  PILOT_COUNTER_EMAIL,
  PILOT_VIEWER_UID,
  PILOT_VIEWER_EMAIL,
  PILOT_ROLE_PASSWORD,
  PILOT_TIRE_PRODUCT_ID,
  PILOT_TIRE_BARCODE,
  PILOT_TIRE_SKU,
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

  // ---- Controlled pilot business (isolated): tire product + owner/counter/viewer roles ----
  const ensureUser = async (uid: string, email: string) => {
    try {
      await auth.createUser({ uid, email, password: PILOT_ROLE_PASSWORD });
    } catch (e) {
      const code = (e as { code?: string }).code ?? "";
      if (!code.includes("already-exists") && !code.includes("uid-already-exists")) throw e;
    }
  };
  await ensureUser(PILOT_COUNTER_UID, PILOT_COUNTER_EMAIL);
  await ensureUser(PILOT_VIEWER_UID, PILOT_VIEWER_EMAIL);

  // The login user (UID) owns the pilot business; counter + viewer are members with their roles.
  await db.doc(`businesses/${PILOT_BIZ}`).set({ name: "Pilot Tire Shop", createdBy: UID });
  await db.doc(`businessMembers/${PILOT_BIZ}_${UID}`).set({ businessId: PILOT_BIZ, userId: UID, role: "owner" });
  await db.doc(`businessMembers/${PILOT_BIZ}_${PILOT_COUNTER_UID}`).set({ businessId: PILOT_BIZ, userId: PILOT_COUNTER_UID, role: "counter" });
  await db.doc(`businessMembers/${PILOT_BIZ}_${PILOT_VIEWER_UID}`).set({ businessId: PILOT_BIZ, userId: PILOT_VIEWER_UID, role: "viewer" });

  // A verified tire product (factual spec fields only) with a barcode + an approved SKU alias.
  await db.doc(`businesses/${PILOT_BIZ}/products/${PILOT_TIRE_PRODUCT_ID}`).set({
    businessId: PILOT_BIZ,
    name: "Michelin Pilot Sport 4",
    brand: "Michelin",
    category: "Tire",
    specsShort: "245/40R18 97Y",
    primaryBarcode: PILOT_TIRE_BARCODE,
    primarySku: PILOT_TIRE_SKU,
    aliases: [PILOT_TIRE_BARCODE, PILOT_TIRE_SKU],
    verified: true,
    source: "manual",
  });
  await db.doc(`businesses/${PILOT_BIZ}/aliases/alias-pilot-1`).set({
    businessId: PILOT_BIZ, productId: PILOT_TIRE_PRODUCT_ID, cleanCode: PILOT_TIRE_BARCODE, normalizedCode: PILOT_TIRE_BARCODE,
    aliasType: "barcode", approved: true, source: "manual",
  });
  await db.doc(`businesses/${PILOT_BIZ}/aliases/alias-pilot-2`).set({
    businessId: PILOT_BIZ, productId: PILOT_TIRE_PRODUCT_ID, cleanCode: PILOT_TIRE_SKU, normalizedCode: PILOT_TIRE_SKU,
    aliasType: "sku", approved: true, source: "manual",
  });
}
