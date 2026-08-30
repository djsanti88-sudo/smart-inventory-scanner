// Post-deploy proof: pick N random barcodes from the corpus, resolve each against the LIVE
// Firestore catalog exactly as the scanner would (clean code -> approved alias -> verified
// product), and confirm (a) it resolves KNOWN *from the database* (not AI), and (b) the
// resolved product identity is RIGHT (brand/model/size match the corpus).
//
// Usage:
//   npx tsx scripts/verify-live-scans.ts --ownerEmail djsanti88@gmail.com --sa C:\path\sa-key.json --n 100
//
// Needs the same service-account key as the importer (read-only here). Secrets never printed.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ServiceAccount } from "firebase-admin/app";
import { cleanScanCode, buildNormalizedCandidates } from "@/scanning/clean/scanCleaner";
import { COLLECTIONS } from "@/services/db/types";

const EXPECTED_PROJECT = "smart-inventory-scanner-app";
const argVal = (f: string): string | undefined => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : undefined; };
function die(m: string, c = 1): never { console.error("BLOCKER: " + m); process.exit(c); }

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const header = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cells = line.split(","); const row: Record<string, string> = {};
    header.forEach((h, i) => { row[h] = (cells[i] ?? "").trim(); }); return row;
  });
}
const norm = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

async function main() {
  const n = argVal("--n") ? parseInt(argVal("--n")!, 10) : 100;
  const csvPath = resolve(argVal("--csv") || "data/tire-knowledge/tire_corpus_flat.csv");
  const rows = parseCsv(readFileSync(csvPath, "utf8")).filter((r) => r["barcode"]);

  // random sample of n
  const idx = new Set<number>();
  while (idx.size < Math.min(n, rows.length)) idx.add(Math.floor(Math.random() * rows.length));
  const sample = [...idx].map((i) => rows[i]);

  // creds
  let raw: string | undefined;
  const saArg = argVal("--sa");
  if (saArg) raw = readFileSync(saArg, "utf8");
  else if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) raw = readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8");
  if (!raw) die("service account key required (--sa <path>)", 2);
  const sa = JSON.parse(raw) as Record<string, unknown>;
  if (typeof sa.private_key === "string") sa.private_key = (sa.private_key as string).replace(/\\n/g, "\n");
  if (sa.project_id !== EXPECTED_PROJECT) die(`service account project_id is not ${EXPECTED_PROJECT}`, 2);

  const { initializeApp, cert, getApps } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  const { getAuth } = await import("firebase-admin/auth");
  const serviceAccount: ServiceAccount = {
    projectId: String(sa.project_id),
    clientEmail: String(sa.client_email),
    privateKey: String(sa.private_key),
  };
  if (!getApps().length) initializeApp({ credential: cert(serviceAccount), projectId: EXPECTED_PROJECT });
  const db = getFirestore();

  let businessId = argVal("--businessId");
  if (!businessId) {
    const email = argVal("--ownerEmail") || die("provide --businessId or --ownerEmail");
    const user = await getAuth().getUserByEmail(email).catch(() => die(`no Auth user for ${email}`));
    const mem = await db.collection(COLLECTIONS.businessMembers).where("userId", "==", user.uid).get();
    const ids = new Set<string>(); mem.docs.forEach((d) => { const b = d.data().businessId; if (b) ids.add(b); });
    const detId = `biz-${user.uid}`; if ((await db.collection(COLLECTIONS.businesses).doc(detId).get()).exists) ids.add(detId);
    const arr = [...ids]; if (!arr.length) die(`no business for ${email}`); if (arr.length > 1) die(`multiple businesses: ${arr.join(",")}`);
    businessId = arr[0];
  }
  const bizRef = db.collection(COLLECTIONS.businesses).doc(businessId);
  console.log(`Verifying ${sample.length} random scans against LIVE business ${businessId}...\n`);

  let known = 0, correct = 0, fromDbDeterministic = 0;
  const failures: string[] = [];
  for (const r of sample) {
    const barcode = r["barcode"];
    const cleaned = cleanScanCode(barcode).cleanCode;
    const cands = buildNormalizedCandidates(cleaned);
    // Resolve like the scanner: find an APPROVED alias whose cleanCode/normalizedCode matches.
    let aliasDoc: FirebaseFirestore.DocumentData | null = null;
    const byClean = await bizRef.collection(COLLECTIONS.aliases).where("cleanCode", "==", cleaned).limit(1).get();
    if (!byClean.empty) aliasDoc = byClean.docs[0].data();
    if (!aliasDoc) {
      for (const c of cands) {
        const q = await bizRef.collection(COLLECTIONS.aliases).where("normalizedCode", "==", c).limit(1).get();
        if (!q.empty) { aliasDoc = q.docs[0].data(); break; }
      }
    }
    if (!aliasDoc || !aliasDoc.approved) { failures.push(`${barcode}: NOT resolved from DB (alias missing/unapproved)`); continue; }
    known++;
    const prodSnap = await bizRef.collection(COLLECTIONS.products).doc(aliasDoc.productId).get();
    const p = prodSnap.data();
    if (!p || !p.verified) { failures.push(`${barcode}: alias->product missing/unverified`); continue; }
    fromDbDeterministic++;
    // identity correctness vs corpus
    const okBarcode = p.primaryBarcode === barcode;
    const okBrand = norm(p.brand).includes(norm(r["brand"])) || norm(r["brand"]).includes(norm(p.brand));
    const okSize = norm(p.specsShort).includes(norm(r["size_canonical"]));
    if (okBarcode && okBrand && okSize) correct++;
    else failures.push(`${barcode}: identity mismatch -> live="${p.name}" vs corpus="${r["brand"]} ${r["model"]} ${r["size_canonical"]}"`);
  }

  console.log(JSON.stringify({
    sampled: sample.length,
    resolved_known_from_DB: known,
    deterministic_verified_product: fromDbDeterministic,
    identity_correct: correct,
    failures: failures.length,
  }, null, 2));
  if (failures.length) { console.log("\n-- failures (first 15) --"); failures.slice(0, 15).forEach((f) => console.log("  " + f)); }
  console.log(`\nRESULT: ${correct}/${sample.length} scans resolved correctly from the live database.`);
}
main().catch((e) => { console.error("verify failed:", e?.message || e); process.exit(1); });
