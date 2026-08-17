#!/usr/bin/env node
// import-retail-turso.mjs — Bulk import retail products into Turso from the local JSON.
// Usage: node --max-old-space-size=4096 scripts/import-retail-turso.mjs
//
// Requires env vars: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN
// Or pass inline: TURSO_DATABASE_URL=libsql://... TURSO_AUTH_TOKEN=... node scripts/import-retail-turso.mjs

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { decideRetailImportAction } from "./retailImportGuard.mjs";

const URL = process.env.TURSO_DATABASE_URL || "libsql://inventory-retail-djsanti88-sudo.aws-us-east-1.turso.io";
const TOKEN = process.env.TURSO_AUTH_TOKEN;
if (!TOKEN) { console.error("Set TURSO_AUTH_TOKEN"); process.exit(1); }

const BATCH_SIZE = 200; // Turso batch limit per request
const JSON_PATH = join(process.cwd(), "src", "server", "retail-knowledge", "retailKnowledge.generated.json");
// Pre-drop sanity guard (mirrors scripts/build-tire-knowledge.mjs's MIN_RETAINED_FRACTION output-sanity
// guard, F1 2026-08-12; logic in scripts/retailImportGuard.mjs). --force here DROPs the LIVE Turso retail
// table (~4.13M rows in production) and reimports from the local JSON. A stale or truncated local file
// would otherwise silently destroy the production corpus while reporting success. Refuse to drop when
// the local source would replace the live table with materially fewer rows, unless --force-shrink is
// ALSO passed for a deliberate replacement.
const FORCE_SHRINK = process.argv.includes("--force-shrink");

console.log("[turso-import] Reading retail JSON...");
const t0 = performance.now();
const data = JSON.parse(readFileSync(JSON_PATH, "utf8"));
const entries = Object.entries(data.index || {});
console.log(`[turso-import] ${entries.length} entries loaded in ${((performance.now() - t0) / 1000).toFixed(1)}s`);

const client = createClient({ url: URL, authToken: TOKEN });

// Create table + index if not exists
await client.execute("CREATE TABLE IF NOT EXISTS retail (barcode TEXT PRIMARY KEY, product_name TEXT NOT NULL, brand TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '')");

// Check existing count
const existing = await client.execute("SELECT COUNT(*) as c FROM retail");
const existingCount = existing.rows[0].c;
console.log(`[turso-import] Existing rows in Turso: ${existingCount}`);

// OUTPUT-SANITY GUARD (mirrors build-tire-knowledge.mjs's F1 guard; decision logic + this wiring
// unit-tested Turso-free in scripts/retailImportGuard.wiring.test.mjs, DT2-4 2026-08-13). The ONLY
// call site that drops the live table below is reached exclusively through decision.action ===
// "drop" - every other outcome (proceed without dropping, skip entirely, or refuse) leaves the
// live table untouched. A shrink this large usually means the local retailKnowledge.generated.json
// is stale, partial, or was produced by a build-retail-knowledge.mjs run against a truncated input
// file - refuse to destroy the live corpus on that basis alone.
const decision = decideRetailImportAction({
  existingCount,
  localEntryCount: entries.length,
  force: process.argv.includes("--force"),
  forceShrink: FORCE_SHRINK,
});

if (decision.action === "skip") {
  console.log("[turso-import] Already imported (>3M rows). Skipping. Use --force to reimport.");
  client.close();
  process.exit(0);
}
if (decision.action === "refuse") {
  console.error(`[turso-import] REFUSING to drop: ${decision.reason}`);
  client.close();
  process.exit(1);
}
if (decision.action === "drop") {
  console.log("[turso-import] --force: dropping and recreating table...");
  await client.execute("DROP TABLE retail");
  await client.execute("CREATE TABLE retail (barcode TEXT PRIMARY KEY, product_name TEXT NOT NULL, brand TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '')");
}
// decision.action === "proceed": existing table is small (nothing to protect); fall through to the
// import loop below without dropping anything.

console.log(`[turso-import] Importing ${entries.length} rows in batches of ${BATCH_SIZE}...`);
const t1 = performance.now();
let imported = 0;
let errors = 0;

for (let i = 0; i < entries.length; i += BATCH_SIZE) {
  const batch = entries.slice(i, i + BATCH_SIZE);
  const stmts = batch.map(([barcode, entry]) => ({
    sql: "INSERT OR IGNORE INTO retail (barcode, product_name, brand, category) VALUES (?, ?, ?, ?)",
    args: [barcode, entry[0] || "", entry[1] || "", entry[2] || ""],
  }));

  try {
    await client.batch(stmts, "write");
    imported += batch.length;
  } catch (e) {
    errors++;
    if (errors <= 3) console.warn(`[turso-import] Batch error at ${i}: ${e.message}`);
    if (errors > 50) { console.error("[turso-import] Too many errors, stopping."); break; }
    // Retry with smaller batches
    for (const stmt of stmts) {
      try { await client.execute(stmt); imported++; } catch { /* skip duplicate */ }
    }
  }

  if ((imported % 100_000) < BATCH_SIZE || i + BATCH_SIZE >= entries.length) {
    const pct = Math.min(100, Math.round((imported / entries.length) * 100));
    const elapsed = ((performance.now() - t1) / 1000).toFixed(0);
    const rate = Math.round(imported / ((performance.now() - t1) / 1000));
    console.log(`[turso-import] ${pct}% (${imported}/${entries.length}) in ${elapsed}s (${rate} rows/s)`);
  }
}

// Create index after bulk insert
console.log("[turso-import] Creating barcode index...");
await client.execute("CREATE INDEX IF NOT EXISTS idx_retail_barcode ON retail(barcode)");

const finalCount = await client.execute("SELECT COUNT(*) as c FROM retail");
console.log(`[turso-import] Done. Final row count: ${finalCount.rows[0].c}. Errors: ${errors}. Time: ${((performance.now() - t0) / 1000).toFixed(0)}s`);
client.close();
