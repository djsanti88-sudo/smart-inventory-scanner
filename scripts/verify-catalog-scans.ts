// Post-deploy proof: pick N random barcodes from the corpus and resolve each against the LIVE
// global catalog EXACTLY as the app's scan resolver does — catalogRepository.getByBarcode():
//   query(catalogEntries where normalizedBarcode == <normalized scan>)
// Confirm (a) it resolves from the database, (b) status is "verified" (resolves WITHOUT AI),
// and (c) the identity (brand/size) matches the corpus.
//
// Usage: npx tsx scripts/verify-catalog-scans.ts --sa C:\path\sa-key.json --n 100

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanScanCode, buildNormalizedCandidates } from "@/services/scanCleaner";
import { COLLECTIONS } from "@/services/db/types";
import type { ServiceAccount } from "firebase-admin/app";

const EXPECTED_PROJECT = "smart-inventory-scanner-app";
const argVal = (f: string): string | undefined => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : undefined; };
function die(m: string, c = 1): never { console.error("BLOCKER: " + m); process.exit(c); }
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const header = lines[0].split(",");
  return lines.slice(1).map((line) => { const cells = line.split(","); const r: Record<string, string> = {}; header.forEach((h, i) => { r[h] = (cells[i] ?? "").trim(); }); return r; });
}
const norm = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
function normalizedKey(barcode: string): string {
  const clean = cleanScanCode(barcode).cleanCode;
  const c = buildNormalizedCandidates(clean);
  return c[c.length - 1] ?? clean;
}

async function main() {
  const n = argVal("--n") ? parseInt(argVal("--n")!, 10) : 100;
  const csvPath = resolve(argVal("--csv") || "data/tire-knowledge/tire_corpus_flat.csv");
  const rows = parseCsv(readFileSync(csvPath, "utf8")).filter((r) => r["barcode"]);
  const idx = new Set<number>();
  while (idx.size < Math.min(n, rows.length)) idx.add(Math.floor(Math.random() * rows.length));
  const sample = [...idx].map((i) => rows[i]);

  let raw: string | undefined;
  const saArg = argVal("--sa");
  if (saArg) raw = readFileSync(saArg, "utf8");
  else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) raw = readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8");
  if (!raw) die("service account key required (--sa <path>)", 2);
  const sa = JSON.parse(raw) as Record<string, unknown>;
  if (typeof sa.private_key === "string") sa.private_key = (sa.private_key as string).replace(/\\n/g, "\n");
  if (sa.project_id !== EXPECTED_PROJECT) die("wrong project", 2);

  const { initializeApp, cert, getApps } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  if (!getApps().length) initializeApp({ credential: cert(sa as unknown as ServiceAccount), projectId: EXPECTED_PROJECT });
  const db = getFirestore();
  const col = db.collection(COLLECTIONS.catalogEntries);
  console.log(`Verifying ${sample.length} random scans against LIVE global catalog...\n`);

  let resolved = 0, verified = 0, correct = 0;
  const fails: string[] = [];
  for (const r of sample) {
    const barcode = r["barcode"];
    const nb = normalizedKey(barcode);
    // EXACT app lookup:
    const snap = await col.where("normalizedBarcode", "==", nb).limit(1).get();
    if (snap.empty) { fails.push(`${barcode}: NOT FOUND in catalog`); continue; }
    resolved++;
    const e = snap.docs[0].data();
    if (e.verificationStatus === "verified") verified++;
    const okBrand = norm(e.brand).includes(norm(r["brand"])) || norm(r["brand"]).includes(norm(e.brand));
    const okSize = norm(String(e.size)).includes(norm(r["size_canonical"]));
    const okBarcode = e.barcode === barcode;
    if (okBrand && okSize && okBarcode) correct++;
    else fails.push(`${barcode}: mismatch live="${e.name}" (${e.size}) vs corpus="${r["brand"]} ${r["model"]} ${r["size_canonical"]}"`);
  }
  console.log(JSON.stringify({ sampled: sample.length, resolved_from_DB: resolved, status_verified: verified, identity_correct: correct, failures: fails.length }, null, 2));
  if (fails.length) { console.log("\n-- failures (first 12) --"); fails.slice(0, 12).forEach((f) => console.log("  " + f)); }
  console.log(`\nRESULT: ${correct}/${sample.length} scans resolved correctly from the live global catalog.`);
}
main().catch((e) => { console.error("verify failed:", e?.message || e); process.exit(1); });
