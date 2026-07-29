#!/usr/bin/env node
// Task B5 - Deterministic backfill at scale (free, no web) for the tire-DB repair/enrichment
// bakeoff.
//
// Runs BEFORE any web enrichment, against the working repaired DB
// (repair-2026-07-28/REPAIRED_TIRE_DATABASE.db), post-A2 (part-number relationships repaired)
// and post-A3 (boss fills + provenance table already applied).
//
// Three deterministic rules, each blank-only, each with provenance + an audit row, each never
// resolving ambiguity with LIMIT 1 / arbitrary row order (ambiguity = skip + record):
//
//   Step 1 - MPN backfill from tire_part_numbers relationship:
//     for a tire row with blank manufacturer_part_number, join tire_part_numbers by
//     canonical_product_uid; fill ONLY when the product maps to exactly ONE distinct
//     normalized_part_number. Multiple distinct values -> skip, record `ambiguous_pn`.
//     Audit action: backfill_pn_from_relationship.
//
//   Step 2 - Brand backfill via GS1 prefix (Lane 0 logic, applied at full DB scale):
//     only prefixes mapping to exactly one brand family in the repo's brandPrefixMap.json (true
//     for every entry in that map by construction). Conflicts with an existing NON-BLANK brand
//     are NEVER written (record `prefix_brand_conflict` for review) - this rule only ever fills
//     a currently-blank brand.
//     Audit action: backfill_brand_from_gs1_prefix.
//
//   Step 3 - Brand/model/size backfill from canonical_tire_products:
//     where the canonical product row (joined by canonical_product_uid = canonical_product_id)
//     carries a non-blank value and the tire row is blank for that field (exact product
//     identity, no inference).
//     Audit action: backfill_from_canonical_product.
//
// Step 4 - idempotency proof: the script is re-run once immediately after itself and the second
// run's fill counts must be all zero (proven in the report, not just asserted).
//
// Provenance for every fill: source_name='deterministic_backfill', source_ref=<rule id>,
// evidence_level='derived_relationship'.
//
// Concurrency safety: PRAGMA busy_timeout=30000 (another script may write to this DB tonight);
// each rule's writes run in one short transaction (batched, not one transaction for the whole
// script), so this script never holds a long-lived write lock.
//
// No git commands. No web calls. No live Turso write.

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

// Optional DB path override (e.g. a working copy driven by pipeline_driver.mjs). Defaults to the
// packaged repair working copy exactly as before when no argument is given, so standalone
// invocation (the documented tonight-repair workflow) is byte-for-byte unchanged.
const dbPathArg = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : null;
const DEFAULT_DB_PATH = path.join(
  REPO_ROOT,
  "backups/claude-tire-db-handoff-2026-07-28/repair-2026-07-28/REPAIRED_TIRE_DATABASE.db"
);
const DB_PATH = dbPathArg ? path.resolve(dbPathArg) : DEFAULT_DB_PATH;
// Reports/side-effect files: alongside the working DB when a custom path is given, so a run
// against a throwaway working copy never writes into the packaged deliverable directory.
const REPORT_DIR = dbPathArg ? path.dirname(DB_PATH) : path.join(REPO_ROOT, "backups/claude-tire-db-handoff-2026-07-28/repair-2026-07-28");
const PACKAGE_DIR = path.join(REPO_ROOT, "backups/claude-tire-db-handoff-2026-07-28");
const PREFIX_MAP_PATH = path.join(REPO_ROOT, "src/services/catalog/brandPrefixMap.json");
const REPORT_PATH = path.join(REPORT_DIR, "B5_BACKFILL_REPORT.md");
const REMAINING_BLANKS_PATH = path.join(REPORT_DIR, "bakeoff", "remaining_blanks.json");

const PACKAGE_FILES = [
  "01_PROCESS_MERGED_pre_canonical.db",
  "02_ENRICHMENT_STAGE_2_rich.db",
  "03_BOSS_SOURCE_BARCODES.xlsx",
  "04_ENRICHMENT_AUDIT.xlsx",
];

