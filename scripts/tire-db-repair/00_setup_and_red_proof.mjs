#!/usr/bin/env node
// Task A1: working copy + hash record + RED proof for the tire-db repair.
//
// Reads the packaged rich database from backups/claude-tire-db-handoff-2026-07-28/, verifies its
// SHA-256 against the values recorded in CLAUDE_HANDOFF.md, copies it to a disposable working copy
// (never touching the packaged inputs), and records the RED (broken) state of the
// tire_part_numbers -> tires relationship before any repair.
//
// Usage: node scripts/tire-db-repair/00_setup_and_red_proof.mjs [dbPath] [--force]
//   dbPath  - optional; defaults to the working-copy path this script creates
//             (repair-2026-07-28/REPAIRED_TIRE_DATABASE.db). Later repair scripts in this folder
//             take the DB path as argv[2] the same way (the `openDb(path)` convention).
//   --force - overwrite the working copy even if it already exists (default: idempotent skip).

import { createHash } from "node:crypto";
import { createReadStream, existsSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const PACKAGE_DIR = join(REPO_ROOT, "backups", "claude-tire-db-handoff-2026-07-28");
const OUTPUT_DIR = join(PACKAGE_DIR, "repair-2026-07-28");

const RICH_DB_SRC = join(PACKAGE_DIR, "02_ENRICHMENT_STAGE_2_rich.db");
const WORKING_DB_DEFAULT = join(OUTPUT_DIR, "REPAIRED_TIRE_DATABASE.db");
const HASHES_OUT = join(OUTPUT_DIR, "HASHES_BEFORE.txt");
const RED_PROOF_OUT = join(OUTPUT_DIR, "RED_PROOF.md");

// Expected SHA-256 values verbatim from CLAUDE_HANDOFF.md ("Packaged files" table).
const EXPECTED_HASHES = {
  "01_PROCESS_MERGED_pre_canonical.db": "ACE184054C8D23C128EA6642D751BA4EA1D76C4043720BA97EEE6C92C816C227",
  "02_ENRICHMENT_STAGE_2_rich.db": "1AF5153AF0933E1832B4CC92B0270850D99CE382ED242C534FC16E3855783725",
  "03_BOSS_SOURCE_BARCODES.xlsx": "AA0AA341B674AF3898E02B8BAA0F2F6587DF18110C677ACFC86845F731FA2404",
  "04_ENRICHMENT_AUDIT.xlsx": "6A07D18FF6B673C23699058C60E45F0B131E76E88E2ED3B97E1D317B7CCBF065",
};

// The runtime part-number lookup convention every later script follows: argv[2] is the DB path,
// defaulting to the working copy this script produces.
const dbPathArg = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : null;
const FORCE = process.argv.includes("--force");
const workingDbPath = dbPathArg ?? WORKING_DB_DEFAULT;

function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex").toUpperCase()));
    stream.on("error", reject);
  });
}

// Mirrors tireKnowledgeIndex.ts normBarcodeKey/normPartKey and tirePartNumber.ts
// basePartNumberKey/tirePartNumberCore, expressed as SQL so RED-proof queries use the identical
// runtime resolution semantics (documented in RED_PROOF.md).
//   normPartKey(pn)         = strip spaces/hyphens, trim, uppercase   -> "base" key
//   tirePartNumberCore(pn)  = base key matched against ^[A-Z]{0,5}(\d{5,})[A-Z]{0,3}$, numeric group
//                             only when it differs from the base (distributor-affix core)
//   Runtime order: try base key first (getStmtPartNumber uses
//   UPPER(REPLACE(REPLACE(pn,' ',''),'-','')) = ?), then the affix-core variant if it differs.
//   lookupByExactPartNumber() then resolves the hit's canonical_product_uid against `tires`
//   (SQLite path: `SELECT * FROM tires WHERE ... manufacturer_part_number ... = ?`), but the
//   corpus-side runtime path used by tireKnowledgeIndex for a PART NUMBER SCAN not already stored on
//   `tires.manufacturer_part_number` is the two-step Turso-style resolution documented in
//   lookupPartNumberTurso: tire_part_numbers.normalized_part_number -> canonical_product_uid ->
//   tires.canonical_product_uid. That two-step join is exactly what the RED proof below exercises.

