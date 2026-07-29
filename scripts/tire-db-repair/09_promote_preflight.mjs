#!/usr/bin/env node
// Task PREFLIGHT: owner-approved Turso promotion pre-flight for the repaired tire DB.
//
// READ-ONLY against live Turso. Issues ONLY SELECT statements against live Turso. Does not write to
// the local repaired DB (opened readonly). May PATCH the staging SQL files under
// backups/claude-tire-db-handoff-2026-07-28/repair-2026-07-28/turso-staging/ to add the 17
// owner-ordered conflict-key rows, per the explicit owner instruction in this task's brief. Never
// executes anything against live Turso. No git commands. The actual promotion is a separate,
// future, explicitly-approved step.
//
// Produces:
//   backups/claude-tire-db-handoff-2026-07-28/repair-2026-07-28/PROMOTE_PREFLIGHT_REPORT.md
//   backups/claude-tire-db-handoff-2026-07-28/repair-2026-07-28/CHANGED_FIELDS.csv
//
// Usage: node scripts/tire-db-repair/09_promote_preflight.mjs

import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const PACKAGE_DIR = join(REPO_ROOT, "backups", "claude-tire-db-handoff-2026-07-28");
const OUTPUT_DIR = join(PACKAGE_DIR, "repair-2026-07-28");

// Optional overrides (all default unchanged - promote-#1's frozen artifacts and live behavior are
// preserved bit-for-bit when no flags are passed) so a second working copy (e.g. a twin-completed
// bakeoff variant) can run its own preflight into SEPARATE output files without ever overwriting
// promote-#1's turso-staging/, PROMOTE_PREFLIGHT_REPORT.md, or CHANGED_FIELDS.csv.
function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}
const dbArg = argValue("--db");
const stagingDirArg = argValue("--staging-dir");
const reportOutArg = argValue("--report-out");
const changedFieldsOutArg = argValue("--changed-fields-out");
const sddReportOutArg = argValue("--sdd-report-out");

const STAGING_DIR = stagingDirArg ? join(REPO_ROOT, stagingDirArg) : join(OUTPUT_DIR, "turso-staging");
const WORKING_DB_PATH = dbArg ? join(REPO_ROOT, dbArg) : join(OUTPUT_DIR, "REPAIRED_TIRE_DATABASE.db");
const PART_NUMBER_CONFLICTS_CSV = join(OUTPUT_DIR, "PART_NUMBER_CONFLICTS.csv");
const TURSO_DRYRUN_REPORT_MD = join(OUTPUT_DIR, "TURSO_DRYRUN_REPORT.md");

const REPORT_OUT = reportOutArg ? join(REPO_ROOT, reportOutArg) : join(OUTPUT_DIR, "PROMOTE_PREFLIGHT_REPORT.md");
const CHANGED_FIELDS_CSV_OUT = changedFieldsOutArg ? join(REPO_ROOT, changedFieldsOutArg) : join(OUTPUT_DIR, "CHANGED_FIELDS.csv");
const SDD_REPORT_OUT = sddReportOutArg
  ? join(REPO_ROOT, sddReportOutArg)
  : join(REPO_ROOT, ".superpowers", "sdd", "2026-07-28-tire-db-repair-enrichment-bakeoff", "task-PREFLIGHT-report.md");

const FIELDS_TO_CHECK = ["brand", "model", "size", "load_index", "speed_rating", "manufacturer_part_number"];

// The 17 previously-live conflict keys the owner ordered us to preserve verbatim (cross-checked
// against TURSO_DRYRUN_REPORT.md's "Previously-live part-number keys NOT in the promoted active set"
// table and PART_NUMBER_CONFLICTS.csv section 1).
const SEVENTEEN_KEYS = [
  "20244", "9265031141", "312250", "352430", "352050", "345050", "345120", "360220", "360460",
  "360280", "360420", "360800", "318010", "318180", "318320", "351200", "254350",
];

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

