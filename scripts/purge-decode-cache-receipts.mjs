#!/usr/bin/env node
// purge-decode-cache-receipts.mjs - Standalone, OWNER-GATED maintenance tool that deletes every
// legacy "no_result_receipt" row from the Turso `decode_cache` table AND the local .decode-cache.json
// file. One-time cleanup for the owner ruling of 2026-08-20 (DECISIONS.md "No-candidate rows
// ABOLISHED"): a failed decode stores nothing, so no row of this kind may remain anywhere. The
// runtime already reads such rows back as a plain miss (decodeCacheStore.ts), so this script is pure
// data hygiene, not a behavior gate. Mirrors scripts/purge-decode-cache-examples.mjs exactly.
//
// SAFETY MODEL: default = READ-ONLY. Prints a COUNT + a sample of matching rows and exits WITHOUT
// deleting anything. Only with the explicit --apply flag does it run the scoped DELETE (an exact
// kind = 'no_result_receipt' column match, never fuzzy) and re-count afterward.
//
// Usage:
//   node scripts/purge-decode-cache-receipts.mjs           (preview: count + sample, no writes)
//   node scripts/purge-decode-cache-receipts.mjs --apply   (actually delete the matched rows)
//
// Requires env vars TURSO_DATABASE_URL + TURSO_AUTH_TOKEN; when absent they are read from .env.local
// (the app's own runtime source), values never printed. The local .decode-cache.json pass runs
// regardless and is skipped gracefully when the file is absent.

import { createClient } from "@libsql/client";
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const SAMPLE_SIZE = 10;

/** Minimal .env.local reader for the two Turso vars only (never printed). */
function envLocal(name) {
  if (process.env[name]) return process.env[name];
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), ".env.local"), "utf8");
    const line = raw.split(/\r?\n/).find((l) => l.startsWith(`${name}=`));
    return line ? line.slice(name.length + 1).trim().replace(/^["']|["']$/g, "") : undefined;
  } catch {
    return undefined;
  }
}

function purgeLocalFile() {
  const file = process.env.DECODE_CACHE_FILE || path.join(process.cwd(), ".decode-cache.json");
  if (!fs.existsSync(file)) {
    console.log(`[purge-receipts] Local file ${file} absent - skipping local pass.`);
    return;
  }
  let store;
  try {
    store = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.log(`[purge-receipts] Local file unreadable (${e.message}) - skipping local pass.`);
    return;
  }
  const keys = Object.keys(store || {});
  const matched = keys.filter((key) => store[key]?.kind === "no_result_receipt");
  console.log(`[purge-receipts] Local entries before: ${keys.length}; receipt rows: ${matched.length}`);
  if (!APPLY || matched.length === 0) return;
  for (const key of matched) delete store[key];
  fs.writeFileSync(file, JSON.stringify(store), "utf8");
  console.log(`[purge-receipts] Local: removed ${matched.length}. After: ${Object.keys(store).length}`);
}

async function purgeTurso() {
  const url = envLocal("TURSO_DATABASE_URL");
  const token = envLocal("TURSO_AUTH_TOKEN");
  if (!url || !token) {
    console.log("[purge-receipts] Turso credentials not available - skipping Turso pass.");
    return;
  }
  const client = createClient({ url, authToken: token });
  console.log("[purge-receipts] Connecting to Turso decode_cache...");

  const before = await client.execute("SELECT COUNT(*) as c FROM decode_cache");
  const receipts = await client.execute("SELECT COUNT(*) as c FROM decode_cache WHERE kind = 'no_result_receipt'");
  console.log(`[purge-receipts] Total rows before: ${before.rows[0].c}; no_result_receipt rows: ${receipts.rows[0].c}`);

  const sample = await client.execute({
    sql: "SELECT code, tier, created_at FROM decode_cache WHERE kind = 'no_result_receipt' LIMIT ?",
    args: [SAMPLE_SIZE],
  });
  for (const row of sample.rows) {
    console.log(`  ${row.code} | tier=${row.tier} | created_at=${row.created_at}`);
  }

  if (!APPLY) {
    console.log("\n[purge-receipts] Turso PREVIEW ONLY - no rows deleted. Re-run with --apply.");
    client.close();
    return;
  }

  const res = await client.execute("DELETE FROM decode_cache WHERE kind = 'no_result_receipt'");
  console.log(`[purge-receipts] Deleted ${res.rowsAffected} receipt rows.`);
  const after = await client.execute("SELECT COUNT(*) as c FROM decode_cache");
  const left = await client.execute("SELECT COUNT(*) as c FROM decode_cache WHERE kind = 'no_result_receipt'");
  console.log(`[purge-receipts] Total rows after: ${after.rows[0].c}; receipt rows remaining: ${left.rows[0].c}`);
  client.close();
}

async function main() {
  console.log("[purge-receipts] Mode:", APPLY ? "APPLY (will delete)" : "PREVIEW (read-only)");
  purgeLocalFile();
  await purgeTurso();
}

main().catch((e) => {
  console.error("[purge-receipts] Error:", e);
  process.exit(1);
});