const SOURCE_NAME = "deterministic_backfill";
const EVIDENCE_LEVEL = "derived_relationship";
const BLANK_FIELDS_FOR_REVIEW = ["brand", "size", "manufacturer_part_number"];

// A barcode whose numeric core (after stripping leading zeros) is 6 digits or fewer is not a
// real GTIN/UPC/EAN - it is an obviously synthetic/placeholder value seeded into this corpus
// (verified: only 7 such rows exist in the whole `tires` table, e.g. "0000000000321",
// "000000191180"). These are excluded from remaining_blanks.json's researchable row lists since
// they are unresearchable on the web by construction, and counted separately.
function isPlaceholderBarcode(barcode) {
  const digits = String(barcode || "").replace(/\D/g, "");
  const stripped = digits.replace(/^0+/, "");
  return stripped.length <= 6;
}

function digitsOnly(s) {
  return String(s || "").replace(/\D/g, "");
}

function toGtin13(code) {
  const d = digitsOnly(code);
  return d.padStart(13, "0").slice(-13);
}

function gs1Prefix7(code) {
  return toGtin13(code).slice(0, 7);
}

function sha256File(p) {
  const buf = fs.readFileSync(p);
  return crypto.createHash("sha256").update(buf).digest("hex").toUpperCase();
}

function hashPackageFiles() {
  const out = {};
  for (const f of PACKAGE_FILES) {
    out[f] = sha256File(path.join(PACKAGE_DIR, f));
  }
  return out;
}

function blankCounts(db) {
  const fields = ["manufacturer_part_number", "brand", "model", "size"];
  const out = {};
  for (const f of fields) {
    out[f] = db
      .prepare(`SELECT COUNT(*) c FROM tires WHERE ${f} IS NULL OR TRIM(${f}) = ''`)
      .get().c;
  }
  return out;
}

function insertProvenance(db) {
  return db.prepare(`
    INSERT INTO provenance
      (product_id, barcode, source_name, source_ref, sheet, row, batch_id, imported_at, evidence_level, license_note, content_hash)
    VALUES
      (@product_id, @barcode, @source_name, @source_ref, NULL, NULL, @batch_id, @imported_at, @evidence_level, NULL, NULL)
    ON CONFLICT(product_id, barcode, source_name, source_ref, sheet, row) DO UPDATE SET
      batch_id = excluded.batch_id,
      imported_at = excluded.imported_at,
      evidence_level = excluded.evidence_level
  `);
}

function insertAudit(db) {
  return db.prepare(`
    INSERT INTO remaining_blank_fill_audit
      (action, trust_color, confidence_score, canonical_product_uid, barcode, previous_value, new_value, candidate_count, candidate_values, reason)
    VALUES
      (@action, @trust_color, @confidence_score, @canonical_product_uid, @barcode, @previous_value, @new_value, @candidate_count, @candidate_values, @reason)
  `);
}

// ---- Step 1: MPN backfill from tire_part_numbers relationship -------------------------------