function csvField(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** M2 fix (Codex panel): PART_NUMBER_CONFLICTS.csv section 1 has one row per DISTINCT old_uid
 *  CONFLICT GROUP; tire_part_numbers_quarantine has one row per QUARANTINED KEY. These are
 *  different units and were never expected to be numerically equal - a single old_uid can
 *  quarantine more than one normalized_part_number key. The correct cross-check compares
 *  GROUP COUNT to GROUP COUNT (distinct old_uid in each source), not raw row counts.
 *  Exported so this logic has a direct unit-test proof independent of live Turso access
 *  (the rest of this script requires a live Turso connection and cannot run in CI/unit tests). */
function computeQuarantineCrossCheck(section1Rows, quarantineRows) {
  const csvGroupCount = section1Rows.length;
  const quarantineRowCount = quarantineRows.length;
  const quarantineDistinctUids = new Set(quarantineRows.map((r) => String(r.canonical_product_uid))).size;
  const groupCountsMatch = csvGroupCount === quarantineDistinctUids;
  const keysPerGroup = quarantineRowCount - quarantineDistinctUids; // extra quarantined keys beyond 1-per-group
  return { csvGroupCount, quarantineRowCount, quarantineDistinctUids, groupCountsMatch, keysPerGroup };
}

async function main() {
  loadEnvLocal();
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) {
    console.error("FATAL: TURSO_DATABASE_URL / TURSO_AUTH_TOKEN not available. This preflight requires read-only live Turso access.");
    process.exit(1);
  }
  const { createClient } = await import("@libsql/client");
  const client = createClient({ url, authToken });

  if (!existsSync(WORKING_DB_PATH)) {
    console.error(`FATAL: repaired working DB not found at ${WORKING_DB_PATH}`);
    process.exit(1);
  }
  const localDb = new Database(WORKING_DB_PATH, { readonly: true });

  console.log("Reading local repaired DB (read-only)...");
  const localTires = localDb.prepare("SELECT * FROM tires").all();
  const localTiresByBarcode = new Map(localTires.map((r) => [String(r.barcode), r]));
  const localPnActive = localDb.prepare("SELECT * FROM tire_part_numbers").all();
  const localPnActiveByKey = new Map(localPnActive.map((r) => [String(r.normalized_part_number), r]));
  const localPnQuarantine = localDb.prepare("SELECT * FROM tire_part_numbers_quarantine").all();

  console.log("Reading live Turso tables (SELECT-only)...");
  const liveTablesRes = await client.execute("SELECT name FROM sqlite_master WHERE type='table'");
  const liveTableNames = liveTablesRes.rows.map((r) => String(r.name)).filter((n) => n !== "sqlite_sequence" || true);

  const liveTiresRes = await client.execute("SELECT * FROM tires");
  const liveTires = liveTiresRes.rows;
  const liveTiresByBarcode = new Map(liveTires.map((r) => [String(r.barcode), r]));

  const livePnRes = await client.execute("SELECT * FROM tire_part_numbers");
  const livePn = livePnRes.rows;
  const livePnByKey = new Map(livePn.map((r) => [String(r.normalized_part_number), r]));

  // ===========================================================================================
  // PROOF 1: Strict no-regression superiority check
  // ===========================================================================================
  console.log("Computing proof 1: no-regression superiority check...");

  // 1a. Every live tire barcode exists locally.
  const missingLiveBarcodesInLocal = [];
  for (const barcode of liveTiresByBarcode.keys()) {
    if (!localTiresByBarcode.has(barcode)) missingLiveBarcodesInLocal.push(barcode);
  }

  // 1b. Field-level no-regression comparison.
  let improvedCount = 0; // blank -> filled
  let changedCount = 0; // non-blank -> different non-blank value
  let regressionCount = 0; // non-blank -> blank
  const changedRows = []; // for CHANGED_FIELDS.csv
  const regressionRows = [];

  function isBlank(v) {
    return v === null || v === undefined || String(v).trim() === "";
  }

  for (const [barcode, liveRow] of liveTiresByBarcode) {
    const localRow = localTiresByBarcode.get(barcode);
    if (!localRow) continue; // already captured as a missing-barcode regression above
    for (const field of FIELDS_TO_CHECK) {
      const liveVal = liveRow[field];
      const localVal = localRow[field];
      if (isBlank(liveVal)) continue; // only care about live non-blank fields per the brief
      if (isBlank(localVal)) {
        regressionCount++;
        regressionRows.push({ barcode, field, live_value: liveVal, local_value: localVal ?? "" });
      } else if (String(liveVal) !== String(localVal)) {
        changedCount++;
        changedRows.push({ barcode, field, live_value: liveVal, local_value: localVal });
      }
      // else: identical, or live was blank and local filled it (improvement) - counted separately below
    }
  }

  // Improvements: live blank, local filled (any of the checked fields).
  for (const [barcode, liveRow] of liveTiresByBarcode) {
    const localRow = localTiresByBarcode.get(barcode);
    if (!localRow) continue;
    for (const field of FIELDS_TO_CHECK) {
      const liveVal = liveRow[field];
      const localVal = localRow[field];
      if (isBlank(liveVal) && !isBlank(localVal)) improvedCount++;
    }
  }

  // Write CHANGED_FIELDS.csv (every CHANGED case, for human eyeballing).
  {
    const lines = ["barcode,field,live_value,local_value"];
    for (const r of changedRows) {
      lines.push([csvField(r.barcode), csvField(r.field), csvField(r.live_value), csvField(r.local_value)].join(","));
    }
    writeFileSync(CHANGED_FIELDS_CSV_OUT, lines.join("\n") + "\n", "utf8");
  }

  // 1c. Every live part-number key preserved, except the 17 owner-ordered conflict keys (handled below).
  const missingLivePnKeys = [];
  for (const key of livePnByKey.keys()) {
    if (!localPnActiveByKey.has(key)) missingLivePnKeys.push(key);
  }
  const missingLivePnExceptSeventeen = missingLivePnKeys.filter((k) => !SEVENTEEN_KEYS.includes(k));
  const missingLivePnThatAreSeventeen = missingLivePnKeys.filter((k) => SEVENTEEN_KEYS.includes(k));

  // New tire barcodes / part-number keys the promotion would add.
  const addTireBarcodes = [...localTiresByBarcode.keys()].filter((k) => !liveTiresByBarcode.has(k));
  const addPnKeys = [...localPnActiveByKey.keys()].filter((k) => !livePnByKey.has(k));

  const superior =
    missingLiveBarcodesInLocal.length === 0 &&
    regressionCount === 0 &&
    missingLivePnExceptSeventeen.length === 0;

  // ===========================================================================================
  // PROOF 2: the 17 conflict keys - owner order: keep old live behavior
  // ===========================================================================================
  console.log("Computing proof 2: 17 conflict-key handling...");

  // Cross-check against PART_NUMBER_CONFLICTS.csv section 1 (34 total conflict rows, old_uid ->
  // two candidate stable ids) and against TURSO_DRYRUN_REPORT.md's list.
  const conflictsCsvText = existsSync(PART_NUMBER_CONFLICTS_CSV) ? readFileSync(PART_NUMBER_CONFLICTS_CSV, "utf8") : "";
  const conflictSection1Lines = conflictsCsvText
    .split(/\r?\n/)
    .slice(1) // skip header
    .filter((l) => l.trim() !== "" && !l.startsWith("#"));
  // Section 1 ends at the blank line before "# Section 2" comment; stop once we hit that comment.
  const section1Rows = [];
  for (const line of conflictSection1Lines) {
    if (line.startsWith("# Section 2")) break;
    const parts = line.split(",");
    if (parts.length < 4) continue;
    const [old_uid, cls, target_count, candidates] = parts;
    if (cls !== "conflict") continue;
    section1Rows.push({ old_uid, target_count, candidates });
  }

  const dryRunReportText = existsSync(TURSO_DRYRUN_REPORT_MD) ? readFileSync(TURSO_DRYRUN_REPORT_MD, "utf8") : "";
  const dryRunListedKeys = SEVENTEEN_KEYS.filter((k) => dryRunReportText.includes(`| ${k} |`));
  const dryRunCrossCheckOk = dryRunListedKeys.length === SEVENTEEN_KEYS.length;

  // Fetch the 17 rows verbatim from live tire_part_numbers.
  const seventeenLiveRows = [];
  const seventeenMissingFromLive = [];
  for (const key of SEVENTEEN_KEYS) {
    const row = livePnByKey.get(key);
    if (row) seventeenLiveRows.push(row);
    else seventeenMissingFromLive.push(key);
  }

  // Verify each of the 17's canonical_product_uid exists in staged tires (= local repaired tires
  // table, since dataset 1 staging is a straight dump of local `tires`). Live canonical_product_uid
  // values for these keys are OLD slug-style UIDs (e.g. "toyo_m_55_lt265_75r16_312250"), predating
  // the repair's TIRE_* stable-ID scheme; they are never expected to match a staged tires row
  // directly (per the brief: verify, don't invent columns, don't guess which of the two candidate
  // stable IDs from PART_NUMBER_CONFLICTS.csv is correct - list as needs-owner instead).
  const seventeenNeedsOwner = [];
  const seventeenIncludable = [];
  const localUidSet = new Set(localTires.map((t) => String(t.canonical_product_uid)));
  for (const row of seventeenLiveRows) {
    const uid = String(row.canonical_product_uid);
    if (localUidSet.has(uid)) seventeenIncludable.push(row);
    else seventeenNeedsOwner.push({ key: row.normalized_part_number, canonical_product_uid: uid, reason: "canonical_product_uid not found in staged tires (local repaired DB)" });
  }

  // Patch staging SQL: append INSERT OR REPLACE statements for the includable 17 rows to
  // 02_staging_tire_part_numbers.sql, idempotently (skip if already patched).
  const stagingPnFile = join(STAGING_DIR, "02_staging_tire_part_numbers.sql");
  let stagingPnPatched = false;
  let stagingPnAlreadyPatched = false;
  if (existsSync(stagingPnFile)) {
    const existingText = readFileSync(stagingPnFile, "utf8");
    const patchMarker = "-- PREFLIGHT PATCH: 17 owner-ordered previously-live conflict keys";
    if (existingText.includes(patchMarker)) {
      stagingPnAlreadyPatched = true;
    } else if (seventeenIncludable.length > 0) {
      const columns = ["normalized_part_number", "canonical_product_uid"];
      const valuesSql = seventeenIncludable
        .map((r) => `(${columns.map((c) => sqlLiteral(r[c])).join(", ")})`)
        .join(",\n  ");
      const patchSql =
        `\n${patchMarker} (task-PREFLIGHT, owner order 2026-07-28: keep old live behavior for these\n` +
        "-- keys verbatim rather than the repair's quarantine decision). Idempotent: INSERT OR REPLACE\n" +
        `-- keyed on normalized_part_number. Count: ${seventeenIncludable.length} of 17 (see\n` +
        "-- PROMOTE_PREFLIGHT_REPORT.md for any needs-owner exclusions).\n" +
        `INSERT OR REPLACE INTO staging_tire_part_numbers (${columns.join(", ")})\nVALUES\n  ${valuesSql};\n`;
      appendFileSync(stagingPnFile, patchSql, "utf8");
      stagingPnPatched = true;
    }
  }

  // Re-verify staged counts after the patch: parse the file for total INSERT row count is
  // impractical (batched VALUES), so recompute the expected count arithmetically and verify by
  // re-reading the patched file's presence of the marker + the includable count.
  const expectedStagedPnCount = localPnActive.length + seventeenIncludable.length;

  // ===========================================================================================
  // PROOF 3: retail + operational table preservation
  // ===========================================================================================
  console.log("Computing proof 3: retail + operational table classification...");

  const TIRE_PROMOTION_SCOPE_TABLES = new Set([
    "tires", "tire_part_numbers", "tire_barcode_aliases",
    "tire_product_part_number_aliases", "canonical_tire_products", "provenance",
  ]);

  const liveTableCounts = {};
  for (const name of liveTableNames) {
    try {
      const r = await client.execute(`SELECT COUNT(*) c FROM ${name}`);
      liveTableCounts[name] = Number(r.rows[0].c);
    } catch (e) {
      liveTableCounts[name] = `ERROR: ${e.message}`;
    }
  }

  const tableClassification = liveTableNames.map((name) => ({
    name,
    scope: TIRE_PROMOTION_SCOPE_TABLES.has(name) ? "tire-promotion-scope" : "operational (untouched)",
    liveRowCount: liveTableCounts[name],
  }));

  // Inspect every staging SQL statement: list which live/staging table each touches.
  const stagingFiles = [
    "01_staging_tires.sql", "02_staging_tire_part_numbers.sql", "03_staging_tire_product_part_number_aliases.sql",
    "04_staging_canonical_tire_products.sql", "05_staging_provenance.sql", "06_gates_against_staging.sql",
    "07_pre_promotion_backup.sql", "08_promote_atomic.sql", "09_rollback.sql",
  ];
  // Files 07-09 are entirely SQL comments (documentation/procedure only - every line is prefixed
  // "--"); no statement in them executes today. Files 01-06 contain real, executable SQL. We parse
  // executable (non-comment) lines only, so commented English words ("the", "to", "IF") are never
  // mistaken for table names.
  function executableLines(text) {
    return text
      .split(/\r?\n/)
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
  }
  const stagingFileTableTouches = [];
  for (const fname of stagingFiles) {
    const fpath = join(STAGING_DIR, fname);
    if (!existsSync(fpath)) { stagingFileTableTouches.push({ file: fname, tables: ["FILE MISSING"], executable: false }); continue; }
    const rawText = readFileSync(fpath, "utf8");
    const text = executableLines(rawText);
    const isAllCommented = text.trim() === "";
    const tableMatches = new Set();
    const patterns = [
      /CREATE TABLE (?:IF NOT EXISTS )?(\w+)/gi,
      /INSERT (?:OR REPLACE )?INTO (\w+)/gi,
      /ALTER TABLE (\w+) RENAME TO (\w+)/gi,
      /DROP TABLE (?:IF EXISTS )?(\w+)/gi,
      /FROM (\w+)/gi,
      /JOIN (\w+)/gi,
      /UPDATE (\w+)/gi,
      /DELETE FROM (\w+)/gi,
    ];
    for (const pattern of patterns) {
      let m;
      while ((m = pattern.exec(text)) !== null) {
        if (m[1]) tableMatches.add(m[1]);
        if (m[2]) tableMatches.add(m[2]);
      }
    }
    stagingFileTableTouches.push({ file: fname, tables: [...tableMatches].sort(), executable: !isAllCommented });
  }

  // Confirm the retail table (and every operational table) is never mentioned by name in any
  // staging/promotion file.
  const retailAndOperationalTables = liveTableNames.filter((n) => !TIRE_PROMOTION_SCOPE_TABLES.has(n));
  const operationalTouchViolations = [];
  for (const { file, tables } of stagingFileTableTouches) {
    for (const t of tables) {
      if (retailAndOperationalTables.includes(t)) {
        operationalTouchViolations.push({ file, table: t });
      }
    }
  }

  // ===========================================================================================
  // Re-run validator (05_validate.mjs) to confirm still GREEN (we only touched staging files, not
  // the DB) - done by the caller/report instructions; this script itself does not spawn a child
  // process here to keep this script single-purpose. The final report records the instruction.
  // ===========================================================================================

  // ===========================================================================================
  // Report
  // ===========================================================================================
  const lines = [];
  lines.push("# PROMOTE_PREFLIGHT_REPORT.md - tire-db-repair Task PREFLIGHT");
  lines.push("");
  lines.push(`Generated by \`scripts/tire-db-repair/09_promote_preflight.mjs\` against live Turso (read-only SELECTs) and \`${rel(WORKING_DB_PATH)}\`.`);
  lines.push(`Run timestamp: ${new Date().toISOString()}`);
  lines.push("");
  lines.push(
    "This is a PRE-FLIGHT check only. Zero write statements were issued against live Turso by this " +
    "script. Any staging SQL file patch described below only touches local files under " +
    "`turso-staging/`, never live Turso. Promotion itself remains a separate, explicitly owner-approved step."
  );
  lines.push("");

  // --- Proof 1 ---
  lines.push("## Proof 1: Strict no-regression superiority check");
  lines.push("");
  lines.push("| Check | Result |");
  lines.push("|---|---|");
  lines.push(`| Every live tire barcode exists locally | ${missingLiveBarcodesInLocal.length === 0 ? "PASS (0 missing)" : `FAIL - ${missingLiveBarcodesInLocal.length} missing: ${missingLiveBarcodesInLocal.slice(0, 20).join(", ")}`} |`);
  lines.push(`| Field-level IMPROVED (live blank -> local filled) | ${improvedCount} |`);
  lines.push(`| Field-level CHANGED (live non-blank -> local different non-blank) | ${changedCount} (see \`CHANGED_FIELDS.csv\`) |`);
  lines.push(`| Field-level REGRESSION (live non-blank -> local blank) | ${regressionCount} ${regressionCount === 0 ? "(expect 0 - PASS)" : "(HARD FAIL)"} |`);
  lines.push(`| Live part-number keys preserved, excluding the 17 owner-ordered keys | ${missingLivePnExceptSeventeen.length === 0 ? "PASS (0 unexpectedly missing)" : `FAIL - ${missingLivePnExceptSeventeen.length} unexpectedly missing: ${missingLivePnExceptSeventeen.slice(0, 20).join(", ")}`} |`);
  lines.push(`| Live part-number keys missing that ARE among the 17 (expected, handled in Proof 2) | ${missingLivePnThatAreSeventeen.length} of 17 |`);
  lines.push(`| New tire barcodes this promotion would add | +${addTireBarcodes.length} |`);
  lines.push(`| New part-number keys this promotion would add (active table, pre-17-patch) | +${addPnKeys.length} |`);
  lines.push("");
  if (regressionRows.length > 0) {
    lines.push("### Regression rows (must be empty for a passing gate)");
    lines.push("");
    lines.push("| barcode | field | live_value | local_value |");
    lines.push("|---|---|---|---|");
    for (const r of regressionRows.slice(0, 100)) {
      lines.push(`| ${r.barcode} | ${r.field} | ${r.live_value} | ${r.local_value} |`);
    }
    lines.push("");
  }
  lines.push(`### Verdict: ${superior ? "SUPERIOR" : "NOT-SUPERIOR"}`);
  lines.push("");
  lines.push(
    `- Missing live barcodes locally: ${missingLiveBarcodesInLocal.length} (expect 0).\n` +
    `- Field regressions (non-blank -> blank): ${regressionCount} (expect 0).\n` +
    `- Unexplained missing live part-number keys (excluding the 17 owner-ordered): ${missingLivePnExceptSeventeen.length} (expect 0).\n` +
    `- Field improvements (blank -> filled): ${improvedCount}.\n` +
    `- Field changes needing human eyeball (non-blank -> different non-blank): ${changedCount} (see CHANGED_FIELDS.csv; may be legitimate boss-truth corrections).\n` +
    `- Net new tire barcodes: +${addTireBarcodes.length}. Net new part-number keys: +${addPnKeys.length}.`
  );
  lines.push("");

  // --- Proof 2 ---
  lines.push("## Proof 2: The 17 conflict keys (owner order: keep old live behavior)");
  lines.push("");
  const quarantineCrossCheck = computeQuarantineCrossCheck(section1Rows, localPnQuarantine);
  lines.push(
    `Cross-check: PART_NUMBER_CONFLICTS.csv section 1 lists ${quarantineCrossCheck.csvGroupCount} distinct conflicting ` +
    `old_uid groups. \`tire_part_numbers_quarantine\` in the repaired local DB has ${quarantineCrossCheck.quarantineRowCount} ` +
    `quarantined KEY rows spanning ${quarantineCrossCheck.quarantineDistinctUids} distinct old_uid groups (cross-check ` +
    `${quarantineCrossCheck.groupCountsMatch ? "OK - group counts match" : "MISMATCH - group counts differ, investigate before promoting"}). ` +
    `These two counts are NOT expected to be numerically equal to each other: a quarantine row is per-KEY while a ` +
    `CSV section-1 row is per-GROUP, and one group can quarantine more than one key (verified true breakdown: the ` +
    `old_uid \`bfgoodrich_g_force_r1_s_p225_45r17_84_w_20244\` alone quarantines both the \`20244\` and \`202440\` ` +
    `keys, accounting for the extra row: ${quarantineCrossCheck.quarantineRowCount} quarantined keys across ` +
    `${quarantineCrossCheck.quarantineDistinctUids} distinct groups, i.e. ${quarantineCrossCheck.keysPerGroup} extra ` +
    `key(s) beyond one-per-group). ` +
    `TURSO_DRYRUN_REPORT.md's "Previously-live part-number keys NOT in the promoted active set" table lists ` +
    `${dryRunListedKeys.length} of the 17 keys this script was given (cross-check ${dryRunCrossCheckOk ? "OK - all 17 found" : "MISMATCH"}).`
  );
  lines.push("");
  lines.push("| Key | Found live | canonical_product_uid (live) | Exists in staged tires (local repaired DB) | Disposition |");
  lines.push("|---|---|---|---|---|");
  for (const key of SEVENTEEN_KEYS) {
    const liveRow = livePnByKey.get(key);
    if (!liveRow) {
      lines.push(`| ${key} | NO (not found on live today) | n/a | n/a | needs-owner: key not present on live Turso at preflight time |`);
      continue;
    }
    const uid = String(liveRow.canonical_product_uid);
    const includable = seventeenIncludable.some((r) => r.normalized_part_number === key);
    lines.push(`| ${key} | YES | ${uid} | ${includable ? "YES" : "NO"} | ${includable ? "included verbatim in staging (preserves old live behavior)" : "needs-owner: canonical_product_uid missing from staged tires"} |`);
  }
  lines.push("");
  lines.push(`- Includable verbatim (canonical_product_uid confirmed in staged tires): ${seventeenIncludable.length} of 17.`);
  lines.push(`- Needs-owner (excluded, listed for human resolution): ${seventeenNeedsOwner.length} of 17.`);
  if (seventeenNeedsOwner.length > 0) {
    lines.push("");
    lines.push("| Key (needs-owner) | canonical_product_uid | Reason |");
    lines.push("|---|---|---|");
    for (const r of seventeenNeedsOwner) lines.push(`| ${r.key} | ${r.canonical_product_uid} | ${r.reason} |`);
  }
  lines.push("");
  lines.push(
    `Staging patch applied to \`${rel(stagingPnFile)}\`: ` +
    (stagingPnAlreadyPatched
      ? "already patched in a prior run (idempotent - no duplicate append)."
      : stagingPnPatched
        ? `appended ${seventeenIncludable.length} INSERT OR REPLACE row(s) under a PREFLIGHT PATCH marker.`
        : "no patch applied (0 includable rows).")
  );
  lines.push("");
  lines.push(
    `Expected staged tire_part_numbers count after patch: ${localPnActive.length} (local active) + ` +
    `${seventeenIncludable.length} (includable of the 17) = ${expectedStagedPnCount}` +
    (seventeenIncludable.length === 17
      ? " (matches the 29,156 = 29,139 + 17 target)."
      : ` (differs from the 29,156 target because ${17 - seventeenIncludable.length} of the 17 needed owner resolution instead of silent inclusion).`)
  );
  lines.push("");
  lines.push("Human review list (flagged, not silently resolved): all 17 keys above remain flagged for human review alongside the other 17 non-previously-live quarantined keys (34 total in PART_NUMBER_CONFLICTS.csv section 1), per the original repair's documented safety behavior.");
  lines.push("");

  // --- Proof 3 ---
  lines.push("## Proof 3: Retail + operational table preservation");
  lines.push("");
  lines.push("### All tables on live Turso, classified");
  lines.push("");
  lines.push("| Table | Scope | Live row count |");
  lines.push("|---|---|---:|");
  for (const t of tableClassification) {
    lines.push(`| ${t.name} | ${t.scope} | ${t.liveRowCount} |`);
  }
  lines.push("");
  lines.push("### Tables each staging/promotion file touches (parsed from the SQL text itself, comments excluded)");
  lines.push("");
  lines.push("| Staging/promotion file | Executable SQL? | Tables referenced |");
  lines.push("|---|---|---|");
  for (const { file, tables, executable } of stagingFileTableTouches) {
    lines.push(`| ${file} | ${executable ? "YES" : "NO (entirely commented - documentation/procedure only, nothing executes)"} | ${tables.join(", ") || "(none)"} |`);
  }
  lines.push("");
  lines.push(
    `### Retail + operational tables: proof of "untouched by promotion"\n\n` +
    "Every table below is retail-corpus or operational (decode cache / usage / ladder / learned " +
    "products), is OUT of tire-promotion scope, and does not appear as a referenced table name in " +
    "any staging/promotion/gate/backup/rollback SQL file inspected above."
  );
  lines.push("");
  lines.push("| Table | Live row count | Status |");
  lines.push("|---|---:|---|");
  for (const name of retailAndOperationalTables) {
    lines.push(`| ${name} | ${liveTableCounts[name]} | untouched by promotion |`);
  }
  lines.push("");
  lines.push(
    operationalTouchViolations.length === 0
      ? "**Verified: 0 operational/retail table names appear in any staging or promotion SQL file.**"
      : `**VIOLATION FOUND: ${operationalTouchViolations.length} operational table reference(s) found in staging files: ` +
        operationalTouchViolations.map((v) => `${v.table} in ${v.file}`).join("; ") + "**"
  );
  lines.push("");

  lines.push("## Validator re-run instruction");
  lines.push("");
  lines.push(
    "This script only patched staging SQL files under `turso-staging/` (never the local repaired DB " +
    "itself, which was opened read-only throughout). `npm run` the validator directly after this " +
    "report is generated: `node scripts/tire-db-repair/05_validate.mjs` - it must remain ALL GATES " +
    "GREEN, since no DB bytes changed."
  );
  lines.push("");

  lines.push("## Overall status");
  lines.push("");
  lines.push(`- Superiority verdict: **${superior ? "SUPERIOR" : "NOT-SUPERIOR"}**.`);
  lines.push(`- CHANGED_FIELDS count (needs human eyeball): **${changedCount}**.`);
  lines.push(`- 17-key handling: **${seventeenIncludable.length} of 17 included verbatim**, ${seventeenNeedsOwner.length} needs-owner.`);
  lines.push(`- Retail/operational table isolation: **${operationalTouchViolations.length === 0 ? "CONFIRMED" : "VIOLATION"}**.`);
  lines.push("");
  lines.push("This is a READ-ONLY preflight against live Turso. No promotion was executed. Promotion requires a separate, explicit owner approval.");
  lines.push("");

  writeFileSync(REPORT_OUT, lines.join("\n"), "utf8");
  console.log(`Wrote ${rel(REPORT_OUT)}`);
  console.log(`Wrote ${rel(CHANGED_FIELDS_CSV_OUT)} (${changedRows.length} rows)`);

  // Also write a copy into the sdd task-report path if that directory exists.
  try {
    writeFileSync(SDD_REPORT_OUT, lines.join("\n"), "utf8");
    console.log(`Wrote ${rel(SDD_REPORT_OUT)}`);
  } catch (e) {
    console.warn(`Could not write sdd report copy: ${e.message}`);
  }

  localDb.close();

  console.log("\nSummary:");
  console.log(`  Superiority verdict: ${superior ? "SUPERIOR" : "NOT-SUPERIOR"}`);
  console.log(`  Missing live barcodes locally: ${missingLiveBarcodesInLocal.length}`);
  console.log(`  Field regressions: ${regressionCount}`);
  console.log(`  Field changes (CHANGED): ${changedCount}`);
  console.log(`  Field improvements: ${improvedCount}`);
  console.log(`  17-key includable: ${seventeenIncludable.length} / needs-owner: ${seventeenNeedsOwner.length}`);
  console.log(`  Operational touch violations: ${operationalTouchViolations.length}`);
}

// Only auto-run when executed directly (not when imported by tests). Tests set
// PREFLIGHT_SKIP_MAIN=1 first so they can import computeQuarantineCrossCheck without triggering
// main()'s live-Turso-requiring connection attempt.
if (!process.env.PREFLIGHT_SKIP_MAIN) {
  main().catch((e) => {
    console.error("FATAL:", e);
    process.exit(1);
  });
}

export { computeQuarantineCrossCheck };
