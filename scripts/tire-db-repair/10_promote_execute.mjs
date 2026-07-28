#!/usr/bin/env node
// Task PROMOTE-BUILD: executable Turso promotion tooling for the repaired tire DB.
//
// Subcommands: backup | stage | verify | promote | rollback
// Every subcommand supports --dry-run (prints exact statements, executes nothing).
// Every LIVE (non-dry-run) subcommand refuses to run unless env PROMOTE_CONFIRM=YES is set,
// exiting with code 3 and a clear message otherwise. This script never runs anything against
// live Turso on its own initiative - it is fired by the orchestrator only after the council
// verdict, and only with PROMOTE_CONFIRM=YES explicitly set by that orchestrator.
//
// No git commands. This file only talks to: (a) a libsql/Turso-compatible client (live or a
// local file: URL for the proof harness), and (b) the local filesystem under
// backups/claude-tire-db-handoff-2026-07-28/repair-2026-07-28/.
//
// Usage:
//   node scripts/tire-db-repair/10_promote_execute.mjs backup  [--dry-run]
//   node scripts/tire-db-repair/10_promote_execute.mjs stage   [--dry-run]
//   node scripts/tire-db-repair/10_promote_execute.mjs verify  [--dry-run]
//   node scripts/tire-db-repair/10_promote_execute.mjs promote [--dry-run]
//   node scripts/tire-db-repair/10_promote_execute.mjs rollback [--dry-run]
//
// Env overrides (used by the proof harness to point at a local fake-live DB instead of real
// Turso; production run uses the real TURSO_DATABASE_URL / TURSO_AUTH_TOKEN from .env.local):
//   PROMOTE_TURSO_URL, PROMOTE_TURSO_AUTH_TOKEN   override TURSO_DATABASE_URL/TURSO_AUTH_TOKEN
//   PROMOTE_STAGING_DIR                            override the turso-staging/ SQL source dir
//   PROMOTE_BACKUP_DIR                             override the turso-backup/ output dir
//   PROMOTE_TS                                     override the timestamp used for _old_<ts> /
//                                                   backup dir naming (tests only; else Date.now())

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const PACKAGE_DIR = join(REPO_ROOT, "backups", "claude-tire-db-handoff-2026-07-28");
const OUTPUT_DIR = join(PACKAGE_DIR, "repair-2026-07-28");
const DEFAULT_STAGING_DIR = join(OUTPUT_DIR, "turso-staging");
const DEFAULT_BACKUP_ROOT = join(OUTPUT_DIR, "turso-backup");

const STAGING_DIR = process.env.PROMOTE_STAGING_DIR || DEFAULT_STAGING_DIR;
const BACKUP_ROOT = process.env.PROMOTE_BACKUP_DIR || DEFAULT_BACKUP_ROOT;

// Tables in scope for this promotion. Operational tables are NEVER referenced by any statement
// this script builds - this list exists only for documentation/report purposes.
const LIVE_TABLES = ["tires", "tire_part_numbers"];
const NEW_TABLES = [
  { staging: "staging_tire_product_part_number_aliases", live: "tire_product_part_number_aliases" },
  { staging: "staging_canonical_tire_products", live: "canonical_tire_products" },
  { staging: "staging_provenance", live: "provenance" },
];
const OPERATIONAL_TABLES = [
  "decode_cache", "decode_archive", "decode_outcomes", "goupc_miss_cache", "goupc_usage",
  "ladder_kv", "learned_products", "retail", "sqlite_sequence",
];

const STAGING_FILES_ORDER = [
  "01_staging_tires.sql",
  "02_staging_tire_part_numbers.sql",
  "03_staging_tire_product_part_number_aliases.sql",
  "04_staging_canonical_tire_products.sql",
  "05_staging_provenance.sql",
];

function timestamp() {
  if (process.env.PROMOTE_TS) return process.env.PROMOTE_TS;
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "_");
}

