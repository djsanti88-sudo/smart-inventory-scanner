#!/usr/bin/env node
// purge-decode-cache-examples.mjs - Standalone, OWNER-GATED maintenance tool to remove textbook GS1
// EXAMPLE / demo / test rows from the Turso `decode_cache` table AND the local .decode-cache.json file
// (QA round-2 SEAM 2, 2026-07-16). Mirrors scripts/purge-retail-turso-examples.mjs exactly.
//
// BACKGROUND: the persistent decode cache (Turso `decode_cache`, plus the repo-root .decode-cache.json
// file fallback) can hold a POISONED "result" entry - a textbook GS1 example barcode (4006381333931 ->
// "Test Shopidoo") or a scanner-misread GTIN cached earlier as a confident identity. QA round-2 SEAM 1
// already RE-VALIDATES a cached hit at read time (src/server/decode/pipeline.ts) so these never replay
// as an identity in production, TODAY, without needing this script. This script is a SEPARATE, optional
// maintenance operation to also clean the underlying stores, e.g. to shrink row count or before a fresh
// analytics query. It is NOT wired into CI, the build, or the runtime decode path in any way.
//
// SAFETY MODEL (mirrors scripts/purge-retail-turso-examples.mjs): default = READ-ONLY. Prints a COUNT +
// a sample of matching rows and exits WITHOUT deleting anything. Only with the explicit --apply flag
// does it run the scoped DELETE (and re-count afterward). NEVER auto-deletes; NEVER runs unattended.
// The DELETE targets EXACT primary keys only (never a broad WHERE / fuzzy prefix).
//
// Usage:
//   node scripts/purge-decode-cache-examples.mjs                 (preview: count + sample, no writes)
//   node scripts/purge-decode-cache-examples.mjs --apply          (actually delete the matched rows)
//   node scripts/purge-decode-cache-examples.mjs --sample 20       (show more/fewer sample rows)
//
// Requires env vars: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN (Turso pass). The local .decode-cache.json
// pass runs regardless (no creds needed) and is skipped gracefully when the file is absent.
// Or pass inline: TURSO_DATABASE_URL=libsql://... TURSO_AUTH_TOKEN=... node scripts/purge-decode-cache-examples.mjs

import { createClient } from "@libsql/client";
import fs from "node:fs";
import path from "node:path";

const URL = process.env.TURSO_DATABASE_URL || "libsql://inventory-djsanti88-sudo.aws-us-east-1.turso.io";
const TOKEN = process.env.TURSO_AUTH_TOKEN;

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const sampleFlagIdx = argv.indexOf("--sample");
const SAMPLE_SIZE = sampleFlagIdx !== -1 ? Number(argv[sampleFlagIdx + 1] || 10) : 10;

// EXACT-VALUE barcode blocklist (never a fuzzy prefix - could delete a real GTIN). Mirrors
// EXAMPLE_BARCODE_BLOCKLIST in src/services/ai/decode.ts and scripts/purge-retail-turso-examples.mjs.
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
// never a bare SQL LIKE for the final scope (LIKE over-matches real products e.g. "CAFFÉ TESTA").
const TEST_NAME_LIKE_PATTERNS = [
  "test", "fakeer", "fakewine", "fake wine", "dummy", "sample product", "placeholder", "brandtest", "shopidoo", "healthyholics",
];
// Mirrors TEST_NAME_PATTERN in src/services/ai/decode.ts exactly (whole-word, case-insensitive).
const TEST_NAME_PATTERN = /\b(test|fakeer|fake ?wine|dummy|sample product|placeholder|brandtest|shopidoo)\b/i;

