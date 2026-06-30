#!/usr/bin/env node
// import-retail-turso.mjs — Bulk import retail products into Turso from the local JSON.
// Usage: node --max-old-space-size=4096 scripts/import-retail-turso.mjs
//
// Requires env vars: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN
// Or pass inline: TURSO_DATABASE_URL=libsql://... TURSO_AUTH_TOKEN=... node scripts/import-retail-turso.mjs

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";

const URL = process.env.TURSO_DATABASE_URL || "libsql://inventory-retail-djsanti88-sudo.aws-us-east-1.turso.io";
const TOKEN = process.env.TURSO_AUTH_TOKEN;
if (!TOKEN) { console.error("Set TURSO_AUTH_TOKEN"); process.exit(1); }

const BATCH_SIZE = 200; // Turso batch limit per request
const JSON_PATH = join(process.cwd(), "src", "server", "retail-knowledge", "retailKnowledge.generated.json");

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

if (existingCount > 3_000_000) {
  console.log("[turso-import] Already imported (>3M rows). Skipping. Use --force to reimport.");
  if (!process.argv.includes("--force")) { client.close(); process.exit(0); }
  console.log("[turso-import] --force: dropping and recreating table...");
  await client.execute("DROP TABLE retail");
  await client.execute("CREATE TABLE retail (barcode TEXT PRIMARY KEY, product_name TEXT NOT NULL, brand TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '')");
}

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
