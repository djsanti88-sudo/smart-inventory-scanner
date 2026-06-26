// Behavior test: run 20 scans through the REAL resolver (processScan) with the cloud global-catalog
// lookup pointed at the LIVE catalogEntries, and observe each outcome. Read-only on the cloud.
// Usage: npx tsx scripts/test-20-scans.ts --sa C:\path\sa-key.json

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";
import { sanitizeCatalogEntry } from "@/services/catalog/sanitizeCatalog";
import { cleanScanCode, buildNormalizedCandidates } from "@/services/scanCleaner";
import { COLLECTIONS } from "@/services/db/types";

const argVal = (f: string) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : undefined; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function parseCsv(t: string) { const L = t.split(/\r?\n/).filter(Boolean); const h = L[0].split(","); return L.slice(1).map((ln) => { const c = ln.split(","); const o: Record<string, string> = {}; h.forEach((k, i) => (o[k] = (c[i] ?? "").trim())); return o; }); }

async function main() {
  const saPath = argVal("--sa")!;
  const sa = JSON.parse(readFileSync(saPath, "utf8")) as Record<string, unknown>;
  if (typeof sa.private_key === "string") sa.private_key = (sa.private_key as string).replace(/\\n/g, "\n");
  const { initializeApp, cert, getApps } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  if (!getApps().length) initializeApp({ credential: cert(sa as any), projectId: "smart-inventory-scanner-app" });
  const adb = getFirestore();

  // Real cloud lookup (admin-backed), mapped exactly like the production dep.
  const lookupGlobalCatalog = async (codes: string[]) => {
    for (const code of codes) {
      const snap = await adb.collection(COLLECTIONS.catalogEntries).where("normalizedBarcode", "==", code).limit(1).get();
      if (!snap.empty) {
        const d = snap.docs[0].data();
        return sanitizeCatalogEntry(
          { barcode: d.barcode, normalizedBarcode: d.normalizedBarcode, name: d.name, brand: d.brand, category: d.category, size: d.size, confidence: d.confidence ?? 1 },
          { now: "2026-06-25T00:00:00.000Z", verificationStatus: d.verificationStatus ?? "verified", verifiedBy: d.verifiedBy ?? "trusted_source", by: "trusted_source" },
        );
      }
    }
    return null;
  };

  const rows = parseCsv(readFileSync(resolve("data/tire-knowledge/tire_corpus_flat.csv"), "utf8")).filter((r) => r.barcode);
  const pick = (n: number) => { const s = new Set<number>(); while (s.size < n) s.add(Math.floor(Math.random() * rows.length)); return [...s].map((i) => rows[i]); };
  const catalogTires = pick(17);

  const store = createTestScanStore({ db: new MockDb(), cloudBackend: false, lookupGlobalCatalog });
  store.setState({ online: true });

  // Seed ONE shop-owned product+alias so we can prove ownership wins over the cloud.
  const ownedBarcode = "999100100107"; // not in the corpus
  store.setState((s: any) => ({
    products: [...s.products, { id: "owned-1", businessId: s.businessId, name: "MY HOUSE TIRE 200/50R16", brand: "House", category: "Tire", primaryBarcode: ownedBarcode, verified: true, aliases: [ownedBarcode], status: "active", source: "seed", confidence: 1, createdAt: "x", updatedAt: "x" }],
    aliases: [...s.aliases, { id: "owned-a", businessId: s.businessId, productId: "owned-1", cleanCode: ownedBarcode, normalizedCode: ownedBarcode, aliasType: "barcode", approved: true, confidence: 1, source: "seed", createdAt: "x", updatedAt: "x", lastSeenAt: "x", syncStatus: "synced", idempotencyKey: "k" }],
  }));

  const cases: { label: string; code: string; expect: string }[] = [
    ...catalogTires.map((r) => ({ label: `catalog:${r.brand}`, code: r.barcode, expect: "found_from_catalog" })),
    { label: "shop-owned", code: ownedBarcode, expect: "count into shop product" },
    { label: "unknown", code: "977777777775", expect: "needs_review (no AI)" },
    { label: "unknown2", code: "966666666668", expect: "needs_review (no AI)" },
  ];

  console.log(`Running ${cases.length} scans through the real resolver...\n`);
  let foundCatalog = 0, owned = 0, review = 0, other = 0;
  for (const c of cases) {
    store.getState().processScan(c.code);
    await sleep(400); // let async cloud lookup settle
    const st = store.getState();
    const feed = st.scanFeed.find((e: any) => e.cleanCode === cleanScanCode(c.code).cleanCode);
    const fb = st.feedbackEvents.filter((e: any) => e.code === cleanScanCode(c.code).cleanCode).map((e: any) => e.type);
    const counted = st.finalCounts.reduce((a: number, x: any) => a + (x.quantity || 0), 0);
    let outcome = "other";
    if (fb.includes("found_from_catalog")) { outcome = "found_from_catalog"; foundCatalog++; }
    else if (feed?.matchedProductId === "owned-1") { outcome = "shop_product"; owned++; }
    else if (feed?.status === "needs_review") { outcome = "needs_review"; review++; }
    else other++;
    console.log(`  ${c.label.padEnd(22)} ${c.code.padEnd(14)} -> ${outcome.padEnd(18)} (status=${feed?.status})`);
  }
  console.log(`\nSUMMARY: found_from_catalog=${foundCatalog} shop_product=${owned} needs_review=${review} other=${other}`);
  console.log(`Expected: ~17 found_from_catalog, 1 shop_product, 2 needs_review.`);
  process.exit(0);
}
main().catch((e) => { console.error(e?.message || e); process.exit(1); });