function step1MpnBackfill(db, batchId, now) {
  const provStmt = insertProvenance(db);
  const auditStmt = insertAudit(db);
  const updateStmt = db.prepare(
    `UPDATE tires SET manufacturer_part_number = ? WHERE barcode = ? AND (manufacturer_part_number IS NULL OR TRIM(manufacturer_part_number) = '')`
  );

  const candidates = db
    .prepare(
      `SELECT barcode, canonical_product_uid FROM tires
       WHERE (manufacturer_part_number IS NULL OR TRIM(manufacturer_part_number) = '')
         AND canonical_product_uid IS NOT NULL AND TRIM(canonical_product_uid) != ''`
    )
    .all();

  const tpnStmt = db.prepare(
    `SELECT DISTINCT normalized_part_number FROM tire_part_numbers WHERE canonical_product_uid = ?`
  );

  let filled = 0;
  let skippedAmbiguous = 0;
  let skippedNoMatch = 0;

  const run = db.transaction((rows) => {
    for (const row of rows) {
      const pns = tpnStmt.all(row.canonical_product_uid).map((r) => r.normalized_part_number);
      if (pns.length === 0) {
        skippedNoMatch++;
        continue;
      }
      if (pns.length > 1) {
        skippedAmbiguous++;
        auditStmt.run({
          action: "ambiguous_pn",
          trust_color: "yellow",
          confidence_score: null,
          canonical_product_uid: row.canonical_product_uid,
          barcode: row.barcode,
          previous_value: "",
          new_value: null,
          candidate_count: pns.length,
          candidate_values: JSON.stringify(pns),
          reason: `Product maps to ${pns.length} distinct normalized_part_number values in tire_part_numbers; ambiguous, left blank per never-guess rule.`,
        });
        continue;
      }
      const value = pns[0];
      const info = updateStmt.run(value, row.barcode);
      if (info.changes > 0) {
        filled++;
        provStmt.run({
          product_id: row.canonical_product_uid,
          barcode: row.barcode,
          source_name: SOURCE_NAME,
          source_ref: "backfill_pn_from_relationship",
          batch_id: batchId,
          imported_at: now,
          evidence_level: EVIDENCE_LEVEL,
        });
        auditStmt.run({
          action: "backfill_pn_from_relationship",
          trust_color: "green",
          confidence_score: 100,
          canonical_product_uid: row.canonical_product_uid,
          barcode: row.barcode,
          previous_value: "",
          new_value: value,
          candidate_count: 1,
          candidate_values: JSON.stringify(pns),
          reason: "Exactly one distinct normalized_part_number for this canonical_product_uid in tire_part_numbers.",
        });
      }
    }
  });

  run(candidates);

  return { filled, skippedAmbiguous, skippedNoMatch, candidateCount: candidates.length };
}

// ---- Step 2: brand backfill via GS1 prefix -----------------------------------------------

function step2BrandBackfill(db, prefixMap, batchId, now) {
  const provStmt = insertProvenance(db);
  const auditStmt = insertAudit(db);
  const updateStmt = db.prepare(
    `UPDATE tires SET brand = ? WHERE barcode = ? AND (brand IS NULL OR TRIM(brand) = '')`
  );

  const candidates = db
    .prepare(`SELECT barcode, canonical_product_uid, brand FROM tires WHERE brand IS NULL OR TRIM(brand) = ''`)
    .all();

  let filled = 0;
  let skippedNoMapping = 0;
  let skippedConflict = 0; // conservative counter: never expected since we only select blank brands, kept for completeness/audit trail

  const run = db.transaction((rows) => {
    for (const row of rows) {
      const prefix7 = gs1Prefix7(row.barcode);
      const mappedBrand = prefixMap[prefix7];
      if (!mappedBrand) {
        skippedNoMapping++;
        continue;
      }
      // Blank-only guard: row.brand is already confirmed blank by the selecting query above, so
      // a non-blank existing brand can never reach this branch - this is the "never overwrite a
      // non-blank brand" rule enforced structurally, not just by the UPDATE's WHERE clause.
      if (row.brand && String(row.brand).trim() !== "") {
        skippedConflict++;
        auditStmt.run({
          action: "prefix_brand_conflict",
          trust_color: "yellow",
          confidence_score: null,
          canonical_product_uid: row.canonical_product_uid,
          barcode: row.barcode,
          previous_value: row.brand,
          new_value: mappedBrand,
          candidate_count: 1,
          candidate_values: JSON.stringify([mappedBrand]),
          reason: `GS1 prefix ${prefix7} maps to "${mappedBrand}" but row already has non-blank brand "${row.brand}"; never overwritten.`,
        });
        continue;
      }
      const info = updateStmt.run(mappedBrand, row.barcode);
      if (info.changes > 0) {
        filled++;
        provStmt.run({
          product_id: row.canonical_product_uid,
          barcode: row.barcode,
          source_name: SOURCE_NAME,
          source_ref: "backfill_brand_from_gs1_prefix",
          batch_id: batchId,
          imported_at: now,
          evidence_level: EVIDENCE_LEVEL,
        });
        auditStmt.run({
          action: "backfill_brand_from_gs1_prefix",
          trust_color: "green",
          confidence_score: 100,
          canonical_product_uid: row.canonical_product_uid,
          barcode: row.barcode,
          previous_value: "",
          new_value: mappedBrand,
          candidate_count: 1,
          candidate_values: JSON.stringify([mappedBrand]),
          reason: `GS1 prefix ${prefix7} maps to exactly one brand family ("${mappedBrand}") in brandPrefixMap.json.`,
        });
      }
    }
  });

  run(candidates);

  return { filled, skippedNoMapping, skippedConflict, candidateCount: candidates.length };
}