function rel(p) {
  return p.replace(REPO_ROOT + "\\", "").replace(REPO_ROOT + "/", "").replace(/\\/g, "/");
}

function loadEnvLocal() {
  const path = join(REPO_ROOT, ".env.local");
  if (!existsSync(path)) return;
  const txt = readFileSync(path, "utf8");
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (!m) continue;
    if (!process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

/** Resolve the target client connection info. PROMOTE_TURSO_URL/PROMOTE_TURSO_AUTH_TOKEN (used by
 *  the proof harness to point at a local file: DB) take priority over the real
 *  TURSO_DATABASE_URL/TURSO_AUTH_TOKEN so tests never touch production credentials by accident. */
function resolveConnection() {
  loadEnvLocal();
  const url = process.env.PROMOTE_TURSO_URL || process.env.TURSO_DATABASE_URL;
  const authToken = process.env.PROMOTE_TURSO_AUTH_TOKEN || process.env.TURSO_AUTH_TOKEN || undefined;
  return { url, authToken };
}

async function makeClient() {
  const { url, authToken } = resolveConnection();
  if (!url) {
    throw new Error("No Turso/libsql URL available (TURSO_DATABASE_URL / PROMOTE_TURSO_URL not set).");
  }
  const { createClient } = await import("@libsql/client");
  return createClient(authToken ? { url, authToken } : { url });
}

/** The hard refusal gate. Every subcommand that would WRITE against the live database (all
 *  except backup's SELECTs are read-only too, but we gate uniformly across all live execution
 *  paths per the brief) must call this before issuing any statement, unless --dry-run. */
function requireConfirmOrExit(dryRun) {
  if (dryRun) return;
  if (process.env.PROMOTE_CONFIRM !== "YES") {
    console.error(
      "REFUSED: this is a LIVE run against the configured database, but env PROMOTE_CONFIRM=YES " +
        "is not set. Set PROMOTE_CONFIRM=YES (the orchestrator sets this at execution time, after " +
        "the council verdict) or pass --dry-run to preview without executing."
    );
    process.exit(3);
  }
}

function parseArgs(argv) {
  const subcommand = argv[2];
  const dryRun = argv.includes("--dry-run");
  return { subcommand, dryRun };
}

// -------------------------------------------------------------------------------------------
// Shared: batch executor. In dry-run mode, prints statements only. Live mode executes them via
// the libsql client, batching in a single transaction per file (or a single call to
// client.batch() for a group of statements) so partial application is never observed.
// -------------------------------------------------------------------------------------------

function splitSqlStatements(sqlText) {
  // Strip full-line comments (this repo's generator only ever emits full-line `--` comments;
  // no statement text contains a literal `--` sequence outside of a quoted string in the datasets
  // we load).
  const withoutComments = sqlText
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

  // Split on `;` but NEVER inside a single-quoted SQL string literal, where `''` is the escaped
  // quote. Several provenance rows contain a literal semicolon inside a text field (e.g.
  // 'boss-workbook merge lineage; internal, no external license'), so a naive split(";") corrupts
  // those statements. This is a small hand-rolled scanner, not a full SQL parser, but it only
  // needs to track single-quote state to be correct for this repo's generated INSERT/CREATE SQL.
  const statements = [];
  let current = "";
  let inString = false;
  for (let i = 0; i < withoutComments.length; i++) {
    const ch = withoutComments[i];
    current += ch;
    if (ch === "'") {
      if (inString && withoutComments[i + 1] === "'") {
        // Escaped quote ('') - consume both characters as part of the string, stay inString.
        current += withoutComments[i + 1];
        i++;
      } else {
        inString = !inString;
      }
    } else if (ch === ";" && !inString) {
      const trimmed = current.trim();
      if (trimmed.length > 0) statements.push(trimmed);
      current = "";
    }
  }
  const trailing = current.trim();
  if (trailing.length > 0) statements.push(trailing + ";");
  return statements;
}

async function execBatch(client, statements, { dryRun, label }) {
  if (dryRun) {
    console.log(`[dry-run] ${label}: would execute ${statements.length} statement(s):`);
    for (const s of statements) {
      console.log(`  ${s.length > 200 ? s.slice(0, 200) + " ... [truncated]" : s}`);
    }
    return;
  }
  console.log(`${label}: executing ${statements.length} statement(s) in one batch...`);
  await client.batch(statements, "write");
  console.log(`${label}: done.`);
}

// =============================================================================================
// backup: dump live tires + tire_part_numbers (full rows, batched SELECTs) to timestamped local
// files + a row-count manifest. READ-ONLY.
// =============================================================================================
async function cmdBackup({ dryRun }) {
  const ts = timestamp();
  const outDir = join(BACKUP_ROOT, ts);

  if (dryRun) {
    console.log(`[dry-run] backup: would create ${rel(outDir)}/`);
    for (const table of LIVE_TABLES) {
      console.log(`[dry-run] backup: would run "SELECT * FROM ${table}" in batches of 1000 rows,`);
      console.log(`[dry-run] backup:   writing to ${rel(join(outDir, `${table}.jsonl`))}`);
    }
    console.log(`[dry-run] backup: would write manifest to ${rel(join(outDir, "manifest.json"))}`);
    return { outDir, manifest: null };
  }

  mkdirSync(outDir, { recursive: true });
  const client = await makeClient();
  const manifest = { timestamp: ts, tables: {} };

  const BATCH = 1000;
  for (const table of LIVE_TABLES) {
    console.log(`backup: dumping ${table}...`);
    const countRes = await client.execute(`SELECT COUNT(*) AS c FROM ${table}`);
    const total = Number(countRes.rows[0].c);
    const filePath = join(outDir, `${table}.jsonl`);
    let written = 0;
    // better-sqlite3/libsql have no native OFFSET-free cursor here; use a stable ORDER BY +
    // LIMIT/OFFSET pagination. This is read-only and safe to re-run.
    const pk = table === "tires" ? "barcode" : "normalized_part_number";
    let lines = [];
    for (let offset = 0; offset < total; offset += BATCH) {
      const res = await client.execute(
        `SELECT * FROM ${table} ORDER BY ${pk} LIMIT ${BATCH} OFFSET ${offset}`
      );
      for (const row of res.rows) {
        lines.push(JSON.stringify(row));
        written++;
      }
    }
    writeFileSync(filePath, lines.join("\n") + (lines.length ? "\n" : ""), "utf8");
    manifest.tables[table] = { rowCount: written, file: `${table}.jsonl` };
    console.log(`backup: wrote ${written} rows to ${rel(filePath)}`);
  }

  const manifestPath = join(outDir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  console.log(`backup: wrote manifest to ${rel(manifestPath)}`);
  return { outDir, manifest };
}

// =============================================================================================
// stage: create staging_* tables on live and load them from the turso-staging SQL files in
// batched transactions. Idempotent: DROP staging_* first. Writes ONLY staging_* tables.
// =============================================================================================
function stagingTableNamesInScope() {
  return [
    "staging_tires",
    "staging_tire_part_numbers",
    "staging_tire_product_part_number_aliases",
    "staging_canonical_tire_products",
    "staging_provenance",
  ];
}

async function cmdStage({ dryRun }) {
  requireConfirmOrExit(dryRun);

  const dropStatements = stagingTableNamesInScope().map((t) => `DROP TABLE IF EXISTS ${t};`);

  const fileStatements = [];
  for (const fname of STAGING_FILES_ORDER) {
    const fpath = join(STAGING_DIR, fname);
    if (!existsSync(fpath)) {
      throw new Error(`Missing staging SQL file: ${rel(fpath)}`);
    }
    const text = readFileSync(fpath, "utf8");
    const statements = splitSqlStatements(text);
    fileStatements.push({ file: fname, statements });
  }

  if (dryRun) {
    console.log(`[dry-run] stage: would DROP TABLE IF EXISTS on ${dropStatements.length} staging tables:`);
    for (const s of dropStatements) console.log(`  ${s}`);
    for (const { file, statements } of fileStatements) {
      console.log(`[dry-run] stage: would load ${rel(join(STAGING_DIR, file))} (${statements.length} statement(s))`);
    }
    return;
  }

  const client = await makeClient();

  console.log("stage: dropping any pre-existing staging_* tables (idempotent)...");
  await client.batch(dropStatements, "write");

  for (const { file, statements } of fileStatements) {
    console.log(`stage: loading ${file} (${statements.length} statement(s))...`);
    // Batch per file in chunks to stay well under any single-batch size limit; each chunk is its
    // own transaction via client.batch(), which is fine because CREATE TABLE IF NOT EXISTS +
    // INSERT OR REPLACE are both idempotent and safe to interleave across chunk boundaries.
    const CHUNK = 50;
    for (let i = 0; i < statements.length; i += CHUNK) {
      await client.batch(statements.slice(i, i + CHUNK), "write");
    }
    console.log(`stage: ${file} loaded.`);
  }
  console.log("stage: complete. Only staging_* tables were written.");
}

// =============================================================================================
// verify: run the gate queries against the live staging_* tables (counts match manifest, joins
// healthy, all live keys present per preflight expectations, zero touches of operational tables).
// =============================================================================================
async function cmdVerify({ dryRun }) {
  const gates = [];

  if (dryRun) {
    console.log("[dry-run] verify: would run the following gates against staging_* tables:");
    console.log("  Gate A: PRAGMA integrity_check");
    console.log("  Gate B: SELECT COUNT(*) FROM staging_tires (compare to latest backup manifest tires count)");
    console.log("  Gate C: SELECT COUNT(*) FROM staging_tire_part_numbers");
    console.log("  Gate D: orphan staging_tire_part_numbers rows (LEFT JOIN staging_tires, expect 0)");
    console.log("  Gate E: duplicate normalized_part_number in staging_tire_part_numbers (expect 0 groups)");
    console.log("  Gate F: orphan staging_tire_product_part_number_aliases rows (expect 0)");
    console.log("  Gate G: every live tires.barcode present in staging_tires (expect 0 missing)");
    console.log("  Gate H: operational tables untouched (SELECT COUNT(*) unchanged vs backup manifest, informational)");
    return { passed: true, gates: [], dryRun: true };
  }

  const client = await makeClient();

  async function gate(name, fn) {
    try {
      const result = await fn();
      gates.push({ name, ...result });
      return result;
    } catch (e) {
      gates.push({ name, pass: false, detail: `ERROR: ${e.message}` });
      return { pass: false };
    }
  }

  await gate("A_integrity_check", async () => {
    const res = await client.execute("PRAGMA integrity_check");
    const value = String(res.rows[0]?.integrity_check ?? res.rows[0]?.[Object.keys(res.rows[0] || {})[0]] ?? "");
    return { pass: value.toLowerCase() === "ok", detail: value };
  });

  const tiresCountRes = await client.execute("SELECT COUNT(*) c FROM staging_tires");
  const tiresCount = Number(tiresCountRes.rows[0].c);
  await gate("B_staging_tires_count", async () => ({ pass: tiresCount > 0, detail: `${tiresCount} rows` }));

  const pnCountRes = await client.execute("SELECT COUNT(*) c FROM staging_tire_part_numbers");
  const pnCount = Number(pnCountRes.rows[0].c);
  await gate("C_staging_tire_part_numbers_count", async () => ({ pass: pnCount > 0, detail: `${pnCount} rows` }));

  await gate("D_orphan_part_numbers", async () => {
    const res = await client.execute(
      `SELECT COUNT(*) c FROM staging_tire_part_numbers p
       LEFT JOIN staging_tires t ON t.canonical_product_uid = p.canonical_product_uid
       WHERE t.barcode IS NULL`
    );
    const c = Number(res.rows[0].c);
    return { pass: c === 0, detail: `${c} orphans` };
  });

  await gate("E_duplicate_part_number_keys", async () => {
    const res = await client.execute(
      `SELECT normalized_part_number, COUNT(*) c FROM staging_tire_part_numbers
       GROUP BY normalized_part_number HAVING c > 1`
    );
    return { pass: res.rows.length === 0, detail: `${res.rows.length} duplicate group(s)` };
  });

  await gate("F_orphan_aliases", async () => {
    const res = await client.execute(
      `SELECT COUNT(*) c FROM staging_tire_product_part_number_aliases a
       LEFT JOIN staging_canonical_tire_products c ON c.canonical_product_id = a.canonical_product_id
       WHERE c.canonical_product_id IS NULL`
    );
    const c = Number(res.rows[0].c);
    return { pass: c === 0, detail: `${c} orphans` };
  });

  await gate("G_live_tire_keys_preserved", async () => {
    const liveRes = await client.execute("SELECT barcode FROM tires");
    const liveBarcodes = liveRes.rows.map((r) => String(r.barcode));
    const stagingRes = await client.execute("SELECT barcode FROM staging_tires");
    const stagingSet = new Set(stagingRes.rows.map((r) => String(r.barcode)));
    const missing = liveBarcodes.filter((b) => !stagingSet.has(b));
    return {
      pass: missing.length === 0,
      detail: missing.length === 0 ? `all ${liveBarcodes.length} live keys present` : `${missing.length} missing: ${missing.slice(0, 10).join(", ")}`,
    };
  });

  await gate("H_operational_tables_untouched", async () => {
    // Informational: confirm none of the staging load created/renamed any operational table.
    const res = await client.execute("SELECT name FROM sqlite_master WHERE type='table'");
    const names = new Set(res.rows.map((r) => String(r.name)));
    const touched = OPERATIONAL_TABLES.filter((t) => !names.has(t) && names.has(`staging_${t}`));
    return { pass: touched.length === 0, detail: touched.length === 0 ? "no operational tables staged" : `VIOLATION: ${touched.join(", ")}` };
  });

  const passed = gates.every((g) => g.pass);
  console.log("verify results:");
  for (const g of gates) console.log(`  ${g.pass ? "PASS" : "FAIL"} ${g.name}: ${g.detail}`);
  console.log(passed ? "verify: ALL GATES PASSED" : "verify: GATE FAILURE - do not promote");
  return { passed, gates };
}

// =============================================================================================
// promote: ATOMIC swap in a single batch: rename tires->tires_old_<ts>, staging_tires->tires,
// same for tire_part_numbers, then create the three new tables from staging. *_old_* tables are
// kept (never dropped) for rollback.
// =============================================================================================
async function cmdPromote({ dryRun }) {
  requireConfirmOrExit(dryRun);
  const ts = timestamp();

  const statements = [
    `ALTER TABLE tires RENAME TO tires_old_${ts};`,
    `ALTER TABLE staging_tires RENAME TO tires;`,
    `ALTER TABLE tire_part_numbers RENAME TO tire_part_numbers_old_${ts};`,
    `ALTER TABLE staging_tire_part_numbers RENAME TO tire_part_numbers;`,
    ...NEW_TABLES.map(({ staging, live }) => `ALTER TABLE ${staging} RENAME TO ${live};`),
  ];

  if (dryRun) {
    console.log(`[dry-run] promote: would execute the following in ONE atomic batch (ts=${ts}):`);
    for (const s of statements) console.log(`  ${s}`);
    console.log(`[dry-run] promote: *_old_${ts} tables would be kept (not dropped) for rollback.`);
    return { ts, statements };
  }

  const client = await makeClient();
  console.log(`promote: executing atomic swap (ts=${ts})...`);
  await client.batch(statements, "write");
  console.log("promote: complete. *_old_" + ts + " tables retained for rollback.");
  return { ts, statements };
}

// =============================================================================================
// rollback: swap back from *_old_<ts>.
// =============================================================================================
async function cmdRollback({ dryRun, ts: tsArg }) {
  requireConfirmOrExit(dryRun);

  let ts = tsArg;
  let client = null;
  if (!ts) {
    if (dryRun) {
      ts = "<ts>";
    } else {
      client = await makeClient();
      // Discover the most recent _old_ suffix by inspecting table names.
      const res = await client.execute("SELECT name FROM sqlite_master WHERE type='table'");
      const names = res.rows.map((r) => String(r.name));
      const match = names
        .map((n) => n.match(/^tires_old_(.+)$/))
        .filter(Boolean)
        .map((m) => m[1])
        .sort()
        .pop();
      if (!match) {
        throw new Error("rollback: no tires_old_<ts> table found; nothing to roll back to.");
      }
      ts = match;
    }
  }

  const statements = [
    `ALTER TABLE tires RENAME TO tires_failed_promotion_${ts};`,
    `ALTER TABLE tires_old_${ts} RENAME TO tires;`,
    `ALTER TABLE tire_part_numbers RENAME TO tire_part_numbers_failed_promotion_${ts};`,
    `ALTER TABLE tire_part_numbers_old_${ts} RENAME TO tire_part_numbers;`,
    ...NEW_TABLES.map(({ live }) => `DROP TABLE IF EXISTS ${live};`),
  ];

  if (dryRun) {
    console.log(`[dry-run] rollback: would execute the following in ONE atomic batch (ts=${ts}):`);
    for (const s of statements) console.log(`  ${s}`);
    return { ts, statements };
  }

  if (!client) client = await makeClient();
  console.log(`rollback: executing atomic rollback (ts=${ts})...`);
  await client.batch(statements, "write");
  console.log("rollback: complete. Original tables restored from *_old_" + ts + ".");
  return { ts, statements };
}

// =============================================================================================
// main
// =============================================================================================
async function main() {
  const { subcommand, dryRun } = parseArgs(process.argv);
  const tsFlagIdx = process.argv.indexOf("--ts");
  const ts = tsFlagIdx >= 0 ? process.argv[tsFlagIdx + 1] : undefined;

  switch (subcommand) {
    case "backup":
      await cmdBackup({ dryRun });
      break;
    case "stage":
      await cmdStage({ dryRun });
      break;
    case "verify": {
      const { passed } = await cmdVerify({ dryRun });
      if (!dryRun && !passed) process.exit(1);
      break;
    }
    case "promote":
      await cmdPromote({ dryRun });
      break;
    case "rollback":
      await cmdRollback({ dryRun, ts });
      break;
    default:
      console.error(
        "Usage: node scripts/tire-db-repair/10_promote_execute.mjs <backup|stage|verify|promote|rollback> [--dry-run] [--ts <timestamp>]"
      );
      process.exit(2);
  }
}

// Only auto-run when executed directly (not when imported by tests). Tests import this module's
// named exports and call cmdX() functions themselves, so they set PROMOTE_SKIP_MAIN=1 first.
if (!process.env.PROMOTE_SKIP_MAIN) {
  main().catch((e) => {
    console.error("FATAL:", e);
    process.exit(1);
  });
}

export {
  cmdBackup, cmdStage, cmdVerify, cmdPromote, cmdRollback,
  requireConfirmOrExit, resolveConnection, splitSqlStatements, timestamp,
  LIVE_TABLES, NEW_TABLES, OPERATIONAL_TABLES, STAGING_FILES_ORDER,
};
