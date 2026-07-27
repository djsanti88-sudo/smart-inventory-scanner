// Import the RETAIL corpus (Open Food Facts) into a SEPARATE global collection `retailCatalogEntries`.
// This is NEVER mixed with tires (`catalogEntries`). High-value filter: keep only records that have a
// product name AND a brand. Streams retail_off.jsonl (no full load) and uses BulkWriter for 2.7M-scale
// throughput with built-in throttling + retries. Idempotent (merge by normalizedBarcode = doc id).
//
// Usage:
//   npx tsx scripts/import-retail-to-catalog.ts --dry-run
//   npx tsx scripts/import-retail-to-catalog.ts --sa C:\path\sa-key.json --apply
//   (--limit N, --all to drop the brand+name filter)

import { createReadStream, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { cleanScanCode, buildNormalizedCandidates } from "@/services/scanCleaner";
import type { Firestore, CollectionReference, BulkWriter, BulkWriterError } from "firebase-admin/firestore";
import type { ServiceAccount } from "firebase-admin/app";

const EXPECTED_PROJECT = "smart-inventory-scanner-app";
const COLLECTION = "retailCatalogEntries"; // SEPARATE from tires
const NOW = new Date().toISOString();
const argVal = (f: string): string | undefined => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : undefined; };
const hasFlag = (f: string) => process.argv.includes(f);
function die(m: string, c = 1): never { console.error("BLOCKER: " + m); process.exit(c); }

function normalizedKey(barcode: string): string {
  const clean = cleanScanCode(barcode).cleanCode;
  const cands = buildNormalizedCandidates(clean);
  return cands[cands.length - 1] ?? clean;
}

function first(s: string): string { return (s || "").split(",")[0].trim(); }

function recToEntry(r: Record<string, string>, namesNoBrand = false): Record<string, unknown> | null {
  const barcode = (r.code || "").trim();
  const name = (r.product_name || "").trim();
  const brand = first(r.brands || "");
  if (!barcode || !name) return null;               // always need a barcode + a usable product name
  // namesNoBrand pass: keep ONLY the records that have NO brand (the new ~1.38M); default: need a brand.
  if (namesNoBrand ? !!brand : !brand) return null;
  const nb = normalizedKey(barcode);
  if (!nb) return null;
  return {
    id: nb,
    barcode,
    normalizedBarcode: nb,
    name,
    brand,
    manufacturer: (r.brand_owner || "").trim(),
    category: first(r.categories_en || r.main_category_en || ""),
    size: (r.quantity || "").trim(),
    imageUrl: (r.image_url || "").trim(),
    countrySold: first(r.countries_en || ""), // OFF = countries sold in (not strict origin)
    source: "openfoodfacts",
    verificationStatus: "community",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

async function main() {
  const apply = hasFlag("--apply");
  const dryRun = hasFlag("--dry-run") || !apply;
  const namesNoBrand = hasFlag("--names-without-brand"); // 2nd pass: add the name-only (brand-less) records
  const limit = argVal("--limit") ? parseInt(argVal("--limit")!, 10) : 0;
  const path = resolve(argVal("--jsonl") || "data/retail-knowledge/retail_off.jsonl");

  let db: Firestore | null = null, col: CollectionReference | null = null, bulk: BulkWriter | null = null;
  if (apply) {
    let raw = "";
    const sa = argVal("--sa");
    if (sa) raw = readFileSync(sa, "utf8");
    else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) raw = readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8");
    if (!raw) die("service account key required for --apply (--sa <path>)", 2);
    const key = JSON.parse(raw) as Record<string, unknown>;
    if (typeof key.private_key === "string") key.private_key = (key.private_key as string).replace(/\\n/g, "\n");
    if (key.project_id !== EXPECTED_PROJECT) die(`service account project_id is not ${EXPECTED_PROJECT}`, 2);
    const { initializeApp, cert, getApps } = await import("firebase-admin/app");
    const { getFirestore } = await import("firebase-admin/firestore");
    if (!getApps().length) initializeApp({ credential: cert(key as unknown as ServiceAccount), projectId: EXPECTED_PROJECT });
    db = getFirestore();
    col = db.collection(COLLECTION);
    bulk = db.bulkWriter();
    bulk.onWriteError((err: BulkWriterError) => err.failedAttempts < 5); // retry up to 5x
  }

  console.log(`${dryRun ? "DRY-RUN" : "APPLY"} -> ${COLLECTION} | filter=${namesNoBrand ? "name-only(no brand)" : "name+brand"} | src=${path}`);
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  let scanned = 0, kept = 0, written = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    scanned++;
    let r: Record<string, string>;
    try { r = JSON.parse(line); } catch { continue; }
    const e = recToEntry(r, namesNoBrand);
    if (!e) continue;
    kept++;
    if (apply) {
      bulk!.set(col!.doc(e.id as string), e, { merge: true });
      written++;
      if (written % 50000 === 0) { await bulk!.flush(); console.log(`  scanned=${scanned} written=${written}`); }
    } else if (kept % 250000 === 0) {
      console.log(`  scanned=${scanned} kept=${kept}`);
    }
    if (limit && kept >= limit) break;
  }
  if (apply) {
    await bulk!.close();
    const total = await col!.count().get();
    console.log(JSON.stringify({ mode: "APPLIED", collection: COLLECTION, scanned, wrote: written, collectionTotalNow: total.data().count }, null, 2));
  } else {
    console.log(JSON.stringify({ mode: "DRY-RUN", scanned, highValueKept: kept }, null, 2));
  }
}
main().catch((e) => { console.error("import failed:", e?.message || e); process.exit(1); });