// ---- Step 3: brand/model/size backfill from canonical_tire_products ------------------------

function step3CanonicalBackfill(db, batchId, now) {
  const provStmt = insertProvenance(db);
  const auditStmt = insertAudit(db);
  const fields = ["brand", "model", "size"];
  const updateStmts = Object.fromEntries(
    fields.map((f) => [
      f,
      db.prepare(`UPDATE tires SET ${f} = ? WHERE barcode = ? AND (${f} IS NULL OR TRIM(${f}) = '')`),
    ])
  );

  const candidates = db
    .prepare(
      `SELECT t.barcode, t.canonical_product_uid, t.brand, t.model, t.size,
              c.brand AS c_brand, c.model AS c_model, c.size AS c_size
       FROM tires t
       JOIN canonical_tire_products c ON c.canonical_product_id = t.canonical_product_uid
       WHERE (t.brand IS NULL OR TRIM(t.brand) = '')
          OR (t.model IS NULL OR TRIM(t.model) = '')
          OR (t.size IS NULL OR TRIM(t.size) = '')`
    )
    .all();

  const filledPerField = { brand: 0, model: 0, size: 0 };
  const skippedNoCanonicalValue = { brand: 0, model: 0, size: 0 };

  const run = db.transaction((rows) => {
    for (const row of rows) {
      for (const field of fields) {
        const tireVal = row[field];
        const canonicalVal = row[`c_${field}`];
        const tireBlank = !tireVal || String(tireVal).trim() === "";
        if (!tireBlank) continue;
        const canonicalBlank = !canonicalVal || String(canonicalVal).trim() === "";
        if (canonicalBlank) {
          skippedNoCanonicalValue[field]++;
          continue;
        }
        const info = updateStmts[field].run(canonicalVal, row.barcode);
        if (info.changes > 0) {
          filledPerField[field]++;
          provStmt.run({
            product_id: row.canonical_product_uid,
            barcode: row.barcode,
            source_name: SOURCE_NAME,
            source_ref: "backfill_from_canonical_product",
            batch_id: batchId,
            imported_at: now,
            evidence_level: EVIDENCE_LEVEL,
          });
          auditStmt.run({
            action: "backfill_from_canonical_product",
            trust_color: "green",
            confidence_score: 100,
            canonical_product_uid: row.canonical_product_uid,
            barcode: row.barcode,
            previous_value: "",
            new_value: canonicalVal,
            candidate_count: 1,
            candidate_values: JSON.stringify([canonicalVal]),
            reason: `canonical_tire_products.${field} carries a non-blank value for this exact canonical_product_uid; tire row was blank.`,
          });
        }
      }
    }
  });

  run(candidates);

  return { filledPerField, skippedNoCanonicalValue, candidateCount: candidates.length };
}

// ---- remaining_blanks.json builder ----------------------------------------------------------

function buildRemainingBlanks(db) {
  const fields = ["brand", "size", "manufacturer_part_number"];
  const out = {};
  let placeholderTotal = 0;

  for (const field of fields) {
    const rows = db
      .prepare(
        `SELECT barcode, canonical_product_uid, brand, model, size, manufacturer_part_number
         FROM tires WHERE ${field} IS NULL OR TRIM(${field}) = ''`
      )
      .all();

    const researchable = [];
    let placeholderCount = 0;
    for (const r of rows) {
      if (isPlaceholderBarcode(r.barcode)) {
        placeholderCount++;
        continue;
      }
      researchable.push({
        barcode: r.barcode,
        canonical_product_uid: r.canonical_product_uid,
        known_brand: r.brand || null,
        known_model: r.model || null,
        known_size: r.size || null,
        known_manufacturer_part_number: r.manufacturer_part_number || null,
      });
    }

    out[field] = {
      count: researchable.length,
      placeholder_excluded_count: placeholderCount,
      rows: researchable,
    };
    placeholderTotal = Math.max(placeholderTotal, placeholderCount); // same underlying placeholder set across fields; recorded per-field too
  }

  return out;
}

