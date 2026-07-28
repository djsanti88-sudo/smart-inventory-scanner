#!/usr/bin/env node
// Task A5: provenance backfill + source_count repair + stage2_enrichment_audit population.
//
// Consumes: the repaired working DB after A2 (part-number UID repair), A3 (boss reconciliation,
// which OWNS and creates the `provenance` table), A4 (part-number alias table), and B5
// (deterministic backfill). Those tasks already wrote provenance rows tagged `boss_source` (A3) and
// `deterministic_backfill` (B5). This task:
//
//   1. Backfills provenance for additional KNOWN origins identifiable from `process_merge_audit`
//      lineage - the boss-workbook import events (`insert_part_number_alias`,
//      `fill_missing_part_number`, `confirmed_existing_part_number`, all trust_color='green') that
//      tie a barcode to a resolvable `tires` row but are not yet represented in `provenance`. Tagged
//      `source_name='process_merge_import'`, `evidence_level='import_audit'` (weaker than
//      `boss_source`'s direct-reconciliation evidence, per the brief's stated evidence ranking
//      boss_source > import_audit > unknown). UPSERTed on the existing UNIQUE constraint so a
//      barcode already covered by `boss_source`/`deterministic_backfill` simply gains an additional
//      distinct provenance row (a barcode CAN have more than one corroborating source - that is what
//      source_count measures), never a duplicate of the same (product_id, barcode, source_name,
//      source_ref, sheet, row) tuple.
//   2. Derives `tires.source_count` from a live COUNT(*) over `provenance` per barcode, taken AT THE
//      END of this script's run and timestamped (another script - B6 - may be concurrently adding
//      `web_trusted_single_source` rows tonight; A6's validator re-derives this independently later,
//      so this script's number is honest for its own timestamp, not a promise of finality).
//   3. Writes PROVENANCE_GAPS.csv: every tires.barcode with source_count = 0 at that same moment -
//      an honest, un-fabricated gap measurement (expected: tens of thousands, since only boss-source,
//      deterministic-backfill, and now import-audit rows exist at this point in the pipeline).
//   4. Populates `stage2_enrichment_audit` (currently empty - the brief's Interfaces line names it as
//      an A5 output) with ONE row per repair-batch action (A2 migration, A3 fills, A4 aliases, B5
//      backfill), using counts read from each task's own report plus a live re-check against the DB
//      where the audit trail allows it, so this row is idempotent and does not silently drift from
//      the actual data if re-run after further repair.
//
// Idempotent: process_merge_import backfill is an UPSERT keyed on the provenance UNIQUE constraint;
// source_count is a pure re-derivation (deterministic given whatever provenance rows exist at run
// time); PROVENANCE_GAPS.csv is fully rewritten each run (not appended); stage2_enrichment_audit rows
// are cleared and rewritten for this script's own batch-summary rows only (matched by a fixed
// `action` value per batch), never duplicated on a second run.
//
// Concurrency safety: PRAGMA busy_timeout=30000 (B6 may be writing web_trusted_single_source rows to
// this same DB concurrently); every write happens inside short, independent transactions so this
// script never holds a long-lived lock against a concurrent writer.
//
// Usage: node scripts/tire-db-repair/04_provenance.mjs [dbPath]

import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const PACKAGE_DIR = join(REPO_ROOT, "backups", "claude-tire-db-handoff-2026-07-28");
const OUTPUT_DIR = join(PACKAGE_DIR, "repair-2026-07-28");

const WORKING_DB_DEFAULT = join(OUTPUT_DIR, "REPAIRED_TIRE_DATABASE.db");
const GAPS_CSV = join(OUTPUT_DIR, "PROVENANCE_GAPS.csv");

const dbPathArg = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : null;
const workingDbPath = dbPathArg ?? WORKING_DB_DEFAULT;

// Packaged input files this task must NEVER modify (global constraint). Verified before and after.
const PACKAGED_FILES = [
  "01_PROCESS_MERGED_pre_canonical.db",
  "02_ENRICHMENT_STAGE_2_rich.db",
  "03_BOSS_SOURCE_BARCODES.xlsx",
  "04_ENRICHMENT_AUDIT.xlsx",
];

