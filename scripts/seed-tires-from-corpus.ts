// Import the tire barcode corpus (data/tire-knowledge/tire_corpus_flat.csv) into a LIVE
// business's Firestore catalog as verified products + approved aliases, so the deterministic
// resolver matches scanned tire barcodes instantly. Batched writes (merge), idempotent.
//
// Usage:
//   npx tsx scripts/seed-tires-from-corpus.ts --ownerEmail djsanti88@gmail.com --dry-run
//   npx tsx scripts/seed-tires-from-corpus.ts --ownerEmail djsanti88@gmail.com --sa C:\path\sa-key.json --apply
//   (also: --businessId <id>, --csv <path>, --limit N)
//
// DRY-RUN needs NO credentials (parses CSV, prints the plan). --apply needs a service-account
// key for smart-inventory-scanner-app (--sa <path> | FIREBASE_SERVICE_ACCOUNT_JSON |
// FIREBASE_SERVICE_ACCOUNT_PATH | GOOGLE_APPLICATION_CREDENTIALS). Secrets are never printed.
//
// AI-sourced rows (evidence_level=verified_ai) are written as UNVERIFIED suggestions
// (verified=false / approved=false) so they go to Needs Review, never auto-count. All other
// tiers (verified_vendor / verified_db / verified_1src_strong) are verified + approved.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Alias, Product } from "@/types";
import { cleanScanCode, buildNormalizedCandidates } from "@/services/scanCleaner";
import { COLLECTIONS } from "@/services/db/types";

const EXPECTED_PROJECT = "smart-inventory-scanner-app";
const NOW = "2026-06-25T00:00:00.000Z";

const argVal = (f: string): string | undefined => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const hasFlag = (f: string) => process.argv.includes(f);
function die(msg: string, code = 1): never { console.error("BLOCKER: " + msg); process.exit(code); }

// ── CSV parse (header-based; corpus fields are normalized, no embedded commas) ──
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const header = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row: Record<string, string> = {};
    header.forEach((h, i) => { row[h] = (cells[i] ?? "").trim(); });
    return row;
  });
}