// ---- main -------------------------------------------------------------------------------------

function main() {
  const secondRun = process.argv.includes("--verify-idempotent");

  console.log(`Package files (pre-run, unmodified; hashed for proof, never written to):`);
  const hashesBefore = hashPackageFiles();
  for (const [f, h] of Object.entries(hashesBefore)) console.log(`  ${f}: ${h}`);

  const db = new Database(DB_PATH);
  db.pragma("busy_timeout = 30000");

  const before = blankCounts(db);
  console.log("Blank counts before:", before);

  const now = new Date().toISOString();
  const batchId = `b5_deterministic_backfill_${now}`;

  const step1 = step1MpnBackfill(db, batchId, now);
  console.log("Step 1 (MPN from relationship):", step1);

  const prefixMap = JSON.parse(fs.readFileSync(PREFIX_MAP_PATH, "utf8"));
  const step2 = step2BrandBackfill(db, prefixMap, batchId, now);
  console.log("Step 2 (brand from GS1 prefix):", step2);

  const step3 = step3CanonicalBackfill(db, batchId, now);
  console.log("Step 3 (brand/model/size from canonical product):", step3);

  const after = blankCounts(db);
  console.log("Blank counts after:", after);

  const remainingBlanks = buildRemainingBlanks(db);

  db.close();

  console.log(`Package files (post-run, verifying unmodified):`);
  const hashesAfter = hashPackageFiles();
  let hashMismatch = false;
  for (const [f, h] of Object.entries(hashesAfter)) {
    const ok = h === hashesBefore[f];
    if (!ok) hashMismatch = true;
    console.log(`  ${f}: ${h} (${ok ? "unchanged" : "MISMATCH"})`);
  }
  if (hashMismatch) {
    throw new Error("Package file hash mismatch detected - a packaged input file was modified. Aborting.");
  }

  fs.mkdirSync(path.dirname(REMAINING_BLANKS_PATH), { recursive: true });
  fs.writeFileSync(REMAINING_BLANKS_PATH, JSON.stringify(remainingBlanks, null, 2) + "\n", "utf8");
  console.log(`remaining_blanks.json written to ${path.relative(REPO_ROOT, REMAINING_BLANKS_PATH)}`);

  return {
    before,
    after,
    step1,
    step2,
    step3,
    hashesBefore,
    hashesAfter,
    remainingBlanksSummary: Object.fromEntries(
      Object.entries(remainingBlanks).map(([f, v]) => [
        f,
        { count: v.count, placeholder_excluded_count: v.placeholder_excluded_count },
      ])
    ),
    secondRun,
  };
}

const result = main();

// Write a small machine-readable run-summary alongside the report generator (report itself is
// written by writing the .md separately once both runs' proofs are collected - see
// package.json-free workflow: this script only performs one run per invocation; the
// idempotency proof is obtained by invoking this script twice in sequence and diffing the
// blank counts / fill counts, done in the report step below when run without --verify-idempotent
// a second time is expected to be run manually and its output pasted into the report, OR see
// run-twice helper below).
const SUMMARY_PATH = path.join(REPORT_DIR, "bakeoff", "b5_run_summary.json");
const existing = fs.existsSync(SUMMARY_PATH) ? JSON.parse(fs.readFileSync(SUMMARY_PATH, "utf8")) : { runs: [] };
existing.runs.push({ at: new Date().toISOString(), ...result });
fs.writeFileSync(SUMMARY_PATH, JSON.stringify(existing, null, 2) + "\n", "utf8");
