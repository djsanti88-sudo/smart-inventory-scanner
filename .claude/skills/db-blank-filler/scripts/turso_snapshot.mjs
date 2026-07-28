#!/usr/bin/env node
// Turso snapshot -> local SQLite working copy. READ-ONLY against Turso.
//
// Downloads the live tire corpus tables from Turso via plain SELECT statements (the same read
// path and env convention as scripts/tire-db-repair/07_turso_dryrun.mjs and
// src/server/tire-knowledge/tireKnowledgeIndex.ts) into a fresh local better-sqlite3 file that
// the pipeline then runs against. This lets the round-trip work on a WORKING COPY of live data
// without ever writing to Turso.
//
// This script issues ZERO write statements against Turso. It only ever issues SELECT statements
// over the existing @libsql/client read path and writes to a LOCAL SQLite file. Promotion back to
// Turso is a SEPARATE, owner-gated step (see SKILL.md) and is never performed here.
//
// Env (read from process.env or .env.local, never logged): TURSO_DATABASE_URL, TURSO_AUTH_TOKEN.
// Barcodes / part numbers are stored as TEXT.
//
// Usage: node turso_snapshot.mjs <outputDbPath>
//   Exits 2 (not 1) with an honest message if credentials are absent, so a caller can distinguish
//   "no creds" from a real failure. NEVER fabricates data.

import { createRequire } from "node:module";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const require = createRequire(path.join(REPO_ROOT, "package.json"));
const Database = require("better-sqlite3");

const outPath = process.argv[2];
if (!outPath) {
  console.error("usage: node turso_snapshot.mjs <outputDbPath>");
  process.exit(1);
}

function loadEnvLocal() {
  // Mirrors 07_turso_dryrun.mjs: shallow parse of .env.local, never overwrites existing env,
  // never logs values. Read-only. Test-safety: DBBF_SKIP_ENV_LOCAL=1 disables the .env.local read
  // so the smoke test can prove the no-credentials path without touching real Turso creds.
  if (process.env.DBBF_SKIP_ENV_LOCAL === "1") return;
  const p = path.join(REPO_ROOT, ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

// Tables copied from live Turso. Each entry: local DDL + the read SELECT. Kept minimal and
// text-typed; the working-copy pipeline only needs the corpus tables it edits.
const TABLES = {
  tires: {
    ddl: `CREATE TABLE tires (
      barcode TEXT, canonical_product_uid TEXT, brand TEXT, brand_normalized TEXT, model TEXT,
      model_normalized TEXT, size TEXT, raw_size_text TEXT, load_index TEXT, speed_rating TEXT,
      load_range TEXT, type TEXT, season TEXT, manufacturer_part_number TEXT, barcode_type TEXT,
      confidence TEXT, current_status TEXT, usable_for TEXT, field_completeness_score TEXT,
      missing_fields TEXT, source_count INTEGER, model_display TEXT)`,
    select: `SELECT barcode, canonical_product_uid, brand, brand_normalized, model,
      model_normalized, size, raw_size_text, load_index, speed_rating, load_range, type, season,
      manufacturer_part_number, barcode_type, confidence, current_status, usable_for,
      field_completeness_score, missing_fields, source_count, model_display FROM tires`,
  },
  tire_part_numbers: {
    ddl: `CREATE TABLE tire_part_numbers (
      normalized_part_number TEXT, canonical_product_uid TEXT)`,
    select: `SELECT normalized_part_number, canonical_product_uid FROM tire_part_numbers`,
  },
  tire_barcode_aliases: {
    ddl: `CREATE TABLE tire_barcode_aliases (
      barcode TEXT, barcode_type TEXT, canonical_product_id TEXT, source_table TEXT,
      alias_confidence INTEGER)`,
    select: `SELECT barcode, barcode_type, canonical_product_id, source_table, alias_confidence
      FROM tire_barcode_aliases`,
  },
};

async function main() {
  loadEnvLocal();
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) {
    console.error(
      "turso_snapshot: TURSO_DATABASE_URL / TURSO_AUTH_TOKEN not set. No snapshot taken " +
        "(this is not a failure - run in offline mode against a packaged DB copy instead)."
    );
    process.exit(2);
  }

  let createClient;
  try {
    ({ createClient } = await import("@libsql/client"));
  } catch {
    console.error("turso_snapshot: @libsql/client not installed.");
    process.exit(2);
  }

  const client = createClient({ url, authToken });

  // Write-to-temp-then-rename: a snapshot is only ever visible at outPath once EVERY table has
  // copied successfully. Without this, a crash/network-drop mid-copy (found under adversarial
  // testing 2026-07-28) leaves a PARTIAL but structurally-valid SQLite file sitting at the final
  // path - some tables populated, others empty/missing - indistinguishable from a complete
  // snapshot to any caller that just checks existsSync(outPath). The temp file lives alongside
  // outPath (same directory, so the final rename is an atomic same-filesystem move) and is always
  // cleaned up on any failure path, never left as a look-alike ".db" file.
  const tmpPath = `${outPath}.partial-${process.pid}-${Date.now()}.tmp`;
  if (existsSync(tmpPath)) rmSync(tmpPath);

  let local;
  try {
    local = new Database(tmpPath);
    local.pragma("journal_mode = WAL");

    const summary = {};
    for (const [name, spec] of Object.entries(TABLES)) {
      local.prepare(spec.ddl).run();
      const res = await client.execute(spec.select); // SELECT only
      const cols = res.columns;
      if (res.rows.length > 0) {
        const placeholders = cols.map(() => "?").join(", ");
        const ins = local.prepare(`INSERT INTO ${name} (${cols.join(", ")}) VALUES (${placeholders})`);
        const tx = local.transaction((rows) => {
          for (const row of rows) ins.run(cols.map((c) => (row[c] == null ? null : String(row[c]))));
        });
        // Cast every cell to TEXT except we let SQLite store NULLs; INTEGER cols coerce naturally.
        tx(res.rows);
      }
      summary[name] = res.rows.length;
    }
    local.close();
    local = null;

    // WAL mode can leave -wal/-shm sidecar files; checkpoint isn't strictly required since we
    // close cleanly above, but clean up any sidecars before the rename so only the .db file (and
    // no stray WAL artifacts) lands at outPath.
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = tmpPath + suffix;
      if (existsSync(sidecar)) rmSync(sidecar);
    }

    if (existsSync(outPath)) rmSync(outPath);
    renameSync(tmpPath, outPath);
    console.log(JSON.stringify({ mode: "live-read", outPath, rowsCopied: summary }));
  } catch (e) {
    if (local) {
      try {
        local.close();
      } catch {
        /* already closed or unusable; fall through to cleanup */
      }
    }
    for (const p of [tmpPath, tmpPath + "-wal", tmpPath + "-shm"]) {
      if (existsSync(p)) rmSync(p);
    }
    throw e;
  }
}

main().catch((e) => {
  console.error("turso_snapshot failed:", e.message);
  process.exit(1);
});