// Zero-pad variants mirroring src/services/ai/decode.ts exampleBarcodeVariants, so the same normalized
// shapes the read-time guard checks are checked here against the blocklist.
function exampleBarcodeVariants(code) {
  const digits = (code || "").replace(/\D/g, "");
  if (!digits) return [];
  const stripped = digits.replace(/^0+/, "") || "0";
  const variants = new Set([digits, stripped]);
  for (const base of [digits, stripped]) {
    if (base.length <= 14) variants.add(base.padStart(14, "0"));
    if (base.length <= 13) variants.add(base.padStart(13, "0"));
    if (base.length <= 12) variants.add(base.padStart(12, "0"));
  }
  return [...variants];
}
function isDegenerateBarcodeShape(digits) {
  if (!digits) return false;
  if (/^0+$/.test(digits)) return true;
  if (/^(\d)\1+$/.test(digits)) return true;
  if (digits === "0123456789012" || digits === "1234567890128") return true;
  return false;
}
/** The SAME decision the app's isExampleOrTestRow makes (barcode blocklist/degenerate shape OR
 *  whole-word name/brand marker) - applied in JS. Checks BOTH the cache key/code AND the cached
 *  results[0] productName/brand parsed out of the payload. */
function isExampleOrTestRow(code, name, brand) {
  const digits = (code || "").replace(/\D/g, "");
  if (digits && isDegenerateBarcodeShape(digits)) return true;
  const variants = exampleBarcodeVariants(code || "");
  if (variants.some((v) => EXAMPLE_BARCODES.includes(v))) return true;
  if (name && TEST_NAME_PATTERN.test(name)) return true;
  if (brand && TEST_NAME_PATTERN.test(brand)) return true;
  return false;
}

/** Parse a decode_cache payload (JSON string) and pull results[0].productName / brand. Degrades to
 *  empty strings on a corrupt payload (never throws). */
function identityFromPayload(payload) {
  try {
    const parsed = JSON.parse(payload);
    const first = Array.isArray(parsed?.results) ? parsed.results[0] : null;
    return { name: first?.productName || "", brand: first?.brand || "" };
  } catch {
    return { name: "", brand: "" };
  }
}

// ---------------------------------------------------------------------------
// LOCAL FILE PASS: repo-root .decode-cache.json (object keyed by code; each value {code,kind,payload,...})
// ---------------------------------------------------------------------------
function purgeLocalFile() {
  const file = process.env.DECODE_CACHE_FILE || path.join(process.cwd(), ".decode-cache.json");
  if (!fs.existsSync(file)) {
    console.log(`[purge-decode-cache-examples] Local file ${file} absent - skipping local pass.`);
    return;
  }
  let store;
  try {
    store = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.log(`[purge-decode-cache-examples] Local file ${file} unreadable (${e.message}) - skipping local pass.`);
    return;
  }
  const keys = Object.keys(store || {});
  const matched = keys.filter((key) => {
    const entry = store[key] || {};
    const { name, brand } = identityFromPayload(entry.payload || "");
    // Match on the cache key OR the entry's own code OR the cached identity name/brand.
    return isExampleOrTestRow(key, name, brand) || isExampleOrTestRow(entry.code || "", name, brand);
  });
  console.log(`[purge-decode-cache-examples] Local .decode-cache.json entries before: ${keys.length}`);
  console.log(`[purge-decode-cache-examples] Local entries matching the example/test scope: ${matched.length}`);
  for (const key of matched.slice(0, SAMPLE_SIZE)) {
    const { name, brand } = identityFromPayload(store[key]?.payload || "");
    console.log(`  ${key} | ${name || "(no name)"} | brand=${brand || "(none)"}`);
  }
  if (!APPLY) {
    console.log("[purge-decode-cache-examples] Local pass PREVIEW ONLY - no entries removed.");
    return;
  }
  if (matched.length === 0) {
    console.log("[purge-decode-cache-examples] Local: nothing matched - nothing to remove.");
    return;
  }
  for (const key of matched) delete store[key];
  fs.writeFileSync(file, JSON.stringify(store), "utf8");
  console.log(`[purge-decode-cache-examples] Local: removed ${matched.length} entries. After: ${Object.keys(store).length}`);
}