function titleCase(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

function rowToProductAndAlias(row: Record<string, string>, businessId: string): { product: Product; alias: Alias } | null {
  const barcode = (row["barcode"] || "").trim();
  if (!barcode) return null;
  const brand = titleCase(row["brand"] || "");
  const model = titleCase(row["model"] || "");
  const size = row["size_canonical"] || "";
  const load = row["load_index"] || "";
  const speed = row["speed_rating"] || "";
  const mpn = row["manufacturer_part_number"] || "";
  const ev = row["evidence_level"] || "";
  const trusted = ev !== "verified_ai"; // AI rows -> suggestion, never auto-count

  const len = barcode.length;
  const cleaned = cleanScanCode(barcode);
  const candidates = buildNormalizedCandidates(cleaned.cleanCode);
  const normalizedCode = candidates[candidates.length - 1] ?? cleaned.cleanCode;
  const pid = `tire-${barcode}`;

  const product: Product = {
    id: pid,
    businessId,
    name: `${brand} ${model} ${size}`.replace(/\s+/g, " ").trim(),
    brand,
    category: "Tire",
    specsShort: `${size} ${load}${speed}`.trim(),
    specsFull: `${brand} ${model} ${size} ${load}${speed}`.replace(/\s+/g, " ").trim(),
    primarySku: mpn,
    primaryBarcode: barcode,
    gtin: barcode,
    upc: len === 12 ? barcode : "",
    ean: len === 13 ? barcode : "",
    vendorCodes: [],
    aliases: [cleaned.cleanCode],
    imageUrl: "",
    productUrl: "",
    location: "",
    notes: `source:${ev}`,
    status: "active",
    source: "tire-corpus",
    confidence: trusted ? 1 : 0.85,
    verified: trusted,
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: "tire-corpus-import",
    updatedBy: "tire-corpus-import",
  } as Product;

  const alias: Alias = {
    id: `${pid}-a`,
    businessId,
    productId: pid,
    rawCodeExample: barcode,
    cleanCode: cleaned.cleanCode,
    normalizedCode,
    aliasType: "barcode",
    source: "tire-corpus",
    confidence: trusted ? 1 : 0.85,
    approved: trusted,
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: "tire-corpus-import",
    lastSeenAt: NOW,
    syncStatus: "synced",
    idempotencyKey: `corpus:${barcode}`,
  } as Alias;

  return { product, alias };
}

async function main() {
  const apply = hasFlag("--apply");
  const dryRun = hasFlag("--dry-run") || !apply;
  const csvPath = resolve(argVal("--csv") || "data/tire-knowledge/tire_corpus_flat.csv");
  const limit = argVal("--limit") ? parseInt(argVal("--limit")!, 10) : 0;

  const rows = parseCsv(readFileSync(csvPath, "utf8"));
  const sliced = limit > 0 ? rows.slice(0, limit) : rows;

  // Build (businessId filled after resolution; use placeholder for dry-run counts)
  let built = sliced.map((r) => rowToProductAndAlias(r, "PENDING")).filter(Boolean) as { product: Product; alias: Alias }[];
  // de-dup by barcode (corpus is already distinct, but be safe)
  const seen = new Set<string>();
  built = built.filter(({ product }) => (seen.has(product.primaryBarcode) ? false : (seen.add(product.primaryBarcode), true)));

  const verifiedCount = built.filter((b) => b.product.verified).length;
  const aiCount = built.length - verifiedCount;

  if (dryRun) {
    console.log(JSON.stringify({
      mode: "DRY-RUN", csv: csvPath, totalRows: rows.length, willImport: built.length,
      verifiedApproved: verifiedCount, aiSuggestionsNeedsReview: aiCount,
      sample: built.slice(0, 3).map((b) => ({ name: b.product.name, barcode: b.product.primaryBarcode, verified: b.product.verified })),
    }, null, 2));
    console.log("DRY-RUN: no writes. Re-run with --apply --sa <service-account.json> to write to production.");
    return;
  }

  // --apply: load service account + write
  const { initializeApp, cert, getApps } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  const { getAuth } = await import("firebase-admin/auth");

  let raw: string | undefined;
  const saArg = argVal("--sa");
  if (saArg) raw = readFileSync(saArg, "utf8");
  else if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) raw = readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8");
  else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) raw = readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8");
  if (!raw) die("service account key required for --apply (pass --sa <path>)", 2);
  const sa = JSON.parse(raw) as Record<string, unknown>;
  if (typeof sa.private_key === "string") sa.private_key = (sa.private_key as string).replace(/\\n/g, "\n");
  if (sa.project_id !== EXPECTED_PROJECT) die(`service account project_id is not ${EXPECTED_PROJECT}`, 2);

  if (!getApps().length) initializeApp({ credential: cert(sa as any), projectId: EXPECTED_PROJECT });
  const db = getFirestore();

  // Resolve business
  let businessId = argVal("--businessId");
  if (!businessId) {
    const email = argVal("--ownerEmail") || die("provide --businessId or --ownerEmail");
    const user = await getAuth().getUserByEmail(email).catch(() => die(`no Auth user for ${email}`));
    const memSnap = await db.collection(COLLECTIONS.businessMembers).where("userId", "==", user.uid).get();
    const ids = new Set<string>();
    memSnap.docs.forEach((d) => { const b = d.data().businessId; if (typeof b === "string" && b) ids.add(b); });
    const detId = `biz-${user.uid}`;
    if ((await db.collection(COLLECTIONS.businesses).doc(detId).get()).exists) ids.add(detId);
    const arr = [...ids];
    if (arr.length === 0) die(`no business for ${email}`);
    if (arr.length > 1) die(`multiple businesses for ${email}: ${arr.join(", ")} — pass --businessId`);
    businessId = arr[0];
  }
  console.log(`APPLY -> business ${businessId}: ${built.length} products + aliases`);

  const bizRef = db.collection(COLLECTIONS.businesses).doc(businessId);
  const CHUNK = 200; // 200 products + 200 aliases = 400 ops < 500/batch limit
  let written = 0;
  for (let i = 0; i < built.length; i += CHUNK) {
    const batch = db.batch();
    for (const { product, alias } of built.slice(i, i + CHUNK)) {
      batch.set(bizRef.collection(COLLECTIONS.products).doc(product.id), { ...product, businessId }, { merge: true });
      batch.set(bizRef.collection(COLLECTIONS.aliases).doc(alias.id), { ...alias, businessId }, { merge: true });
    }
    await batch.commit();
    written += Math.min(CHUNK, built.length - i);
    if (i % 2000 === 0 || written === built.length) console.log(`  wrote ${written}/${built.length}`);
  }

  const [ps, as] = await Promise.all([
    bizRef.collection(COLLECTIONS.products).get(),
    bizRef.collection(COLLECTIONS.aliases).get(),
  ]);
  console.log(JSON.stringify({ mode: "APPLIED", businessId, wrote: written, firestoreProducts: ps.size, firestoreAliases: as.size }, null, 2));
}

main().catch((e) => { console.error("import failed:", e?.message || e); process.exit(1); });
