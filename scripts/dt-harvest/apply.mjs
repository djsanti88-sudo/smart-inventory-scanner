#!/usr/bin/env node
// scripts/dt-harvest/apply.mjs (Task 6, Step 1) — Merge harvested Discount Tire rows into the
// REAL tire corpus (src/decoding/server/knowledge/tire/tireKnowledge.generated.json), rebuild the SQLite
// knowledge DB, and spot-check a sample of newly-added barcodes round-trip correctly.
//
// Real corpus schema (verified by reading tireKnowledge.generated.json directly, NOT assumed):
//   { schema_version, generated_at, barcodeIndex: { <barcode>: RowV1 }, partNumberIndex: { <mpn
//   normalized>: canonical_product_uid }, identityIndex: { "brand|model|size|load|speed":
//   canonical_product_uid } }
//   RowV1 = { canonical_product_uid, brand, brand_normalized, model, model_normalized, size,
//   raw_size_text, load_index, speed_rating, load_range, type, season,
//   manufacturer_part_number, barcode, barcode_type, confidence, current_status, usable_for,
//   field_completeness_score, missing_fields, source_count }
// This has NO `source` field today (unlike lib/merge.mjs's assumed CorpusRow columns), so
// cross-source-safety is adapted here: any row already present in the real corpus is treated as
// "another source" UNLESS it was itself added by a prior dt-harvest apply run (recognized by an
// additive, non-schema `source: "discounttire"` marker this script itself stamps onto rows it
// writes — existing rows from the original corpus never carry it, so they always win ties safely
// on the first run; only a dt-harvest row can be superseded by a more complete dt-harvest row on
// subsequent runs). This mirrors lib/merge.mjs's decision logic (guardRow + the cross-source /
// same-source completeness rules) without editing merge.mjs, because the real corpus is a Map
// (barcodeIndex) rather than merge.mjs's assumed flat array.
//
// Untrusted input: state/harvested*.jsonl came from scraped HTML (see parseProduct.mjs's
// semantic-firewall note). Rows are only parsed/guarded/mapped — never executed or obeyed.
//
// Usage:
//   node scripts/dt-harvest/apply.mjs                 merge state/harvested*.jsonl into the corpus,
//                                                      rebuild the DB, spot-check 20 random new rows
//   node scripts/dt-harvest/apply.mjs --dry-run        print the would-add/skip table only
//   node scripts/dt-harvest/apply.mjs --input=path     merge a single explicit file instead of the glob
//
// Does NOT run automatically against real data and does NOT invoke build:knowledge-db unless a human
// (or an approved orchestrator) runs this file directly — see CLAUDE.md's no-live-run gate for this task.

import { readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { guardRow } from "./lib/merge.mjs";
import { jsonlLinesToRows, toCorpusRow } from "./lib/applyTransform.mjs";
import { sameBrandFamily } from "./lib/brandFamilies.mjs";
import { readTursoCredsFromEnvFile, upsertNewTiresToTurso } from "./lib/tursoUpsert.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = process.cwd();

const CORPUS_JSON_PATH = join(ROOT, "src", "decoding", "server", "knowledge", "tire", "tireKnowledge.generated.json");
const BRAND_PREFIX_MAP_PATH = join(ROOT, "src", "products", "catalog", "brandPrefixMap.json");
const STATE_DIR = join(__dirname, "state");
const DEFAULT_GLOB_PREFIX = "harvested"; // matches state/harvested.jsonl and state/harvested*.jsonl
const ENV_LOCAL_PATH = join(ROOT, ".env.local");

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { dryRun: false, input: null, noTurso: false };
  for (const raw of argv) {
    if (raw === "--dry-run") args.dryRun = true;
    else if (raw === "--no-turso") args.noTurso = true;
    else if (raw.startsWith("--input=")) args.input = raw.slice("--input=".length);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Input discovery: single --input override, or all state/harvested*.jsonl files.
// ---------------------------------------------------------------------------
function findHarvestFiles(inputOverride) {
  if (inputOverride) {
    const p = join(ROOT, inputOverride);
    return existsSync(p) ? [p] : existsSync(inputOverride) ? [inputOverride] : [];
  }
  if (!existsSync(STATE_DIR)) return [];
  return readdirSync(STATE_DIR)
    .filter((f) => f.startsWith(DEFAULT_GLOB_PREFIX) && f.endsWith(".jsonl"))
    .sort()
    .map((f) => join(STATE_DIR, f));
}

function readAllLines(files) {
  const lines = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const line of text.split(/\r?\n/)) lines.push(line);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// prefixMap: loaded the same way the rest of the harvest pipeline does — the general,
// catalog-derived Record<7-digit-prefix, brand> file (guardRow accepts scalar or array).
// ---------------------------------------------------------------------------
function loadPrefixMap() {
  if (!existsSync(BRAND_PREFIX_MAP_PATH)) return {};
  try {
    return JSON.parse(readFileSync(BRAND_PREFIX_MAP_PATH, "utf8"));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Corpus load / backup / save
// ---------------------------------------------------------------------------
function todayStamp(now = new Date()) {
  return now.toISOString().slice(0, 10); // YYYY-MM-DD
}

function loadCorpus() {
  const raw = readFileSync(CORPUS_JSON_PATH, "utf8");
  return JSON.parse(raw);
}

/** Back up the corpus JSON once per calendar day; never overwrite an existing same-day backup. */
function backupCorpusOnce(now = new Date()) {
  const backupPath = `${CORPUS_JSON_PATH}.bak-${todayStamp(now)}`;
  if (existsSync(backupPath)) {
    console.log(`[dt-harvest apply] Backup already exists, keeping it: ${backupPath}`);
    return backupPath;
  }
  copyFileSync(CORPUS_JSON_PATH, backupPath);
  console.log(`[dt-harvest apply] Backed up corpus to: ${backupPath}`);
  return backupPath;
}

function writeCorpus(corpus) {
  // Pretty-print with 2-space indent to match the committed formatting convention used elsewhere
  // in this repo's generated JSON (see scripts/build-tire-knowledge.mjs writeFileSync calls).
  writeFileSync(CORPUS_JSON_PATH, JSON.stringify(corpus, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Adapter: real corpus barcodeIndex (Map) <-> merge.mjs-style decision logic.
//
// lib/merge.mjs's mergeRows() assumes a flat CorpusRow[] with a `source` column it can compare.
// The real corpus has neither shape, so this adapter replicates merge.mjs's cross-source-safe
// decision logic directly against the barcodeIndex Map (guardRow is reused verbatim; the
// duplicate-resolution rules are re-implemented here because the real corpus row shape and the
// completeness convention differ from merge.mjs's toCorpusRow()/fieldCompleteness()).
// ---------------------------------------------------------------------------
function fieldCompleteness(row) {
  return Object.values(row).filter((v) => v !== null && v !== undefined && v !== "").length;
}

function normText(s) {
  return (s ?? "").toString().trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normPart(s) {
  return (s ?? "").toString().replace(/[ -]/g, "").trim().toUpperCase();
}

/** Build a canonical_product_uid consistent with build-tire-knowledge.mjs's convention. */
function canonicalUidFor(row) {
  const size = normText(row.size).replace(/\s+/g, "");
  const parts = [row.brand_normalized, row.model_normalized, size, row.load_index, row.speed_rating, row.manufacturer_part_number]
    .map((p) => (p || "").toString().trim())
    .filter(Boolean)
    .map((p) => p.toLowerCase().replace(/[^a-z0-9]+/g, "_"));
  return parts.join("_");
}

/**
 * Apply the guard + cross-source-safe merge logic against the real corpus's barcodeIndex map.
 * Mutates nothing passed in; returns a NEW barcodeIndex plus the same added/skipped shape
 * lib/merge.mjs's mergeRows() returns, so callers can print one consistent report either way.
 */
function mergeIntoBarcodeIndex(barcodeIndex, harvestedRows, prefixMap, sameBrandFamily) {
  const nextIndex = { ...barcodeIndex };
  const skipped = [];
  let added = 0;

  for (const tireRow of harvestedRows) {
    // Forward the family firewall so a same-family brand is not a prefix conflict here either
    // (mirrors jsonlLinesToRows / applyBackfill; keeps the recovery consistent on the apply path).
    const guard = guardRow(tireRow, prefixMap, sameBrandFamily);
    if (!guard.ok) {
      skipped.push({ row: tireRow, reason: guard.reason });
      continue;
    }

    const candidate = toCorpusRow(tireRow);
    candidate.canonical_product_uid = canonicalUidFor(candidate);
    const barcode = candidate.barcode;
    const current = nextIndex[barcode];

    if (!current) {
      nextIndex[barcode] = candidate;
      added += 1;
      continue;
    }

    // Any existing row not stamped source:"discounttire" by a prior apply run is treated as
    // "another source" (the original corpus has no source field at all) -> never overwrite.
    if (current.source !== "discounttire") {
      skipped.push({ row: tireRow, reason: "cross_source_duplicate" });
      continue;
    }

    // Duplicate within discounttire-sourced rows: higher field-completeness wins.
    if (fieldCompleteness(candidate) > fieldCompleteness(current)) {
      nextIndex[barcode] = candidate;
      added += 1;
    } else {
      skipped.push({ row: tireRow, reason: "less_complete_duplicate" });
    }
  }

  return { barcodeIndex: nextIndex, added, skipped };
}

function rebuildSecondaryIndexes(corpus) {
  const partNumberIndex = {};
  const identityIndex = {};
  for (const row of Object.values(corpus.barcodeIndex)) {
    if (row.manufacturer_part_number) {
      const pk = normPart(row.manufacturer_part_number);
      if (pk && !partNumberIndex[pk]) partNumberIndex[pk] = row.canonical_product_uid;
    }
    const ik = `${row.brand_normalized}|${row.model_normalized}|${normText(row.size)}|${row.load_index}|${row.speed_rating}`;
    if (!identityIndex[ik]) identityIndex[ik] = row.canonical_product_uid;
  }
  corpus.partNumberIndex = partNumberIndex;
  corpus.identityIndex = identityIndex;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
function printReport(added, skipped) {
  const reasonCounts = new Map();
  for (const s of skipped) reasonCounts.set(s.reason, (reasonCounts.get(s.reason) ?? 0) + 1);

  console.log("\n[dt-harvest apply] Merge report");
  console.log(`  Added:   ${added}`);
  console.log(`  Skipped: ${skipped.length}`);
  if (reasonCounts.size) {
    console.log("  Skip reasons:");
    for (const [reason, count] of [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${reason.padEnd(28)} ${count}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Rebuild + spot-check
// ---------------------------------------------------------------------------
function runKnowledgeDbRebuild() {
  console.log("\n[dt-harvest apply] Running: npm run build:knowledge-db");
  const result = spawnSync("npm", ["run", "build:knowledge-db"], {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    throw new Error(`build:knowledge-db exited with status ${result.status}`);
  }
}

function pickRandom(arr, n) {
  const pool = [...arr];
  const out = [];
  while (pool.length && out.length < n) {
    const idx = Math.floor(Math.random() * pool.length);
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

/** Spot-check newly-added barcodes round-trip through the rebuilt SQLite DB the same way
 * production reads it (src/decoding/server/knowledge/knowledgeDb.ts). Returns { passed, failed } counts and logs
 * PASS/FAIL per code. Throws (non-zero exit is the caller's job) only if the DB cannot be opened. */
async function spotCheckBarcodes(barcodes, addedByBarcode) {
  if (!barcodes.length) {
    console.log("\n[dt-harvest apply] No newly-added barcodes to spot-check.");
    return { passed: 0, failed: 0 };
  }

  const sample = pickRandom(barcodes, Math.min(20, barcodes.length));
  console.log(`\n[dt-harvest apply] Spot-checking ${sample.length} random newly-added barcodes against the rebuilt DB...`);

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = (await import("better-sqlite3")).default;
  const dbPath = join(ROOT, "src", "decoding", "server", "knowledge", "knowledge.generated.db");
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });

  let passed = 0;
  let failed = 0;
  try {
    const stmt = db.prepare("SELECT barcode, brand FROM tires WHERE barcode = ?");
    for (const barcode of sample) {
      const expectedBrand = (addedByBarcode.get(barcode)?.brand || "").trim().toLowerCase();
      const row = stmt.get(barcode);
      const gotBrand = (row?.brand || "").trim().toLowerCase();
      const ok = !!row && gotBrand === expectedBrand;
      console.log(`  ${ok ? "PASS" : "FAIL"}  ${barcode}  expected brand="${expectedBrand}" got="${gotBrand}"`);
      if (ok) passed += 1;
      else failed += 1;
    }
  } finally {
    db.close();
  }

  console.log(`\n[dt-harvest apply] Spot-check summary: ${passed} PASS, ${failed} FAIL`);
  return { passed, failed };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));

  const files = findHarvestFiles(args.input);
  if (!files.length) {
    console.log(`[dt-harvest apply] No harvest files found (looked for ${args.input || "state/harvested*.jsonl"}). Nothing to do.`);
    return;
  }
  console.log(`[dt-harvest apply] Reading ${files.length} harvest file(s):`);
  for (const f of files) console.log(`  ${f}`);

  // Load the prefix map BEFORE the transform so jsonlLinesToRows can RE-EVALUATE stale
  // prefix_conflict-stamped rows live against the current prefix map + brand-family firewall
  // (same recovery seam as backfill-part-numbers.mjs; see brandFamilies.mjs).
  const prefixMap = loadPrefixMap();

  const lines = readAllLines(files);
  const harvestedRows = jsonlLinesToRows(lines, { prefixMap, sameBrandFamily });
  console.log(`[dt-harvest apply] ${harvestedRows.length} guard-ok row(s) with a gtin after batch dedupe.`);

  const corpus = loadCorpus();
  const beforeCount = Object.keys(corpus.barcodeIndex).length;

  const { barcodeIndex: mergedIndex, added, skipped } = mergeIntoBarcodeIndex(corpus.barcodeIndex, harvestedRows, prefixMap, sameBrandFamily);
  printReport(added, skipped);

  if (args.dryRun) {
    console.log("\n[dt-harvest apply] --dry-run: not writing the corpus, not rebuilding the DB, not spot-checking.");
    return;
  }

  if (added === 0) {
    console.log("\n[dt-harvest apply] Nothing to add; leaving the corpus and DB untouched.");
    return;
  }

  backupCorpusOnce();

  const newlyAdded = new Map();
  for (const [barcode, row] of Object.entries(mergedIndex)) {
    const prior = corpus.barcodeIndex[barcode];
    if (!prior || prior !== row) {
      if (row.source === "discounttire") newlyAdded.set(barcode, row);
    }
  }

  corpus.barcodeIndex = mergedIndex;
  corpus.generated_at = new Date().toISOString();
  rebuildSecondaryIndexes(corpus);
  writeCorpus(corpus);

  const afterCount = Object.keys(corpus.barcodeIndex).length;
  console.log(`\n[dt-harvest apply] Corpus size: ${beforeCount} -> ${afterCount} (+${afterCount - beforeCount})`);

  runKnowledgeDbRebuild();

  const { failed } = await spotCheckBarcodes([...newlyAdded.keys()], newlyAdded);
  if (failed > 0) {
    console.error(`\n[dt-harvest apply] FAILED: ${failed} spot-checked barcode(s) did not round-trip correctly.`);
    process.exit(1);
  }

  await maybeUpsertToTurso(newlyAdded, args.noTurso);

  console.log("\n[dt-harvest apply] Done.");
}

// ---------------------------------------------------------------------------
// Turso upsert (additive): grow the corpus in Turso without a redeploy. Gated on
// TURSO_DATABASE_URL being present in .env.local and --no-turso not being passed. Errors here are
// logged as a warning and swallowed — the local corpus apply (JSON + SQLite rebuild + spot-check)
// has already succeeded by the time this runs and must not be undone by a Turso-side problem.
// Only ever writes `tires` / `tire_part_numbers` - never retail, decode_cache, or legacy provider tables.
// ---------------------------------------------------------------------------
async function maybeUpsertToTurso(newlyAdded, noTurso) {
  if (noTurso) {
    console.log("\n[dt-harvest apply] --no-turso: skipping Turso upsert.");
    return;
  }
  if (newlyAdded.size === 0) {
    return;
  }

  const creds = readTursoCredsFromEnvFile(readFileSync, ENV_LOCAL_PATH);
  if (!creds) {
    console.log("\n[dt-harvest apply] No TURSO_DATABASE_URL in .env.local: skipping Turso upsert (local corpus apply already succeeded).");
    return;
  }

  console.log(`\n[dt-harvest apply] Upserting ${newlyAdded.size} newly-added tire row(s) to Turso...`);
  try {
    const { tiresWritten, partNumbersWritten } = await upsertNewTiresToTurso({ newlyAdded, creds });
    console.log(`[dt-harvest apply] Turso upsert done: ${tiresWritten} tires row(s), ${partNumbersWritten} tire_part_numbers row(s).`);
  } catch (e) {
    console.warn(`[dt-harvest apply] WARNING: Turso upsert failed (local corpus apply already succeeded, continuing): ${e?.message || e}`);
  }
}

main().catch((e) => {
  console.error("[dt-harvest apply] ERROR:", e?.stack || e?.message || e);
  process.exit(1);
});