// ---------------------------------------------------------------------------
// TURSO PASS: decode_cache (code TEXT PRIMARY KEY, kind, payload, tier)
// ---------------------------------------------------------------------------
async function purgeTurso() {
  if (!TOKEN) {
    console.log("[purge-decode-cache-examples] TURSO_AUTH_TOKEN not set - skipping Turso pass.");
    return;
  }
  const client = createClient({ url: URL, authToken: TOKEN });
  console.log("[purge-decode-cache-examples] Connecting to Turso decode_cache...");

  const before = await client.execute("SELECT COUNT(*) as c FROM decode_cache");
  console.log(`[purge-decode-cache-examples] Total rows in 'decode_cache' before: ${before.rows[0].c}`);

  // Fetch CANDIDATES broadly: exact-barcode blocklist on the code key OR a loose LIKE on the payload
  // (which embeds the productName/brand). This is only a superset fetch to limit what Turso sends back;
  // the actual match decision is isExampleOrTestRow() applied in JS below (never a bare SQL LIKE).
  const barcodePlaceholders = EXAMPLE_BARCODES.map(() => "?").join(", ");
  const likeClauses = TEST_NAME_LIKE_PATTERNS.map(() => "payload LIKE ?").join(" OR ");
  const likeArgs = TEST_NAME_LIKE_PATTERNS.map((p) => `%${p}%`);
  const candidateSql = `
    SELECT code, kind, payload, tier FROM decode_cache
    WHERE code IN (${barcodePlaceholders}) OR (${likeClauses})
  `;
  const candidates = await client.execute({ sql: candidateSql, args: [...EXAMPLE_BARCODES, ...likeArgs] });

  const matched = candidates.rows.filter((row) => {
    const { name, brand } = identityFromPayload(String(row.payload || ""));
    return isExampleOrTestRow(String(row.code || ""), name, brand);
  });
  console.log(`[purge-decode-cache-examples] Candidate rows fetched (broad LIKE, pre-filter): ${candidates.rows.length}`);
  console.log(`[purge-decode-cache-examples] Rows matching the PRECISE whole-word example/test scope: ${matched.length}`);

  console.log(`[purge-decode-cache-examples] Sample (up to ${SAMPLE_SIZE} rows):`);
  for (const row of matched.slice(0, SAMPLE_SIZE)) {
    const { name, brand } = identityFromPayload(String(row.payload || ""));
    console.log(`  ${row.code} | ${name || "(no name)"} | brand=${brand || "(none)"} | kind=${row.kind}`);
  }

  if (!APPLY) {
    console.log("\n[purge-decode-cache-examples] Turso PREVIEW ONLY - no rows were deleted.");
    console.log("[purge-decode-cache-examples] Re-run with --apply to actually delete the matched rows.");
    client.close();
    return;
  }

  if (matched.length === 0) {
    console.log("\n[purge-decode-cache-examples] Turso: nothing matched - nothing to delete.");
    client.close();
    return;
  }

  console.log(`\n[purge-decode-cache-examples] --apply given: deleting ${matched.length} exact matched codes...`);
  // Delete by EXACT code (primary key) list only - the precise JS-side filter decided the scope.
  const BATCH = 100;
  let deleted = 0;
  for (let i = 0; i < matched.length; i += BATCH) {
    const batch = matched.slice(i, i + BATCH);
    const placeholders = batch.map(() => "?").join(", ");
    const res = await client.execute({
      sql: `DELETE FROM decode_cache WHERE code IN (${placeholders})`,
      args: batch.map((r) => r.code),
    });
    deleted += res.rowsAffected ?? batch.length;
  }
  console.log(`[purge-decode-cache-examples] Deleted ${deleted} rows.`);

  const after = await client.execute("SELECT COUNT(*) as c FROM decode_cache");
  console.log(`[purge-decode-cache-examples] Total rows in 'decode_cache' after: ${after.rows[0].c}`);

  client.close();
}

async function main() {
  console.log("[purge-decode-cache-examples] Mode:", APPLY ? "APPLY (will delete)" : "PREVIEW (read-only, no writes)");
  purgeLocalFile();
  await purgeTurso();
}

main().catch((e) => {
  console.error("[purge-decode-cache-examples] Error:", e);
  process.exit(1);
});
