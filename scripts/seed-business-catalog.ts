// Seed a LIVE business's catalog (products + aliases) into Firestore so the deterministic resolver has
// verified products / approved aliases to match. Reuses the canonical demo catalog from src/seed/seedData.ts
// (verified:true products, approved:true aliases, NO Camel product). Uses the Firebase Admin SDK.
//
// Usage:
//   npx tsx scripts/seed-business-catalog.ts --ownerEmail djsanti88@gmail.com --dry-run
//   npx tsx scripts/seed-business-catalog.ts --ownerEmail djsanti88@gmail.com --apply
//   (also: --businessId <id>, --sa <path-to-service-account.json>)
//
// Credentials (first match): --sa <path> | FIREBASE_SERVICE_ACCOUNT_JSON | FIREBASE_SERVICE_ACCOUNT_PATH |
// GOOGLE_APPLICATION_CREDENTIALS. The service account MUST be for smart-inventory-scanner-app (the
// realtor-quiz key is rejected). Secrets are never printed.

import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps, type ServiceAccount } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { getSeed } from "@/seed/seedData";
import { COLLECTIONS } from "@/services/db/types";

const EXPECTED_PROJECT = "smart-inventory-scanner-app";

function argVal(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (f: string) => process.argv.includes(f);
function die(msg: string, code = 1): never {
  console.error("BLOCKER: " + msg);
  process.exit(code);
}

function loadServiceAccount(): { sa: Record<string, unknown>; projectId: string } {
  let raw: string | undefined;
  const saArg = argVal("--sa");
  if (saArg) raw = readFileSync(saArg, "utf8");
  else if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) raw = readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8");
  else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) raw = readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8");
  if (!raw) die(`FIREBASE_SERVICE_ACCOUNT_JSON missing for ${EXPECTED_PROJECT} (pass --sa <path> or set the env var)`, 2);
  let sa: Record<string, unknown>;
  try { sa = JSON.parse(raw); } catch { return die("service account is not valid JSON", 2); }
  if (typeof sa.private_key === "string") sa.private_key = sa.private_key.replace(/\\n/g, "\n");
  const projectId = sa.project_id;
  if (projectId !== EXPECTED_PROJECT) die(`service account project_id is not ${EXPECTED_PROJECT} (refusing to seed the wrong project)`, 2);
  if (typeof sa.client_email !== "string" || typeof sa.private_key !== "string") die("service account missing client_email/private_key", 2);
  return { sa, projectId: EXPECTED_PROJECT };
}

async function resolveBusinessId(db: FirebaseFirestore.Firestore): Promise<string> {
  const explicit = argVal("--businessId");
  if (explicit) return explicit;
  const email = argVal("--ownerEmail");
  if (!email) die("provide --businessId or --ownerEmail");
  const user = await getAuth().getUserByEmail(email!).catch(() => die(`no Auth user for ${email}`));
  const uid = user.uid;
  const ids = new Set<string>();
  const memSnap = await db.collection(COLLECTIONS.businessMembers).where("userId", "==", uid).get();
  memSnap.docs.forEach((d) => { const b = d.data().businessId; if (typeof b === "string" && b) ids.add(b); });
  const detId = `biz-${uid}`;
  if ((await db.collection(COLLECTIONS.businesses).doc(detId).get()).exists) ids.add(detId);
  const arr = [...ids];
  if (arr.length === 0) die(`no business found for ${email} — create one first`);
  if (arr.length > 1) die(`multiple businesses for ${email}: ${arr.join(", ")} — pass --businessId to choose`);
  return arr[0];
}

async function main() {
  const apply = hasFlag("--apply");
  const dryRun = hasFlag("--dry-run") || !apply; // default to dry-run for safety
  const { sa, projectId } = loadServiceAccount();
  if (!getApps().length) initializeApp({ credential: cert(sa as ServiceAccount), projectId });
  const db = getFirestore();

  const businessId = await resolveBusinessId(db);
  const { products, aliases } = getSeed();

  // Safety: never seed a Camel product; Falken codes must point at the Falken product.
  if (products.some((p) => /camel/i.test(p.name) || /camel/i.test(p.brand))) die("seed contains a Camel product — aborting");

  const mode = dryRun ? "DRY-RUN" : "APPLY";
  console.log(JSON.stringify({
    mode, project: projectId, businessId,
    plannedProducts: products.length,
    plannedAliases: aliases.length,
    productIds: products.map((p) => p.id),
    falkenAliasCodes: aliases.filter((a) => a.productId === "prod-falken").map((a) => a.cleanCode),
    nokianBarcodePresent: aliases.some((a) => a.cleanCode === "6419440485331"),
  }, null, 2));

  if (dryRun) { console.log("DRY-RUN: no writes performed. Re-run with --apply to write."); return; }

  const bizRef = db.collection(COLLECTIONS.businesses).doc(businessId);
  let pCount = 0, aCount = 0;
  for (const p of products) {
    await bizRef.collection(COLLECTIONS.products).doc(p.id).set({ ...p, businessId }, { merge: true });
    pCount++;
  }
  for (const a of aliases) {
    await bizRef.collection(COLLECTIONS.aliases).doc(a.id).set({ ...a, businessId }, { merge: true });
    aCount++;
  }

  // Verify counts after write.
  const [ps, as] = await Promise.all([
    bizRef.collection(COLLECTIONS.products).get(),
    bizRef.collection(COLLECTIONS.aliases).get(),
  ]);
  console.log(JSON.stringify({
    mode: "APPLIED", businessId,
    wroteProducts: pCount, wroteAliases: aCount,
    firestoreProductCount: ps.size, firestoreAliasCount: as.size,
  }, null, 2));
}

main().catch((e) => { console.error("seed failed:", e?.message || e); process.exit(1); });
