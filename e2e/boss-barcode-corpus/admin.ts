import { getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

export const LOCAL_CORPUS_BUSINESS_ID = "local-corpus-certification";
export const LOCAL_CORPUS_UID = "local-corpus-certification-member";
export const LOCAL_CORPUS_EMAIL = "local-corpus-certification-member@test.local";
export const LOCAL_CORPUS_PASSWORD = "local-corpus-certification-password";

function app(): App {
  return getApps().find((candidate) => candidate.name === "local-corpus-certification")
    ?? initializeApp({ projectId: "demo-smart-inventory" }, "local-corpus-certification");
}
export const adminDb = (): Firestore => getFirestore(app());

async function clearCollection(db: Firestore, path: string) {
  const snapshot = await db.collection(path).get();
  if (snapshot.empty) return;
  const batch = db.batch();
  snapshot.docs.forEach((document) => batch.delete(document.ref));
  await batch.commit();
}

/** Synthetic, ordinary owner membership for the local emulator only. */
export async function seedLocalCorpusTenant() {
  const auth = getAuth(app()); const db = adminDb();
  await Promise.all(["products", "aliases", "scanEvents", "inventoryCounts", "countSessions", "unknownCodeReviews", "auditLog", "_appliedKeys"].map((name) => clearCollection(db, `businesses/${LOCAL_CORPUS_BUSINESS_ID}/${name}`)));
  try { await auth.createUser({ uid: LOCAL_CORPUS_UID, email: LOCAL_CORPUS_EMAIL, password: LOCAL_CORPUS_PASSWORD }); }
  catch (error) { if (!String((error as { code?: string }).code ?? "").includes("already-exists")) throw error; }
  await db.doc(`businesses/${LOCAL_CORPUS_BUSINESS_ID}`).set({ name: "Local corpus certification (synthetic)", createdBy: LOCAL_CORPUS_UID });
  await db.doc(`businessMembers/${LOCAL_CORPUS_BUSINESS_ID}_${LOCAL_CORPUS_UID}`).set({ businessId: LOCAL_CORPUS_BUSINESS_ID, userId: LOCAL_CORPUS_UID, role: "owner" });
  // Pin the same ordinary business the login provisioner will select; this prevents an old emulator
  // profile from silently creating a default tenant and turning a persistence test into a UI-only run.
  await db.doc(`userProfiles/${LOCAL_CORPUS_UID}`).set({ authUserId: LOCAL_CORPUS_UID, email: LOCAL_CORPUS_EMAIL, defaultBusinessId: LOCAL_CORPUS_BUSINESS_ID });
}
