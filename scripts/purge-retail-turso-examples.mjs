#!/usr/bin/env node
// purge-retail-turso-examples.mjs — Standalone, OWNER-GATED maintenance tool to remove textbook GS1
// EXAMPLE / demo / test rows from the Turso `retail` table (QA hardening fix #5, 2026-07-16).
//
// BACKGROUND: the crowdsourced Open Food Facts retail corpus contains literal GS1 example barcodes
// and demo/placeholder rows contributed by testers (4006381333931 -> "Test Shopidoo",
// 5901234123457 -> "Sauce chiltepin"/"La lumbre", 0012345670121/0012345674020/0012345674037 -> brand
// "Healthyholics", plus rows literally named "Test"/"Fakeer"/"Fakewine"/"BrandTest"). The READ-TIME
// guard (src/decoding/decode.ts isExampleOrTestRow, wired into src/server/decode/pipeline.ts and
// src/server/retail-knowledge/retailKnowledgeIndex.ts) already stops these from ever being surfaced as
// a confident match, in production, TODAY, without needing this script. This script is a SEPARATE,
// optional maintenance operation to also clean the underlying Turso store, e.g. before a fresh
// analytics query over the `retail` table, or to shrink row count. It is NOT wired into CI, the build,
// or the runtime decode path in any way.
//
// SAFETY MODEL (mirrors scripts/corpus-purge.mjs): default = READ-ONLY. Prints a COUNT + a sample of
// matching rows and exits WITHOUT deleting anything. Only with the explicit --apply flag does it run
// the scoped DELETE (and re-count afterward). NEVER auto-deletes; NEVER runs unattended.
//
// Usage:
//   node scripts/purge-retail-turso-examples.mjs                 (preview: count + sample, no writes)
//   node scripts/purge-retail-turso-examples.mjs --apply          (actually delete the matched rows)
//   node scripts/purge-retail-turso-examples.mjs --sample 20       (show more/fewer sample rows)
//
// Requires env vars: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN
// Or pass inline: TURSO_DATABASE_URL=libsql://... TURSO_AUTH_TOKEN=... node scripts/purge-retail-turso-examples.mjs

import { createClient } from "@libsql/client";

const URL = process.env.TURSO_DATABASE_URL || "libsql://inventory-retail-djsanti88-sudo.aws-us-east-1.turso.io";
const TOKEN = process.env.TURSO_AUTH_TOKEN;
if (!TOKEN) { console.error("Set TURSO_AUTH_TOKEN"); process.exit(1); }

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const sampleFlagIdx = argv.indexOf("--sample");
const SAMPLE_SIZE = sampleFlagIdx !== -1 ? Number(argv[sampleFlagIdx + 1] || 10) : 10;

// EXACT-VALUE barcode blocklist (never a fuzzy prefix — could delete a real GTIN). Mirrors
// EXAMPLE_BARCODE_BLOCKLIST in src/decoding/decode.ts and scripts/build-retail-knowledge.mjs.
const EXAMPLE_BARCODES = [
  "012345678905",
  "4006381333931",
  "5901234123457",
  "0012345670121",
  "0012345674020",
  "0012345674037",
];

// Whole-word test/demo name/brand markers. SQLite has no portable regex word-boundary in plain SQL, so
// this fetches CANDIDATE rows with a broad LIKE '%marker%' first, then applies the SAME whole-word
// regex the app uses (isExampleOrTestRow's TEST_NAME_PATTERN) IN JAVASCRIPT before counting/deleting -
// never a bare SQL LIKE for the final scope. This matters: a naive LIKE '%test%' over-matches real
// products (observed live: "CAFFÉ TESTA", "Testoros del Sur" wine, "Wattestäbchen" cotton swabs,
// Slovenian "testenine" = pasta) - LIKE is only used to shrink the candidate set Turso has to send back,
// never as the actual match decision.
const TEST_NAME_LIKE_PATTERNS = [
  "test", "fakeer", "fakewine", "fake wine", "dummy", "sample product", "placeholder", "brandtest", "shopidoo",
];
// Mirrors TEST_NAME_PATTERN in src/decoding/decode.ts exactly (whole-word, case-insensitive).
const TEST_NAME_PATTERN = /\b(test|fakeer|fake ?wine|dummy|sample product|placeholder|brandtest|shopidoo)\b/i;
function isDegenerateBarcodeShape(digits) {
  if (!digits) return false;
  if (/^0+$/.test(digits)) return true;
  if (/^(\d)\1+$/.test(digits)) return true;
  if (digits === "0123456789012" || digits === "1234567890128") return true;
  return false;
}
/** The SAME decision the app's isExampleOrTestRow makes (barcode blocklist/degenerate shape OR
 *  whole-word name/brand marker) - applied in JS against a row already fetched from Turso. */
