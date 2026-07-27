// Import the tire barcode corpus into the GLOBAL `catalogEntries` collection (the app's shared
// background reference DB). This is NOT a business's inventory: catalog entries carry NO businessId
// and never appear in any shop's product list. Any shop scanning a tire barcode resolves its
// identity (brand/model/size) from here. Trusted tiers -> verified (resolve without AI);
// AI-sourced rows -> pending (suggestion / Needs Review).
//
// Usage:
//   npx tsx scripts/import-tires-to-catalog.ts --dry-run
//   npx tsx scripts/import-tires-to-catalog.ts --sa C:\path\sa-key.json --apply
//   (--csv <path>, --limit N)
//
// PRIVACY INVARIANT: only sanitized public fields (barcode/brand/model/size/source) are written.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanScanCode, buildNormalizedCandidates } from "@/services/scanCleaner";
import { COLLECTIONS } from "@/services/db/types";
import type { ServiceAccount } from "firebase-admin/app";

const EXPECTED_PROJECT = "smart-inventory-scanner-app";
const NOW = "2026-06-25T00:00:00.000Z";
const argVal = (f: string): string | undefined => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : undefined; };
const hasFlag = (f: string) => process.argv.includes(f);
function die(m: string, c = 1): never { console.error("BLOCKER: " + m); process.exit(c); }

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const header = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cells = line.split(","); const row: Record<string, string> = {};
    header.forEach((h, i) => { row[h] = (cells[i] ?? "").trim(); }); return row;
  });
}
const titleCase = (s: string) => (s || "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();

function normalizedKey(barcode: string): string {
  const clean = cleanScanCode(barcode).cleanCode;
  const cands = buildNormalizedCandidates(clean);
  return cands[cands.length - 1] ?? clean;
}

function rowToEntry(row: Record<string, string>): Record<string, unknown> | null {
  const barcode = (row["barcode"] || "").trim();
  if (!barcode) return null;
  const brand = titleCase(row["brand"] || "");
  const model = titleCase(row["model"] || "");
  const size = row["size_canonical"] || "";
  const load = row["load_index"] || "", speed = row["speed_rating"] || "";
  const ev = row["evidence_level"] || "";
  const trusted = ev !== "verified_ai";
  const nb = normalizedKey(barcode);
  const len = barcode.length;
  const verifiedBy = ev === "verified_db" ? "community" : trusted ? "trusted_source" : null;
  return {
    id: nb,
    barcode,
    normalizedBarcode: nb,
    barcodeType: len === 13 ? "ean13" : len === 14 ? "gtin14" : "upca",
    name: `${brand} ${model} ${size}`.replace(/\s+/g, " ").trim(),
    brand,
    description: `${brand} ${model} ${size} ${load}${speed}`.replace(/\s+/g, " ").trim(),
    category: "Tire",
    size: `${size} ${load}${speed}`.trim(),
    imageUrl: "",
    sourceUrls: [],
    evidenceSnippets: [],
    confidence: trusted ? 1 : 0.85,
    verificationStatus: trusted ? "verified" : "pending",
    verifiedBy,
    timesScanned: 0, timesConfirmed: 0, timesRejected: 0,
    firstSeenAt: NOW, lastSeenAt: NOW,
    aliases: [nb],
    conflictsWith: [],
    auditLog: [{ at: NOW, action: "created", by: "tire-corpus", note: `source:${ev}` }],
    autoVerified: false, autoVerifyReason: "",
    evidenceScore: trusted ? 90 : 60,
    sourceTier: ev === "verified_1src_strong" || ev === "verified_vendor" ? "strong_commercial" : ev === "verified_db" ? "supporting" : "weak",
    evidenceSummary: `Imported from tire corpus (${ev})`,
    blockingReasons: [],
    createdAt: NOW, updatedAt: NOW,
  };
}

async function main() {
  const apply = hasFlag("--apply");
  const dryRun = hasFlag("--dry-run") || !apply;
  const csvPath = resolve(argVal("--csv") || "data/tire-knowledge/tire_corpus_flat.csv");
  const limit = argVal("--limit") ? parseInt(argVal("--limit")!, 10) : 0;

  const rows = parseCsv(readFileSync(csvPath, "utf8"));
  const sliced = limit > 0 ? rows.slice(0, limit) : rows;
  let entries = sliced.map(rowToEntry).filter(Boolean) as Record<string, unknown>[];
  // de-dup by normalizedBarcode (doc id)
  const seen = new Set<string>();
  entries = entries.filter((e) => (seen.has(e.id as string) ? false : (seen.add(e.id as string), true)));
  const verified = entries.filter((e) => e.verificationStatus === "verified").length;

  if (dryRun) {
    console.log(JSON.stringify({
      mode: "DRY-RUN", collection: COLLECTIONS.catalogEntries, csv: csvPath,
      totalRows: rows.length, willImport: entries.length, verified, pendingAi: entries.length - verified,
      sample: entries.slice(0, 3).map((e) => ({ id: e.id, name: e.name, status: e.verificationStatus })),
    }, null, 2));
    console.log("DRY-RUN: no writes. Re-run with --apply --sa <key.json>.");
    return;
  }

  let raw: string | undefined;
  const saArg = argVal("--sa");
  if (saArg) raw = readFileSync(saArg, "utf8");
  else if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) raw = readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8");
  if (!raw) die("service account key required for --apply (--sa <path>)", 2);
  const sa = JSON.parse(raw) as Record<string, unknown>;
  if (typeof sa.private_key === "string") sa.private_key = (sa.private_key as string).replace(/\\n/g, "\n");
  if (sa.project_id !== EXPECTED_PROJECT) die(`service account project_id is not ${EXPECTED_PROJECT}`, 2);

  const { initializeApp, cert, getApps } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  if (!getApps().length) initializeApp({ credential: cert(sa as unknown as ServiceAccount), projectId: EXPECTED_PROJECT });
  const db = getFirestore();
  const col = db.collection(COLLECTIONS.catalogEntries);

  console.log(`APPLY -> GLOBAL ${COLLECTIONS.catalogEntries}: ${entries.length} entries (${verified} verified)`);
  const CHUNK = 450;
  let written = 0;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const batch = db.batch();
    for (const e of entries.slice(i, i + CHUNK)) batch.set(col.doc(e.id as string), e, { merge: true });
    await batch.commit();
    written += Math.min(CHUNK, entries.length - i);
    if (i % 4500 === 0 || written === entries.length) console.log(`  wrote ${written}/${entries.length}`);
  }
  const total = await col.count().get();
  console.log(JSON.stringify({ mode: "APPLIED", collection: COLLECTIONS.catalogEntries, wrote: written, catalogTotalNow: total.data().count }, null, 2));
}
main().catch((e) => { console.error("import failed:", e?.message || e); process.exit(1); });