async function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  // --- Step 1: hash verification -------------------------------------------------------------
  const hashLines = [];
  let anyMismatch = false;
  for (const [file, expected] of Object.entries(EXPECTED_HASHES)) {
    const filePath = join(PACKAGE_DIR, file);
    if (!existsSync(filePath)) {
      hashLines.push(`${file}: MISSING`);
      anyMismatch = true;
      continue;
    }
    const actual = await sha256File(filePath);
    const match = actual === expected;
    if (!match) anyMismatch = true;
    hashLines.push(`${file}: ${actual} (expected ${expected}) ${match ? "OK" : "MISMATCH"}`);
  }
  writeFileSync(HASHES_OUT, hashLines.join("\n") + "\n", "utf8");
  console.log("Wrote", HASHES_OUT);
  for (const line of hashLines) console.log(" ", line);

  if (anyMismatch) {
    console.error("\nFATAL: packaged file hash mismatch against CLAUDE_HANDOFF.md. Aborting.");
    process.exit(1);
  }

  // --- Step 2: idempotent working copy --------------------------------------------------------
  if (existsSync(workingDbPath) && !FORCE) {
    console.log(`Working copy already exists at ${workingDbPath} (skip; pass --force to overwrite).`);
  } else {
    copyFileSync(RICH_DB_SRC, workingDbPath);
    console.log(`Copied ${RICH_DB_SRC} -> ${workingDbPath}`);
  }

  // Re-verify the packaged source file's hash did not change as a side effect of the copy.
  const postCopyHash = await sha256File(RICH_DB_SRC);
  if (postCopyHash !== EXPECTED_HASHES["02_ENRICHMENT_STAGE_2_rich.db"]) {
    console.error("FATAL: packaged rich DB hash changed after copy operation. Aborting.");
    process.exit(1);
  }

  // --- Step 3: RED proof queries -------------------------------------------------------------
  const db = new Database(workingDbPath, { readonly: true });

  const integrityCheck = db.pragma("integrity_check", { simple: true });

  const counts = {};
  for (const table of [
    "tires",
    "tire_part_numbers",
    "tire_barcode_aliases",
    "canonical_tire_products",
    "stage2_enrichment_audit",
    "tire_product_part_number_aliases",
  ]) {
    counts[table] = db.prepare(`SELECT count(*) c FROM ${table}`).get().c;
  }

  const joinToTires = db
    .prepare(
      "SELECT count(*) c FROM tire_part_numbers p JOIN tires t ON t.canonical_product_uid = p.canonical_product_uid",
    )
    .get().c;

  const joinToCanonicalProducts = db
    .prepare(
      "SELECT count(*) c FROM tire_part_numbers p JOIN canonical_tire_products c ON c.canonical_product_id = p.canonical_product_uid",
    )
    .get().c;

  // 20 sample part-number lookups: 4 per boss brand (Nexen, Arisun, Blackhawk, Fortune, Falken),
  // selected deterministically (ORDER BY normalized_part_number) from real corpus rows whose
  // canonical_product_uid slug starts with the brand name. Each lookup replicates the runtime
  // two-step resolution (tire_part_numbers -> canonical_product_uid -> tires) using the normalized
  // key exactly as normPartKey()/tirePartNumberCore() would produce it (values are already stored
  // normalized in this table, so no further transform is applied to the key itself).
  const BOSS_BRANDS = ["nexen", "arisun", "blackhawk", "fortune", "falken"];
  const sampleStmt = db.prepare(
    "SELECT normalized_part_number, canonical_product_uid FROM tire_part_numbers WHERE canonical_product_uid LIKE ? ORDER BY normalized_part_number LIMIT 4",
  );
  const resolveStmt = db.prepare("SELECT * FROM tires WHERE canonical_product_uid = ?");

  const sampleResults = [];
  for (const brand of BOSS_BRANDS) {
    const rows = sampleStmt.all(`${brand}_%`);
    for (const row of rows) {
      const resolved = resolveStmt.get(row.canonical_product_uid);
      sampleResults.push({
        brand,
        normalized_part_number: row.normalized_part_number,
        canonical_product_uid: row.canonical_product_uid,
        resolvedTire: resolved ? "HIT" : "MISS (RED)",
      });
    }
  }

  db.close();

  const totalSamples = sampleResults.length;
  const redSamples = sampleResults.filter((s) => s.resolvedTire.startsWith("MISS")).length;

  const reportLines = [];
  reportLines.push("# RED_PROOF.md - tire-db-repair Task A1");
  reportLines.push("");
  reportLines.push(`Generated by scripts/tire-db-repair/00_setup_and_red_proof.mjs against the disposable working copy at \`${workingDbPath.replace(REPO_ROOT + "\\", "").replace(/\\/g, "/")}\`.`);
  reportLines.push("");
  reportLines.push("## Runtime semantics replicated");
  reportLines.push("");
  reportLines.push("Read from `src/decoding/server/knowledge/tire/tireKnowledgeIndex.ts` and `src/products/catalog/tirePartNumber.ts`:");
  reportLines.push("");
  reportLines.push("- `normPartKey(pn)`: strip spaces/hyphens, trim, uppercase (tireKnowledgeIndex.ts:41-43). Values already stored in `tire_part_numbers.normalized_part_number` are pre-normalized to this key, so the sample queries below use the stored key directly (no further transform needed).");
  reportLines.push("- `basePartNumberKey` / `tirePartNumberCore` (tirePartNumber.ts): the affix-core variant matches `^[A-Z]{0,5}(\\d{5,})[A-Z]{0,3}$` and is only used as a fallback key when it differs from the base key; not needed here since we query the exact stored normalized key.");
  reportLines.push("- `lookupPartNumberTurso` (tireKnowledgeIndex.ts:194-215) is the two-step runtime resolution this RED proof reproduces in SQL: `tire_part_numbers.normalized_part_number -> canonical_product_uid`, then `tires WHERE canonical_product_uid = ?`. This is the exact join whose 0-of-29173 failure is the release blocker.");
  reportLines.push("");
  reportLines.push("## PRAGMA integrity_check");
  reportLines.push("");
  reportLines.push("```");
  reportLines.push(String(integrityCheck));
  reportLines.push("```");
  reportLines.push("");
  reportLines.push("## Baseline table counts");
  reportLines.push("");
  reportLines.push("| Table | Count | Expected (handoff) |");
  reportLines.push("|---|---:|---:|");
  reportLines.push(`| tires | ${counts.tires} | 82640 |`);
  reportLines.push(`| tire_part_numbers | ${counts.tire_part_numbers} | 29173 |`);
  reportLines.push(`| tire_barcode_aliases | ${counts.tire_barcode_aliases} | 82640 |`);
  reportLines.push(`| canonical_tire_products | ${counts.canonical_tire_products} | (79802 stable products per handoff) |`);
  reportLines.push(`| stage2_enrichment_audit | ${counts.stage2_enrichment_audit} | 0 |`);
  reportLines.push(`| tire_product_part_number_aliases | ${counts.tire_product_part_number_aliases} | 0 |`);
  reportLines.push("");
  reportLines.push("## THE broken join (release blocker)");
  reportLines.push("");
  reportLines.push("```sql");
  reportLines.push("SELECT count(*) FROM tire_part_numbers p JOIN tires t ON t.canonical_product_uid = p.canonical_product_uid");
  reportLines.push("```");
  reportLines.push("");
  reportLines.push(`Result: **${joinToTires} of ${counts.tire_part_numbers}** part-number rows join to a current tire. Expected 0 (RED). ${joinToTires === 0 ? "CONFIRMED RED." : "UNEXPECTED - join is not fully broken."}`);
  reportLines.push("");
  reportLines.push("Same join against `canonical_tire_products`:");
  reportLines.push("");
  reportLines.push("```sql");
  reportLines.push("SELECT count(*) FROM tire_part_numbers p JOIN canonical_tire_products c ON c.canonical_product_id = p.canonical_product_uid");
  reportLines.push("```");
  reportLines.push("");
  reportLines.push(`Result: **${joinToCanonicalProducts} of ${counts.tire_part_numbers}**. Expected 0 (RED). ${joinToCanonicalProducts === 0 ? "CONFIRMED RED." : "UNEXPECTED - join is not fully broken."}`);
  reportLines.push("");
  reportLines.push("## 20 sample runtime part-number lookups (4 per boss brand)");
  reportLines.push("");
  reportLines.push("Each row: `tire_part_numbers` value as stored, resolved via the runtime two-step join against `tires.canonical_product_uid`. All must MISS (RED) before repair.");
  reportLines.push("");
  reportLines.push("| Brand | normalized_part_number | canonical_product_uid (old slug) | Runtime resolve result |");
  reportLines.push("|---|---|---|---|");
  for (const s of sampleResults) {
    reportLines.push(`| ${s.brand} | ${s.normalized_part_number} | ${s.canonical_product_uid} | ${s.resolvedTire} |`);
  }
  reportLines.push("");
  reportLines.push(`**Summary: ${redSamples} of ${totalSamples} sample lookups MISS (RED).** ${redSamples === totalSamples ? "All samples confirmed RED as required." : "WARNING: not all samples are RED - investigate before proceeding to repair."}`);
  reportLines.push("");
  reportLines.push("## Overall RED-proof verdict");
  reportLines.push("");
  const overallRed = joinToTires === 0 && joinToCanonicalProducts === 0 && redSamples === totalSamples && String(integrityCheck) === "ok";
  reportLines.push(overallRed
    ? `CONFIRMED: 0 of ${counts.tire_part_numbers} part-number rows resolve through the runtime join; the release blocker described in CLAUDE_HANDOFF.md is reproduced on this disposable working copy.`
    : "WARNING: RED proof did not fully reproduce the expected broken state - see details above before starting repair.");
  reportLines.push("");

  writeFileSync(RED_PROOF_OUT, reportLines.join("\n"), "utf8");
  console.log("Wrote", RED_PROOF_OUT);
  console.log(`\nRED proof: ${joinToTires}/${counts.tire_part_numbers} joined to tires; ${redSamples}/${totalSamples} sample lookups MISS.`);

  if (!overallRed) {
    console.error("\nWARNING: RED proof did not fully match the expected broken state. Review RED_PROOF.md.");
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