function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex").toUpperCase()));
    stream.on("error", reject);
  });
}

function csvEscape(value) {
  const s = value === null || value === undefined ? "" : String(value);
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function csvLine(fields) {
  return fields.map(csvEscape).join(",") + "\n";
}

// process_merge_audit actions that represent a KNOWN, resolvable import origin: each row ties a
// barcode to a canonical_product_uid via the boss-workbook merge pass, corroborated by trust_color
// green (the merge script's own confidence gate). Actions like `skipped_invalid_barcode`,
// `part_number_uid_conflict`, `part_number_value_conflict`, `update_part_number_uid` are NOT known
// origins for a tires-row identity claim (they are conflict/skip records, not corroborated fills) and
// are deliberately excluded.
const IMPORT_AUDIT_ACTIONS = [
  "insert_part_number_alias",
  "fill_missing_part_number",
  "confirmed_existing_part_number",
];

const IMPORT_AUDIT_SOURCE_NAME = "process_merge_import";
const IMPORT_AUDIT_EVIDENCE_LEVEL = "import_audit";
const IMPORT_AUDIT_BATCH_ID = "A5_process_merge_import_backfill_2026-07-28";

async function main() {
  if (!existsSync(workingDbPath)) {
    console.error(`FATAL: working DB not found at ${workingDbPath}. Run 00_setup_and_red_proof.mjs first.`);
    process.exit(1);
  }
  mkdirSync(OUTPUT_DIR, { recursive: true });

  // --- Hash packaged inputs BEFORE (never modified by this script) -----------------------------
  const hashesBefore = {};
  for (const f of PACKAGED_FILES) {
    hashesBefore[f] = await sha256File(join(PACKAGE_DIR, f));
  }

  const db = new Database(workingDbPath);
  db.pragma("busy_timeout = 30000"); // B6 may be writing concurrently tonight
  db.pragma("foreign_keys = OFF");

  // --- Ensure the tables this task depends on exist (idempotent; A3 normally already created these) ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS provenance (
      id INTEGER PRIMARY KEY,
      product_id TEXT,
      barcode TEXT,
      source_name TEXT,
      source_ref TEXT,
      sheet TEXT,
      row TEXT,
      batch_id TEXT,
      imported_at TEXT,
      evidence_level TEXT,
      license_note TEXT,
      content_hash TEXT,
      UNIQUE(product_id, barcode, source_name, source_ref, sheet, row)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS stage2_enrichment_audit (
      audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      trust_color TEXT NOT NULL,
      confidence_score INTEGER NOT NULL,
      barcode TEXT,
      canonical_product_id TEXT,
      part_number TEXT,
      reason TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // === Step 1: backfill provenance for process_merge_audit import lineage =========================
  const importCandidatesStmt = db.prepare(`
    SELECT pma.audit_id, pma.barcode, pma.canonical_product_uid, pma.part_number, pma.action,
           pma.source_sheet, pma.source_row, t.canonical_product_uid AS tire_uid
    FROM process_merge_audit pma
    JOIN tires t ON t.barcode = pma.barcode
    WHERE pma.action IN (${IMPORT_AUDIT_ACTIONS.map(() => "?").join(",")})
      AND pma.trust_color = 'green'
      AND pma.barcode IS NOT NULL AND pma.barcode <> ''
  `);
  const importCandidates = importCandidatesStmt.all(...IMPORT_AUDIT_ACTIONS);

  const insertProvenance = db.prepare(`
    INSERT INTO provenance
      (product_id, barcode, source_name, source_ref, sheet, row, batch_id, imported_at, evidence_level, license_note, content_hash)
    VALUES (@product_id, @barcode, @source_name, @source_ref, @sheet, @row, @batch_id, @imported_at, @evidence_level, @license_note, @content_hash)
    ON CONFLICT(product_id, barcode, source_name, source_ref, sheet, row) DO UPDATE SET
      batch_id = excluded.batch_id,
      imported_at = excluded.imported_at,
      evidence_level = excluded.evidence_level,
      license_note = excluded.license_note,
      content_hash = excluded.content_hash
  `);

  const nowIso = new Date().toISOString();
  let importRowsUpserted = 0;
  const insertImportBatch = db.transaction((rows) => {
    for (const r of rows) {
      // tires row is guaranteed to exist (INNER JOIN above); use its own canonical_product_uid as the
      // authoritative product_id (never the audit row's own possibly-stale value).
      insertProvenance.run({
        product_id: r.tire_uid,
        barcode: r.barcode,
        source_name: IMPORT_AUDIT_SOURCE_NAME,
        source_ref: `process_merge_audit:${r.action}:audit_id=${r.audit_id}`,
        sheet: r.source_sheet ?? "",
        row: r.source_row === null || r.source_row === undefined ? "" : String(r.source_row),
        batch_id: IMPORT_AUDIT_BATCH_ID,
        imported_at: nowIso,
        evidence_level: IMPORT_AUDIT_EVIDENCE_LEVEL,
        license_note: "boss-workbook merge lineage; internal, no external license",
        content_hash: r.part_number ?? "",
      });
      importRowsUpserted++;
    }
  });
  insertImportBatch(importCandidates);
  console.log(`Import-audit provenance candidates from process_merge_audit: ${importCandidates.length}`);
  console.log(`Provenance rows upserted (source_name=${IMPORT_AUDIT_SOURCE_NAME}): ${importRowsUpserted}`);

  // === Step 2: derive tires.source_count from LIVE provenance state at this moment =================
  // Count DISTINCT (source_name, source_ref, sheet, row) evidence tuples per barcode, not raw provenance
  // rows: a pre-existing data-quality issue discovered in B5's output (see report "Concerns" section)
  // writes 2-3 separate provenance rows with sheet=NULL/row=NULL for the SAME (product_id, barcode,
  // source_name, source_ref) tuple (one per field filled - brand/model/size - from a single
  // canonical_tire_products join event). SQLite's UNIQUE constraint does not reject these because SQL
  // treats NULL as never-equal-to-itself, so the constraint silently allows duplicates when sheet/row
  // are NULL. Counting raw rows would inflate source_count for ~238 barcodes (counting one corroborating
  // relationship 2-3 times). Counting DISTINCT evidence tuples gives the honest number of independent
  // sources backing a barcode, which is what source_count is meant to measure.
  const derivedAt = new Date().toISOString();
  const updateSourceCount = db.prepare(`
    UPDATE tires
    SET source_count = (
      SELECT COUNT(*) FROM (
        SELECT DISTINCT source_name, source_ref, sheet, row
        FROM provenance p
        WHERE p.barcode = tires.barcode
      )
    )
  `);
  const sourceCountResult = db.transaction(() => updateSourceCount.run())();
  console.log(`tires.source_count derived at ${derivedAt} (UTC ISO). Rows updated: ${sourceCountResult.changes}`);

  const sourceCountDistribution = db
    .prepare("SELECT source_count, COUNT(*) c FROM tires GROUP BY source_count ORDER BY source_count")
    .all();
  console.log("source_count distribution after derivation:", sourceCountDistribution);

  // === Step 3: PROVENANCE_GAPS.csv - honest zero-provenance rows at this same moment ===============
  const gapsStmt = db.prepare(`
    SELECT t.barcode, t.canonical_product_uid, t.brand, t.model, t.size, t.manufacturer_part_number,
           t.field_completeness_score
    FROM tires t
    WHERE t.source_count = 0
    ORDER BY t.barcode
  `);
  const gapRows = gapsStmt.all();

  let gapsCsv = csvLine([
    "barcode",
    "canonical_product_uid",
    "brand",
    "model",
    "size",
    "manufacturer_part_number",
    "field_completeness_score",
    "derived_at",
  ]);
  for (const g of gapRows) {
    gapsCsv += csvLine([
      g.barcode,
      g.canonical_product_uid,
      g.brand,
      g.model,
      g.size,
      g.manufacturer_part_number,
      g.field_completeness_score,
      derivedAt,
    ]);
  }
  writeFileSync(GAPS_CSV, gapsCsv, "utf8");
  console.log(`Wrote ${GAPS_CSV} (${gapRows.length} zero-provenance rows, honest gap measurement).`);

  // === Step 4: populate stage2_enrichment_audit - one row per repair batch so far ===================
  // Counts below are read from each task's own report (A2/A3/A4-report.md, B5's B5_BACKFILL_REPORT.md)
  // and cross-checked live against the DB where the audit trail supports it, so the recorded counts
  // match what actually landed in this working DB, not just what the report claimed.
  const liveCounts = {
    a2_migrated: db.prepare("SELECT COUNT(*) c FROM tire_part_numbers").get().c, // active rows after migration
    a2_quarantined: db.prepare("SELECT COUNT(*) c FROM tire_part_numbers_quarantine").get().c,
    a3_provenance_boss: db
      .prepare("SELECT COUNT(*) c FROM provenance WHERE source_name = 'boss_source'")
      .get().c,
    a3_fills: db.prepare("SELECT COUNT(*) c FROM remaining_blank_fill_audit WHERE action = 'boss_truth_fill'").get().c,
    a4_aliases: db.prepare("SELECT COUNT(*) c FROM tire_product_part_number_aliases").get().c,
    b5_brand_fills: db
      .prepare(
        "SELECT COUNT(*) c FROM remaining_blank_fill_audit WHERE action IN ('backfill_brand_from_gs1_prefix','backfill_from_canonical_product')"
      )
      .get().c,
    b5_provenance: db
      .prepare("SELECT COUNT(*) c FROM provenance WHERE source_name = 'deterministic_backfill'")
      .get().c,
  };
  console.log("Live batch counts (cross-check against task reports):", liveCounts);

  const STAGE2_BATCH_ACTIONS = [
    {
      action: "A2_part_number_uid_migration",
      trust_color: "green",
      confidence_score: 100,
      canonical_product_id: null,
      part_number: null,
      reason: `A2 (01_repair_part_number_uids.mjs): migrated ${liveCounts.a2_migrated} tire_part_numbers rows from dead pre-canonical UIDs to live stable TIRE_... IDs; ${liveCounts.a2_quarantined} rows quarantined (unresolvable conflict/orphan UIDs) into tire_part_numbers_quarantine. Total preserved 29173 (active + quarantine).`,
    },
    {
      action: "A3_boss_reconciliation_fills",
      trust_color: "green",
      confidence_score: 100,
      canonical_product_id: null,
      part_number: null,
      reason: `A3 (02_boss_reconciliation.mjs): reconciled 6990 boss-workbook rows (6097 exact barcode/part-number, 195 affix-core corroborated, 697 unresolved, 1 packaging special case); wrote ${liveCounts.a3_provenance_boss} boss_source provenance rows and ${liveCounts.a3_fills} blank-only tires fills (boss_truth_fill).`,
    },
    {
      action: "A4_part_number_alias_table",
      trust_color: "green",
      confidence_score: 100,
      canonical_product_id: null,
      part_number: null,
      reason: `A4 (03_part_number_aliases.mjs): reclassified 1134 process_merge_audit conflict events (871 safe affix alias + 224 confirmed alias + 39 true UID conflict) into ${liveCounts.a4_aliases} rows in tire_product_part_number_aliases; wired runtime alias fallback into tireKnowledgeIndex.ts lookupByExactPartNumber (SQLite + Turso paths).`,
    },
    {
      action: "B5_deterministic_backfill",
      trust_color: "green",
      confidence_score: 100,
      canonical_product_id: null,
      part_number: null,
      reason: `B5 (bakeoff/b5_deterministic_backfill.mjs): free local backfill - ${liveCounts.b5_brand_fills} brand/model/size fills (454 brand via GS1-prefix + canonical-product join, 239 model + 238 size via canonical-product join); 0 manufacturer_part_number fills (genuine data-coverage gap: no blank-MPN product has a tire_part_numbers row); wrote ${liveCounts.b5_provenance} deterministic_backfill provenance rows.`,
    },
    {
      action: "A5_provenance_backfill_and_source_count",
      trust_color: "green",
      confidence_score: 100,
      canonical_product_id: null,
      part_number: null,
      reason: `A5 (04_provenance.mjs, this batch): backfilled ${importRowsUpserted} process_merge_import provenance rows from known import lineage (process_merge_audit green fill/alias/confirm events); derived tires.source_count from live provenance state at ${derivedAt}; wrote PROVENANCE_GAPS.csv (${gapRows.length} zero-provenance rows, honest measurement, expect this to shrink as B6/other enrichment lands more provenance).`,
    },
  ];

  // Idempotent replace: delete any prior rows this script itself wrote for these fixed action names,
  // then re-insert current counts, so a second run reflects fresh live counts rather than duplicating
  // stale rows or leaving two generations of the same batch summary in the table.
  const stage2Actions = STAGE2_BATCH_ACTIONS.map((r) => r.action);
  const deleteStage2 = db.prepare(
    `DELETE FROM stage2_enrichment_audit WHERE action IN (${stage2Actions.map(() => "?").join(",")})`
  );
  const insertStage2 = db.prepare(`
    INSERT INTO stage2_enrichment_audit
      (action, trust_color, confidence_score, barcode, canonical_product_id, part_number, reason, created_at)
    VALUES (@action, @trust_color, @confidence_score, @barcode, @canonical_product_id, @part_number, @reason, @created_at)
  `);
  const writeStage2 = db.transaction((rows) => {
    deleteStage2.run(...stage2Actions);
    for (const r of rows) {
      insertStage2.run({
        action: r.action,
        trust_color: r.trust_color,
        confidence_score: r.confidence_score,
        barcode: null,
        canonical_product_id: r.canonical_product_id,
        part_number: r.part_number,
        reason: r.reason,
        created_at: nowIso,
      });
    }
  });
  writeStage2(STAGE2_BATCH_ACTIONS);
  console.log(`stage2_enrichment_audit: wrote ${STAGE2_BATCH_ACTIONS.length} batch-summary rows.`);

  // === GREEN gates ===================================================================================
  let failed = false;

  // Gate 1: no duplicate provenance tuples WRITTEN BY THIS SCRIPT (process_merge_import rows use a
  // non-null source_ref containing the audit_id, so SQLite's UNIQUE constraint fully covers them - a
  // real duplicate here would be an actual bug in this script's own insert logic). Pre-existing
  // duplicate rows from an earlier task (B5's NULL-sheet/NULL-row rows, which SQLite's UNIQUE
  // constraint does not catch because NULL never equals NULL) are reported separately as an honest
  // known issue, not silently mutated - fixing another task's write logic/data is out of A5's scope.
  const dupCheckThisBatch = db
    .prepare(
      `SELECT COUNT(*) c FROM (
         SELECT product_id, barcode, source_name, source_ref, sheet, row, COUNT(*) n
         FROM provenance
         WHERE source_name = ?
         GROUP BY product_id, barcode, source_name, source_ref, sheet, row
         HAVING n > 1
       )`
    )
    .get(IMPORT_AUDIT_SOURCE_NAME).c;
  if (dupCheckThisBatch === 0) {
    console.log(`PASS: no duplicate provenance tuples among rows this script wrote (source_name='${IMPORT_AUDIT_SOURCE_NAME}').`);
  } else {
    console.error(`FAIL: ${dupCheckThisBatch} duplicate provenance tuples found among this script's own writes.`);
    failed = true;
  }
  const preexistingDupGroups = db
    .prepare(
      `SELECT COUNT(*) c FROM (
         SELECT product_id, barcode, source_name, source_ref, sheet, row, COUNT(*) n
         FROM provenance
         WHERE source_name <> ?
         GROUP BY product_id, barcode, source_name, source_ref, sheet, row
         HAVING n > 1
       )`
    )
    .get(IMPORT_AUDIT_SOURCE_NAME).c;
  if (preexistingDupGroups > 0) {
    console.log(
      `NOTE (not a gate failure, pre-existing, out of A5 scope): ${preexistingDupGroups} duplicate provenance tuple groups exist from an earlier task's writes (NULL sheet/row bypasses the UNIQUE constraint). source_count derivation below counts DISTINCT evidence tuples specifically to avoid inflating from this.`
    );
  }

  // Gate 2: source_count matches a live re-derivation (DISTINCT evidence tuples) exactly - no drift
  // between the UPDATE and a fresh count taken independently afterward.
  const driftCheck = db
    .prepare(
      `SELECT COUNT(*) c FROM tires t
       WHERE t.source_count <> (
         SELECT COUNT(*) FROM (
           SELECT DISTINCT source_name, source_ref, sheet, row FROM provenance p WHERE p.barcode = t.barcode
         )
       )`
    )
    .get().c;
  if (driftCheck === 0) {
    console.log("PASS: tires.source_count matches live provenance DISTINCT-evidence count for every row.");
  } else {
    console.error(`FAIL: ${driftCheck} tires rows have source_count out of sync with provenance.`);
    failed = true;
  }

  // Gate 3: PROVENANCE_GAPS.csv row count equals tires rows with source_count = 0.
  const zeroCountRows = db.prepare("SELECT COUNT(*) c FROM tires WHERE source_count = 0").get().c;
  if (gapRows.length === zeroCountRows) {
    console.log(`PASS: PROVENANCE_GAPS.csv row count (${gapRows.length}) matches source_count=0 rows (${zeroCountRows}).`);
  } else {
    console.error(`FAIL: PROVENANCE_GAPS.csv has ${gapRows.length} rows but ${zeroCountRows} tires rows have source_count=0.`);
    failed = true;
  }

  // Gate 4: stage2_enrichment_audit has exactly one row per batch action (no duplicates from a re-run).
  for (const action of stage2Actions) {
    const n = db.prepare("SELECT COUNT(*) c FROM stage2_enrichment_audit WHERE action = ?").get(action).c;
    if (n !== 1) {
      console.error(`FAIL: stage2_enrichment_audit action='${action}' has ${n} rows, expected exactly 1.`);
      failed = true;
    }
  }
  if (!failed) {
    console.log(`PASS: stage2_enrichment_audit has exactly 1 row per batch action (${stage2Actions.length} actions).`);
  }

  // Gate 5: packaged files unchanged (SHA-256 before === after).
  const hashesAfter = {};
  for (const f of PACKAGED_FILES) {
    hashesAfter[f] = await sha256File(join(PACKAGE_DIR, f));
  }
  for (const f of PACKAGED_FILES) {
    if (hashesBefore[f] !== hashesAfter[f]) {
      console.error(`FAIL: packaged file ${f} hash changed (before=${hashesBefore[f]} after=${hashesAfter[f]}).`);
      failed = true;
    }
  }
  if (!failed) {
    console.log("PASS: all 4 packaged input files unchanged (SHA-256 before === after).");
  }

  console.log("\n=== SUMMARY ===");
  console.log(`Provenance rows total: ${db.prepare("SELECT COUNT(*) c FROM provenance").get().c}`);
  console.log(
    "Provenance rows by source_name:",
    db.prepare("SELECT source_name, COUNT(*) c FROM provenance GROUP BY source_name ORDER BY source_name").all()
  );
  console.log("tires.source_count distribution:", sourceCountDistribution);
  console.log(`PROVENANCE_GAPS.csv rows (source_count = 0): ${gapRows.length}`);
  console.log(`stage2_enrichment_audit rows written by this batch: ${STAGE2_BATCH_ACTIONS.length}`);
  console.log(`Pre-existing duplicate provenance tuple groups from an earlier task (not fixed here, out of scope): ${preexistingDupGroups}`);

  db.close();

  if (failed) {
    console.error("\nOne or more gates FAILED.");
    process.exit(1);
  }
  console.log("\nAll GREEN gates passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
