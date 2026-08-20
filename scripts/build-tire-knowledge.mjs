#!/usr/bin/env node
// One-way generator: read a STABLE tire-knowledge snapshot (owned by the Tire Barcode Harvester) and
// produce a SERVER-ONLY, committed, versioned index the app consumes deterministically. NEVER writes to
// data/tire-knowledge (harvester-owned, read-only). Atomic output. Fails CLOSED: on any validation failure
// it does NOT overwrite the previous generated index and records the reason in the status file.
//
//   node scripts/build-tire-knowledge.mjs
//
// Snapshot precedence (input_snapshot_rule): latest checkpoint -> outputs/current -> SAFE live read ->
// committed bootstrap seed (when the harvester has not produced a snapshot yet). If the harvester is
// ACTIVELY writing (fresh harvest.lock) and no stable snapshot exists, it STOPS without reading live files.

import { parse } from "csv-parse/sync";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { missingRequiredColumns, classifyRow, normPart, normText as norm, remapHeaders, remapCsvRecord } from "./corpusRules.mjs";

const ROOT = process.cwd();
const HARVEST_DIR = join(ROOT, "data", "tire-knowledge");
const SEED = join(ROOT, "src", "server", "tire-knowledge", "seed", "tire_corpus_seed.csv");
const OUT_DIR = join(ROOT, "src", "server", "tire-knowledge");
const OUT_JSON = join(OUT_DIR, "tireKnowledge.generated.json");
const OUT_META = join(OUT_DIR, "tireKnowledge.generated.meta.json");
const STATUS = join(ROOT, "coordination", "RAG_KNOWLEDGE_STATUS.json");
const SCHEMA_VERSION = "1.0.0";
const GENERATOR_VERSION = "1.0.0";
// Output-sanity guard (F1): refuse a rebuild that retains less than this fraction of the
// existing index's barcodes. --force overrides, for a deliberate corpus replacement.
const MIN_RETAINED_FRACTION = 0.9;
const FORCE = process.argv.includes("--force");

function gitInfo() {
  const git = (args) => execFileSync("git", args, { cwd: ROOT }).toString().trim();
  try {
    return { git_branch: git(["rev-parse", "--abbrev-ref", "HEAD"]), git_commit_if_available: git(["rev-parse", "--short", "HEAD"]) };
  } catch { return { git_branch: "", git_commit_if_available: "" }; }
}
function sha256(buf) { return createHash("sha256").update(buf).digest("hex"); }

function writeStatus(obj) {
  mkdirSync(join(ROOT, "coordination"), { recursive: true });
  writeFileSync(STATUS, JSON.stringify({ branch: gitInfo().git_branch, generator_path: "scripts/build-tire-knowledge.mjs", generated_index_path: "src/server/tire-knowledge/tireKnowledge.generated.json", generated_meta_path: "src/server/tire-knowledge/tireKnowledge.generated.meta.json", data_folder_written: false, pushed: false, merged: false, deployed: false, ...obj }, null, 2) + "\n");
}

/**
 * Barcode count of the index already on disk, or null when there is none (bootstrap).
 * Prefers the tiny meta file over parsing the ~72MB index. Note that meta drifts behind
 * patch-style corpus commits (F2), so this can UNDERSTATE the real count -- which only
 * makes the guard more permissive, never less safe, and still catches a collapse.
 */