function isExampleOrTestRow(barcode, name, brand) {
  const digits = (barcode || "").replace(/\D/g, "");
  if (digits && isDegenerateBarcodeShape(digits)) return true;
  if (EXAMPLE_BARCODES.includes(barcode)) return true;
  if (name && TEST_NAME_PATTERN.test(name)) return true;
  if (brand && TEST_NAME_PATTERN.test(brand)) return true;
  return false;
}

async function main() {
  const client = createClient({ url: URL, authToken: TOKEN });

  console.log("[purge-retail-turso-examples] Mode:", APPLY ? "APPLY (will delete)" : "PREVIEW (read-only, no writes)");
  console.log("[purge-retail-turso-examples] Connecting to Turso...");

  const before = await client.execute("SELECT COUNT(*) as c FROM retail");
  console.log(`[purge-retail-turso-examples] Total rows in 'retail' before: ${before.rows[0].c}`);

  // Fetch CANDIDATES broadly (exact-barcode blocklist OR a loose LIKE on name/brand) - this is only a
  // superset fetch to limit what Turso sends back. The actual match decision is isExampleOrTestRow()
  // applied in JS below, which mirrors the app's whole-word regex exactly (never a bare SQL LIKE).
  const barcodePlaceholders = EXAMPLE_BARCODES.map(() => "?").join(", ");
  const likeClauses = TEST_NAME_LIKE_PATTERNS.map(() => "(product_name LIKE ? OR brand LIKE ?)").join(" OR ");
  const likeArgs = TEST_NAME_LIKE_PATTERNS.flatMap((p) => [`%${p}%`, `%${p}%`]);
  const candidateSql = `
    SELECT barcode, product_name, brand, category FROM retail
    WHERE barcode IN (${barcodePlaceholders}) OR (${likeClauses})
  `;
  const candidates = await client.execute({ sql: candidateSql, args: [...EXAMPLE_BARCODES, ...likeArgs] });

  const matched = candidates.rows.filter((row) => isExampleOrTestRow(row.barcode, row.product_name, row.brand));
  console.log(`[purge-retail-turso-examples] Candidate rows fetched (broad LIKE, pre-filter): ${candidates.rows.length}`);
  console.log(`[purge-retail-turso-examples] Rows matching the PRECISE whole-word example/test-row scope: ${matched.length}`);

  console.log(`[purge-retail-turso-examples] Sample (up to ${SAMPLE_SIZE} rows):`);
  for (const row of matched.slice(0, SAMPLE_SIZE)) {
    console.log(`  ${row.barcode} | ${row.product_name} | brand=${row.brand || "(none)"} | category=${row.category || "(none)"}`);
  }

  if (!APPLY) {
    console.log("\n[purge-retail-turso-examples] PREVIEW ONLY — no rows were deleted.");
    console.log("[purge-retail-turso-examples] Re-run with --apply to actually delete the matched rows.");
    client.close();
    return;
  }

  if (matched.length === 0) {
    console.log("\n[purge-retail-turso-examples] Nothing matched — nothing to delete.");
    client.close();
    return;
  }

  console.log(`\n[purge-retail-turso-examples] --apply given: deleting ${matched.length} exact matched barcodes...`);
  // Delete by EXACT barcode list only (never a broad WHERE) - the precise JS-side filter decided the
  // scope; the DELETE statement just targets those exact primary keys, batched to stay under limits.
  const BATCH = 100;
  let deleted = 0;
  for (let i = 0; i < matched.length; i += BATCH) {
    const batch = matched.slice(i, i + BATCH);
    const placeholders = batch.map(() => "?").join(", ");
    const res = await client.execute({
      sql: `DELETE FROM retail WHERE barcode IN (${placeholders})`,
      args: batch.map((r) => r.barcode),
    });
    deleted += res.rowsAffected ?? batch.length;
  }
  console.log(`[purge-retail-turso-examples] Deleted ${deleted} rows.`);

  const after = await client.execute("SELECT COUNT(*) as c FROM retail");
  console.log(`[purge-retail-turso-examples] Total rows in 'retail' after: ${after.rows[0].c}`);

  client.close();
}

main().catch((e) => {
  console.error("[purge-retail-turso-examples] Error:", e);
  process.exit(1);
});