function priorBarcodeCount() {
  try {
    if (existsSync(OUT_META)) {
      const n = JSON.parse(readFileSync(OUT_META, "utf8")).barcode_index_count;
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch { /* fall through to the index itself */ }
  try {
    if (existsSync(OUT_JSON)) return Object.keys(JSON.parse(readFileSync(OUT_JSON, "utf8")).barcodeIndex ?? {}).length;
  } catch { /* unreadable prior index: treat as absent */ }
  return null;
}

function fail(reason, extra = {}) {
  console.error(`[build-tire-knowledge] FAIL-CLOSED: ${reason}`);
  writeStatus({ status: "failed", failure_reason: reason, ...extra });
  process.exit(1);
}

/** Pick the input snapshot, honoring the harvester boundary + lock heartbeat. Returns {path, label}|null. */
function pickSnapshot() {
  const lock = join(HARVEST_DIR, "harvest.lock");
  let harvesterActive = false;
  if (existsSync(lock)) {
    try { harvesterActive = (Date.now() - statSync(lock).mtimeMs) < 5 * 60 * 1000; } catch { harvesterActive = true; }
  }
  const stable = [];
  const ckRoot = join(HARVEST_DIR, "checkpoints");
  if (existsSync(ckRoot)) {
    const cks = readdirSync(ckRoot).filter((f) => /^checkpoint_\d+$/.test(f)).sort((a, b) => Number(b.split("_")[1]) - Number(a.split("_")[1]));
    for (const ck of cks) {
      const cand = [join(ckRoot, ck, `tire_corpus_flat_${ck}.csv`), join(ckRoot, ck, "tire_corpus_flat.csv")].find(existsSync);
      if (cand) { stable.push({ path: cand, label: `checkpoint:${ck}` }); break; }
    }
  }
  const cur = join(HARVEST_DIR, "outputs", "current", "tire_corpus_flat.csv");
  if (existsSync(cur)) stable.push({ path: cur, label: "outputs/current" });
  if (stable.length) return stable[0];

  const live = join(HARVEST_DIR, "tire_corpus_flat.csv");
  if (existsSync(live) && !harvesterActive) {
    try {
      const h1 = sha256(readFileSync(live)); const s1 = statSync(live).size;
      const start = Date.now(); while (Date.now() - start < 300) { /* brief settle before re-read */ }
      const h2 = sha256(readFileSync(live)); const s2 = statSync(live).size;
      if (h1 === h2 && s1 === s2) return { path: live, label: "live(stable)" };
    } catch { /* fall through */ }
  }
  if (existsSync(HARVEST_DIR) && harvesterActive) {
    fail("No stable tire knowledge snapshot available. Harvester is active. App index generation skipped.", { harvester_active: true });
  }
  if (existsSync(SEED)) return { path: SEED, label: "bootstrap_seed", seed: true };
  return null;
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const snap = pickSnapshot();
  if (!snap) fail("No snapshot and no committed seed found.");

  const buf = readFileSync(snap.path);
  const source_file_hash = sha256(buf);
  let records;
  try {
    records = parse(buf.toString("utf8"), { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true, bom: true });
  } catch (e) {
    fail(`CSV parse error: ${e.message}`, { source_snapshot_path: snap.path });
  }

  const rawHeaders = records.length ? Object.keys(records[0]) : [];
  const headers = remapHeaders(rawHeaders);
  records = records.map(remapCsvRecord);
  const missingCols = missingRequiredColumns(headers);
  if (records.length && missingCols.length) {
    fail(`Snapshot missing required columns: ${missingCols.join(", ")}`, { source_snapshot_path: snap.path, source_file_hash, headers });
  }

  const barcodeIndex = {}; const partNumberIndex = {}; const identityIndex = {};
  const skipReasons = {}; let trusted = 0; let skipped = 0;
  const skip = (why) => { skipReasons[why] = (skipReasons[why] ?? 0) + 1; skipped++; };

  for (const r of records) {
    const verdict = classifyRow(r);
    if (!verdict.ok) { skip(verdict.reason); continue; }
    const barcode = verdict.barcode;
    const row = {
      canonical_product_uid: r.canonical_product_uid || `${norm(r.brand)}|${norm(r.model)}|${norm(r.size)}`,
      brand: r.brand, brand_normalized: r.brand_normalized || norm(r.brand),
      model: r.model, model_normalized: r.model_normalized || norm(r.model),
      size: r.size, raw_size_text: r.raw_size_text || r.size,
      load_index: r.load_index || "", speed_rating: r.speed_rating || "", load_range: r.load_range || "",
      type: r.type || "", season: r.season || "",
      manufacturer_part_number: r.manufacturer_part_number || "",
      barcode, barcode_type: r.barcode_type || "",
      confidence: r.confidence, current_status: r.current_status, usable_for: r.usable_for,
      field_completeness_score: r.field_completeness_score || "", missing_fields: r.missing_fields || "",
      source_count: Number(r.source_count || 0),
    };
    if (barcodeIndex[barcode] && barcodeIndex[barcode].canonical_product_uid !== row.canonical_product_uid) { skip("barcode_conflict"); continue; }
    barcodeIndex[barcode] = row;
    trusted++;
    if (row.manufacturer_part_number) { const pk = normPart(row.manufacturer_part_number); if (pk && !partNumberIndex[pk]) partNumberIndex[pk] = row.canonical_product_uid; }
    const ik = `${row.brand_normalized}|${row.model_normalized}|${norm(row.size)}|${row.load_index}|${row.speed_rating}`;
    if (!identityIndex[ik]) identityIndex[ik] = row.canonical_product_uid;
  }

  const generated_at = new Date().toISOString();
  const meta = {
    schema_version: SCHEMA_VERSION, generated_at,
    source_snapshot_path: snap.path.replace(ROOT, "").replace(/\\/g, "/").replace(/^\//, ""),
    source_snapshot_label: snap.label, harvester_snapshot_used: !snap.seed,
    source_file_hash, source_row_count: records.length, trusted_rows_ingested: trusted,
    barcode_index_count: Object.keys(barcodeIndex).length, part_number_index_count: Object.keys(partNumberIndex).length,
    identity_index_count: Object.keys(identityIndex).length, size_alias_count: 0, brand_alias_count: 0, model_alias_count: 0,
    skipped_row_count: skipped, skip_reasons: skipReasons, generator_version: GENERATOR_VERSION, next_version: "16.2.9",
    ...gitInfo(),
  };
  const index = { schema_version: SCHEMA_VERSION, generated_at, barcodeIndex, partNumberIndex, identityIndex };

  // OUTPUT-SANITY GUARD (F1, 2026-08-12). Every check above validates the INPUT; none
  // validated the result. Snapshot precedence ends at the 2-row bootstrap seed, so on a
  // fresh clone, CI, or any box without harvester snapshots this generator would parse
  // that seed cleanly, pass every validation, and atomically overwrite the real
  // 79,108-barcode corpus with 2 records while reporting success. Refuse to shrink.
  const prior = priorBarcodeCount();
  if (prior !== null && meta.barcode_index_count < prior * MIN_RETAINED_FRACTION && !FORCE) {
    fail(
      `refusing to shrink the tire index: existing=${prior} barcodes, rebuild=${meta.barcode_index_count} ` +
      `(below ${Math.round(MIN_RETAINED_FRACTION * 100)}% of existing). Snapshot label was "${snap.label}". ` +
      `This usually means no harvester snapshot is present and the build fell through to the bootstrap seed. ` +
      `Pass --force only if you intend to replace the corpus.`,
      { source_snapshot_path: snap.path, snapshot_label: snap.label, existing_barcode_count: prior, rebuilt_barcode_count: meta.barcode_index_count },
    );
  }

  const tmpJson = OUT_JSON + ".tmp"; const tmpMeta = OUT_META + ".tmp";
  writeFileSync(tmpJson, JSON.stringify(index)); writeFileSync(tmpMeta, JSON.stringify(meta, null, 2) + "\n");
  JSON.parse(readFileSync(tmpJson)); JSON.parse(readFileSync(tmpMeta)); // validate parseable
  renameSync(tmpJson, OUT_JSON); renameSync(tmpMeta, OUT_META);

  writeStatus({
    status: "success", source_snapshot_path: meta.source_snapshot_path, source_file_hash, generated_at,
    harvester_snapshot_used: meta.harvester_snapshot_used, snapshot_label: snap.label,
    trusted_rows_ingested: trusted, barcode_index_count: meta.barcode_index_count, part_number_index_count: meta.part_number_index_count,
    identity_index_count: meta.identity_index_count, alias_count: 0, schema_version: SCHEMA_VERSION,
    skipped_row_count: skipped, skip_reasons: skipReasons,
  });
  console.log(`[build-tire-knowledge] OK label=${snap.label} trusted=${trusted} barcodes=${meta.barcode_index_count} partNumbers=${meta.part_number_index_count} skipped=${skipped}`);
}

main();
