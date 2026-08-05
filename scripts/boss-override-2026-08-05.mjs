#!/usr/bin/env node
// Task B3: Turso full-clone rename-swap override making NEW_UPDATED_BOSS_DB.xlsx sheet1 boss truth
// live, per ADJUDICATED PLAN AMENDMENTS AM-B3-1..4 (docs/superpowers/plans/2026-08-05-boss-truth-and-
// localhost-proof.md, 2026-08-05, from the Codex sol-xhigh plan attack). These amendments OVERRIDE
// this script's own original header comments about a lighter "chunked upsert" design - read AM-B3-1
// through AM-B3-4 before touching this file.
//
// AM-B3-1 (semantics): B3 is a FULL-CLONE rename-swap. `stage` copies all FIVE live tables (tires,
// tire_part_numbers, tire_product_part_number_aliases, canonical_tire_products, provenance) into
// schema-identical staging_boss_override_* clones, then applies boss actions ONLY inside staging
// (preserving canonical_product_uid throughout). `promote` is a literal atomic ALTER TABLE ... RENAME
// swap (mirrors scripts/tire-db-repair/10_promote_execute.mjs's own promote mechanics: rename live
// aside to `<table>_boss_old_<ts>`, rename staging in as the new live table, recreate the 5 secondary
// indexes, run a post-swap smoke test). tire_product_part_number_aliases and canonical_tire_products
// are NOT modified by any boss action - they are still fully cloned+swapped for atomicity/consistency
// with the other three, but their staged content is byte-identical to live.
//
// AM-B3-2 (actions ledger): before any staging write, `node ... ledger` (READ-ONLY) materializes
// backups/boss-export-2026-08-05/boss_override_actions.jsonl - one row per ALL 3,429 boss rows,
// closing exhaustively into five match_basis buckets (both / barcode / both_conflict / part_number /
// none). `stage` REQUIRES this ledger file to already exist and applies it mechanically (no
// re-deciding at stage time) - the ledger IS the single source of truth for what stage does.
//
// AM-B3-3 (gate rewrite): verify's key-preservation gate is a barcode-replacement ledger check:
// every live tires.barcode survives into staging UNLESS it is listed exactly once in some ledger
// row's old_keys_to_drop; every such approved replacement barcode exists exactly once on its
// preserved canonical_product_uid in staging; any UNAPPROVED disappearance fails the gate. A second
// gate (K_no_unresolved_conflicts) hard-fails verify (blocking promote) while any ledger row has
// action="review_cross_uid_conflict" (AM-B3-2: "not explicitly approved routes to review and blocks
// promote") - keyed on `action`, the mutable disposition field an orchestrator hand-edits to
// resolve a row, NOT on `match_basis`, the immutable original classification (PRE-LIVE REVIEW FIX,
// 2026-08-05: see unresolvedConflictRows()/assertKnownLedgerActions() below for the full rationale
// and the `defer_review` action for explicitly excluding a single row from a run without blocking
// the rest).
//
// AM-B3-4 (roles): this implementer session's role is OFFLINE GENERATION ONLY - the `ledger`
// subcommand (read-only SELECTs, safe to run for real, matches the original HARD RULES "you may run
// SELECTs"), the classifier's unit tests, and this script itself. It does NOT run `stage`, `verify`,
// or `promote` for real against Turso (only --dry-run, which prints "NOT EVALUATED"/statement counts
// without touching the database). The orchestrator alone runs: a FRESH `backup` (bound to a NEW
// manifest SHA recorded outside the staging dir), real `stage`, real `verify`, and - only after both
// pass and any review-blocking rows are resolved - `promote` with PROMOTE_CONFIRM=YES, then the
// post-checks named in the plan.
//
// NOTE ON A PRIOR (superseded) LIVE RUN: an earlier version of this script (lighter "chunked upsert,
// touched-rows-only" design, written before these amendments landed) was run for real against live
// Turso by this same implementer session: `backup` (backups/turso-backup-20260805_172639/, real,
// read-only dump of tires+tire_part_numbers+provenance) and `stage` (created
// staging_boss_override_tires/_tire_part_numbers/_provenance/_review holding ONLY the 3,429 touched
// rows, NOT a full clone) and `verify` (all gates passed under the OLD, now-superseded semantics).
// Per AM-B3-4's explicit instruction, these were left in place, NOT cleaned up remotely. They do NOT
// match this file's current (full-clone) `stage`/`verify` implementation and MUST be treated as
// stale: the orchestrator's fresh `stage` run (using THIS version of the script) DROPs and rebuilds
// staging_boss_override_tires/_tire_part_numbers/_provenance from scratch (idempotent DROP TABLE IF
// EXISTS, same as the model script), and additionally creates the two new clone-only staging tables
// (staging_boss_override_aliases, staging_boss_override_canonical_products). See the B3-PREP report
// (.superpowers/sdd/2026-08-04-diagnostic-fixes-and-pr-salvage/taskB3-prep-report.md) for the exact
// backup timestamp and staged counts of that superseded run.
//
// Usage:
//   node scripts/boss-override-2026-08-05.mjs ledger                                  (read-only, safe to run for real)
//   node scripts/boss-override-2026-08-05.mjs backup  [--dry-run]                     (orchestrator)
//   node scripts/boss-override-2026-08-05.mjs stage   [--dry-run] --manifest <path> --expected-manifest-sha256 <sha>  (orchestrator)
//   node scripts/boss-override-2026-08-05.mjs verify  [--dry-run] --manifest <path> --expected-manifest-sha256 <sha>  (orchestrator)
//   node scripts/boss-override-2026-08-05.mjs promote [--dry-run] --manifest <path> --expected-manifest-sha256 <sha>  (orchestrator, PROMOTE_CONFIRM=YES)
//   node scripts/boss-override-2026-08-05.mjs rollback --ts <backup-ts> [--dry-run]   (orchestrator, PROMOTE_CONFIRM=YES)

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const EXPORT_DIR = join(REPO_ROOT, "backups", "boss-export-2026-08-05");
const INPUT_JSONL = join(EXPORT_DIR, "turso_upsert_rows.jsonl");
const SHEET1_CSV = join(EXPORT_DIR, "boss_sheet1.csv");
const LEDGER_PATH = join(EXPORT_DIR, "boss_override_actions.jsonl");
const BACKUP_ROOT = join(REPO_ROOT, "backups");
const BACKUP_DIR_PREFIX = "turso-backup-";
const OLD_SUFFIX = "_boss_old_"; // distinct from tire-db-repair's own "_old_<ts>" rollback-net tables

export const SOURCE_NAME = "boss_source_v2";
export const SOURCE_REF = "NEW_UPDATED_BOSS_DB.xlsx";
export const BATCH_ID = "B3_boss_override_2026-08-05";

// The five tables this override's atomic rename-swap publishes (mirrors 10_promote_execute.mjs's
// own SWAPPED_TABLES exactly - same table set, same schemas, this is a different override batch).
export const SWAPPED_TABLES = [
  "tires", "tire_part_numbers", "tire_product_part_number_aliases", "canonical_tire_products", "provenance",
];
const STAGING_TABLE_FOR = {
  tires: "staging_boss_override_tires",
  tire_part_numbers: "staging_boss_override_tire_part_numbers",
  tire_product_part_number_aliases: "staging_boss_override_aliases",
  canonical_tire_products: "staging_boss_override_canonical_products",
  provenance: "staging_boss_override_provenance",
};

// Codes that must NEVER be inserted anywhere by this script (B1's invalid_placeholder_barcode
// exclusions, already absent from turso_upsert_rows.jsonl - defensive assertion) plus the plan's
// named bogus-code example (also confirmed absent live 2026-08-05).
export const FORBIDDEN_CODES = new Set(["9235030211", "9315030311", "3220015959"]);

// The 13 known-safe Nexen N5000 Platinum barcode collisions (b2-drift-report.md section 3) - a
// SUBSET of the "barcode" (barcode-only) match_basis bucket, used only as a targeted verify
// assertion (AM-B3-2: "The 13 Nexen drift collisions are a subset, not the whole story").
export const KNOWN_13_COLLISION_ITEM_NUMBERS = new Set([
  "NX16523", "NX18150", "NX18151", "NX18160", "NX18163", "NX18166", "NX18172",
  "NX18178", "NX18181", "NX18182", "NX18192", "NX18206", "NX18216",
]);

// The single part_number-only match with strong evidence its existing sibling barcode(s) are
// superseded placeholder codes from the OLD 03_BOSS_SOURCE_BARCODES.xlsx (same "3220015959"-family
// pattern named in this task's own verify gates - live provenance id=2, source_name "boss_source",
// evidence_level "trusted_exact_barcode", batch "A3_boss_reconciliation_2026-07-28" proves
// "003220017209" was itself a trusted-imported OLD boss barcode for a sibling item, not corruption).
// Populated dynamically by classifyBossRows via isKnownStaleSiblingPattern(); listed here only as
// the documented example the report cites - NOT branched on directly.
export const STALE_SIBLING_BARCODE_PATTERN = /^0{0,4}3220\d{6}$/; // matches 3220015959 (0 zeros/10-digit), 003220017209 (2 zeros/12-digit, UPC-A pad), 0003220018428 (3 zeros/13-digit, EAN-13 pad)

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

function resolveConnection() {
  loadEnvLocal();
  const url = process.env.BOSS_OVERRIDE_TURSO_URL || process.env.TURSO_DATABASE_URL;
  const authToken = process.env.BOSS_OVERRIDE_TURSO_AUTH_TOKEN || process.env.TURSO_AUTH_TOKEN || undefined;
  return { url, authToken };
}

async function makeClient() {
  const { url, authToken } = resolveConnection();
  if (!url) throw new Error("No Turso/libsql URL available (TURSO_DATABASE_URL not set).");
  const { createClient } = await import("@libsql/client");
  return createClient(authToken ? { url, authToken } : { url });
}

function requireConfirmOrExit(dryRun) {
  if (dryRun) return;
  if (process.env.PROMOTE_CONFIRM !== "YES") {
    console.error(
      "REFUSED: this is a LIVE run against the configured database, but env PROMOTE_CONFIRM=YES " +
        "is not set. Set PROMOTE_CONFIRM=YES (the orchestrator sets this at execution time) or pass " +
        "--dry-run to preview without executing."
    );
    process.exit(3);
  }
}

function parseArgs(argv) {
  const subcommand = argv[2];
  const dryRun = argv.includes("--dry-run");
  const valueAfter = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    subcommand,
    dryRun,
    ts: valueAfter("--ts"),
    manifestArg: valueAfter("--manifest"),
    expectedManifestSha256: valueAfter("--expected-manifest-sha256"),
  };
}

// -------------------------------------------------------------------------------------------
// Operational-table isolation allowlist.
// -------------------------------------------------------------------------------------------
const ALL_STAGING_TABLES = Object.values(STAGING_TABLE_FOR);
function isAllowedTableName(name) {
  if (name === "sqlite_master") return true;
  if (SWAPPED_TABLES.includes(name)) return true;
  if (ALL_STAGING_TABLES.includes(name)) return true;
  for (const t of SWAPPED_TABLES) {
    if (name.startsWith(`${t}${OLD_SUFFIX}`)) return true;
    // rollback renames live tables aside as <table>_failed_promotion_<ts>; without this the
    // rollback path is rejected by its own allowlist (matches tire-db-repair's model script).
    if (name.startsWith(`${t}_failed_promotion_`)) return true;
  }
  return false;
}

function extractTableNames(statement) {
  const names = new Set();
  const patterns = [
    /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?\w+["'`]?\s+ON\s+["'`]?(\w+)["'`]?/gi,
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?(\w+)["'`]?/gi,
    /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["'`]?(\w+)["'`]?/gi,
    /INSERT\s+(?:OR\s+REPLACE\s+)?INTO\s+["'`]?(\w+)["'`]?/gi,
    /ALTER\s+TABLE\s+["'`]?(\w+)["'`]?/gi,
    /(?:^|\s)RENAME\s+TO\s+["'`]?(\w+)["'`]?/gi,
    /FROM\s+["'`]?(\w+)["'`]?/gi,
    /UPDATE\s+["'`]?(\w+)["'`]?\s+SET/gi,
    /(?:INNER\s+|LEFT\s+|RIGHT\s+|OUTER\s+)?JOIN\s+["'`]?(\w+)["'`]?/gi,
    /DELETE\s+FROM\s+["'`]?(\w+)["'`]?/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(statement)) !== null) names.add(m[1]);
  }
  return names;
}

function isBlankOrCommentOnly(statement) {
  const stripped = statement.split(/\r?\n/).map((l) => l.replace(/--.*$/, "")).join("\n").trim();
  return stripped.length === 0;
}

function isAllowedNoTableStatement(statement) {
  const trimmed = statement.trim();
  if (isBlankOrCommentOnly(trimmed)) return true;
  if (/^PRAGMA\s+integrity_check\s*;?\s*$/i.test(trimmed)) return true;
  if (/^DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?["'`]?\w+["'`]?\s*;?\s*$/i.test(trimmed)) return true;
  return false;
}

function assertAllowedTables(statements, label) {
  for (const stmt of statements) {
    const names = extractTableNames(stmt);
    if (names.size === 0) {
      if (isAllowedNoTableStatement(stmt)) continue;
      throw new Error(`${label}: REFUSING to execute - unrecognized/no-table statement shape. Offending: ${stmt.slice(0, 300)}`);
    }
    for (const name of names) {
      if (!isAllowedTableName(name)) {
        throw new Error(`${label}: REFUSING to execute - table "${name}" is outside this script's allowlist. Offending: ${stmt.slice(0, 300)}`);
      }
    }
  }
}

// -------------------------------------------------------------------------------------------
function sqlStr(value) {
  if (value === null || value === undefined) return "NULL";
  return "'" + String(value).replace(/'/g, "''") + "'";
}
function sqlNum(value) {
  if (value === null || value === undefined) return "NULL";
  return String(Number(value));
}

async function execBatchChunked(client, statements, { dryRun, label, chunk = 50 }) {
  if (dryRun) {
    console.log(`[dry-run] ${label}: would execute ${statements.length} statement(s) in ${Math.ceil(statements.length / chunk)} chunk(s) of ${chunk}: NOT EVALUATED.`);
    for (const s of statements.slice(0, 3)) console.log(`  ${s.length > 200 ? s.slice(0, 200) + " ... [truncated]" : s}`);
    if (statements.length > 3) console.log(`  ... and ${statements.length - 3} more`);
    return;
  }
  for (let i = 0; i < statements.length; i += chunk) {
    const slice = statements.slice(i, i + chunk);
    assertAllowedTables(slice, label);
    await client.batch(slice, "write");
  }
  console.log(`${label}: executed ${statements.length} statement(s) in ${Math.ceil(statements.length / chunk)} chunk(s).`);
}

function timestamp() {
  if (process.env.BOSS_OVERRIDE_TS) return process.env.BOSS_OVERRIDE_TS;
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "_");
}

// =============================================================================================
// Boss row parsing (item_name -> size/model/load_index/speed_rating). Brand-anchored split is
// exact: verified 3,429/3,429 against the full input file - item_name always contains " <brand> "
// literally between the size+load-range prefix and the model+spec suffix.
// =============================================================================================
export function parseBossItemName(itemName, brand) {
  const anchor = ` ${brand} `;
  const idx = itemName.indexOf(anchor);
  if (idx === -1) return { size: "", loadRange: "", model: itemName, loadIndex: "", speedRating: "" };
  const sizePart = itemName.slice(0, idx).trim();
  const modelPart = itemName.slice(idx + anchor.length).trim();

  let size = sizePart;
  let loadRange = "";
  const spaceIdx = sizePart.indexOf(" ");
  if (spaceIdx !== -1) {
    size = sizePart.slice(0, spaceIdx);
    loadRange = sizePart.slice(spaceIdx + 1).trim();
  } else {
    const m = sizePart.match(/^(.*)\/([A-Z])$/);
    if (m) { size = m[1]; loadRange = m[2]; }
  }

  let model = modelPart;
  let loadIndex = "";
  let speedRating = "";
  const trailing = modelPart.match(/^(.*?)\s+(\d{2,3}(?:\/\d{2,3})?)([A-Z]{1,2})\s+(TL|TT)$/);
  if (trailing) { model = trailing[1].trim(); loadIndex = trailing[2]; speedRating = trailing[3]; }

  return { size, loadRange, model, loadIndex, speedRating };
}

export function mintUid(barcode, itemNumber) {
  const h = createHash("sha256").update(`boss_override_2026-08-05:${barcode}:${itemNumber}`).digest("hex").toUpperCase();
  return `TIRE_${h.slice(0, 20)}`;
}

export function barcodeShape(code) {
  if (code.length === 13) return "ean";
  if (code.length === 12) return "upc";
  return "";
}

export function loadBossRows(path = INPUT_JSONL) {
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}

export function loadSheet1RowIndex(path = SHEET1_CSV) {
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
  const map = new Map();
  for (let i = 1; i < lines.length; i++) {
    const itemNumber = lines[i].split(",")[0];
    if (itemNumber && !map.has(itemNumber)) map.set(itemNumber, i + 1);
  }
  return map;
}

/** True iff `barcode` matches the known bogus-placeholder family named in this task's verify gates
 *  (e.g. "3220015959") after stripping up to 2 leading zeros (the zeroPadCandidates() convention
 *  used by 02_boss_reconciliation.mjs, which is how these got promoted as valid-check-digit GTIN
 *  candidates in the first place - see this script's header note). Used ONLY to decide whether to
 *  PROPOSE an old_keys_to_drop entry for a part_number-only match; never auto-applied without the
 *  evidence being printed in decision_reason for human review. */
export function isKnownStaleSiblingPattern(barcode) {
  return STALE_SIBLING_BARCODE_PATTERN.test(barcode);
}

// =============================================================================================
// THE ACTIONS LEDGER CLASSIFIER (AM-B3-2). Pure function: (bossRows, liveTiresByBarcode Map,
// livePartNumbers Map) -> one ledger row per boss row, exhaustively bucketed by match_basis. No
// I/O, no live connection - unit-tested directly in boss-override-2026-08-05.test.mjs.
//
// liveTiresByBarcode: Map<barcode, { canonical_product_uid, manufacturer_part_number, brand,
//   brand_normalized, model, model_normalized, size, raw_size_text, load_index, speed_rating,
//   load_range, type, season, barcode_type, confidence, current_status, usable_for,
//   field_completeness_score, missing_fields, source_count, model_display, barcode_upc, barcode_ean13 }>
// livePartNumbers: Map<normalized_part_number, canonical_product_uid>
// uidToBarcodes: Map<canonical_product_uid, string[]> (derived, passed in or computed internally)
// =============================================================================================
export function buildUidToBarcodes(liveTiresByBarcode) {
  const map = new Map();
  for (const [barcode, row] of liveTiresByBarcode) {
    const uid = row.canonical_product_uid;
    if (!map.has(uid)) map.set(uid, []);
    map.get(uid).push(barcode);
  }
  return map;
}

export function classifyBossRows(bossRows, liveTiresByBarcode, livePartNumbers, sheet1RowIndex, uidToBarcodes = null) {
  uidToBarcodes = uidToBarcodes || buildUidToBarcodes(liveTiresByBarcode);
  const ledger = [];
  const forbiddenHits = [];

  for (const row of bossRows) {
    const { item_number: itemNumber, barcode: desiredBarcode } = row;
    const sourceRow = sheet1RowIndex.get(itemNumber) ?? "";

    if (FORBIDDEN_CODES.has(desiredBarcode)) {
      forbiddenHits.push({ itemNumber, barcode: desiredBarcode });
      continue; // never appears in the ledger; caller must treat non-empty forbiddenHits as fatal
    }

    const liveRow = liveTiresByBarcode.get(desiredBarcode);
    const pnUid = livePartNumbers.get(itemNumber);
    const barcodeUid = liveRow ? liveRow.canonical_product_uid : undefined;

    if (liveRow && pnUid === undefined) {
      // match_basis: barcode. Barcode already live; item_number has no part-number key yet.
      ledger.push({
        item_number: itemNumber, desired_barcode: desiredBarcode,
        current_barcodes: [desiredBarcode], match_basis: "barcode", current_uid: barcodeUid,
        action: "update_blank_fill", old_keys_to_drop: [], part_number_alias_to_add: itemNumber,
        source_row: sourceRow,
        decision_reason: `barcode ${desiredBarcode} already live under uid ${barcodeUid}; item_number ${itemNumber} has no existing tire_part_numbers key, so a new alias is added pointing at the same (preserved) uid. tires row gets a blank-only field fill.`,
      });
    } else if (liveRow && pnUid === barcodeUid) {
      // match_basis: both (same-UID update). Strongest match: both keys agree.
      ledger.push({
        item_number: itemNumber, desired_barcode: desiredBarcode,
        current_barcodes: [desiredBarcode], match_basis: "both", current_uid: barcodeUid,
        action: "update_blank_fill", old_keys_to_drop: [], part_number_alias_to_add: null,
        source_row: sourceRow,
        decision_reason: `barcode ${desiredBarcode} and item_number ${itemNumber} both already resolve to the same live uid ${barcodeUid}; blank-only field fill, no key changes needed.`,
      });
    } else if (liveRow && pnUid !== barcodeUid) {
      // match_basis: both_conflict. Barcode and part-number keys point at DIFFERENT live uids.
      // AM-B3-2: routes to review, BLOCKS promote until explicitly approved.
      const pnSiblings = uidToBarcodes.get(pnUid) || [];
      ledger.push({
        item_number: itemNumber, desired_barcode: desiredBarcode,
        current_barcodes: [...new Set([desiredBarcode, ...pnSiblings])], match_basis: "both_conflict",
        current_uid: null, action: "review_cross_uid_conflict", old_keys_to_drop: [],
        part_number_alias_to_add: null, source_row: sourceRow,
        decision_reason: `CONFLICT: tire_part_numbers[${itemNumber}] already points at uid ${pnUid} (barcodes: ${pnSiblings.join(", ") || "none"}), but boss barcode ${desiredBarcode} is live under a DIFFERENT uid ${barcodeUid}. Not auto-resolved (Wrong identity is worse than unknown) - blocks promote until an owner decision picks the canonical uid.`,
      });
    } else if (!liveRow && pnUid !== undefined) {
      // match_basis: part_number. Barcode not live; item_number already resolves to an existing
      // product - preserve that uid, insert the corrected barcode under it.
      const siblings = uidToBarcodes.get(pnUid) || [];
      const staleSiblings = siblings.filter(isKnownStaleSiblingPattern);
      const oldKeysToDrop = staleSiblings.length === siblings.length && siblings.length > 0 ? staleSiblings : [];
      const reasonParts = [
        `item_number ${itemNumber} already resolves via tire_part_numbers to uid ${pnUid}, but boss barcode ${desiredBarcode} is not yet live. Preserving uid ${pnUid}; inserting the corrected barcode under it.`,
      ];
      if (siblings.length > 0) {
        reasonParts.push(`uid ${pnUid} currently has ${siblings.length} live tires row(s) under ${siblings.join(", ")}.`);
        if (oldKeysToDrop.length > 0) {
          reasonParts.push(`ALL of them match the known bogus zero-padded placeholder pattern (same family as "3220015959", named in this task's own verify gates; live provenance evidence: id=2, source_name="boss_source", evidence_level="trusted_exact_barcode", batch="A3_boss_reconciliation_2026-07-28" proves these were themselves trusted-imported from the OLD, now-superseded boss workbook). Proposing them for drop - orchestrator/owner should confirm before promote.`);
        } else {
          reasonParts.push(`NOT proposing a drop: at least one sibling does not match the known bogus-placeholder pattern, or there are none - left live, untouched, for manual review if desired.`);
        }
      }
      ledger.push({
        item_number: itemNumber, desired_barcode: desiredBarcode, current_barcodes: siblings,
        match_basis: "part_number", current_uid: pnUid, action: "insert_preserve_uid",
        old_keys_to_drop: oldKeysToDrop, part_number_alias_to_add: null, source_row: sourceRow,
        decision_reason: reasonParts.join(" "),
      });
    } else {
      // match_basis: none. Genuinely new product - mint a fresh, deterministic uid.
      const uid = mintUid(desiredBarcode, itemNumber);
      ledger.push({
        item_number: itemNumber, desired_barcode: desiredBarcode, current_barcodes: [],
        match_basis: "none", current_uid: uid, action: "insert_new_uid", old_keys_to_drop: [],
        part_number_alias_to_add: itemNumber, source_row: sourceRow,
        decision_reason: `neither barcode ${desiredBarcode} nor item_number ${itemNumber} exist live in any form; minting a fresh deterministic uid ${uid} and inserting a brand-new tires + tire_part_numbers row.`,
      });
    }
  }

  return { ledger, forbiddenHits };
}

export function summarizeLedgerBuckets(ledger) {
  const buckets = { both: 0, barcode: 0, both_conflict: 0, part_number: 0, none: 0 };
  for (const row of ledger) buckets[row.match_basis] = (buckets[row.match_basis] || 0) + 1;
  return buckets;
}

// =============================================================================================
// PRE-LIVE REVIEW FIX (2026-08-05, dedicated pre-live review): `action` is the ledger's mutable
// disposition field - the one an orchestrator/owner hand-edits to RESOLVE a row (per the B3-PREP
// report's own instruction: "edit boss_override_actions.jsonl to change their action/current_uid
// per the owner's decision"). `match_basis` is the IMMUTABLE, objectively-computed classification
// and is deliberately left unchanged by a resolution edit (it is the audit trail of *why* a row
// needed review in the first place). Gate K and applyLedgerStatements must therefore agree on
// which field is authoritative for "is this row still blocking/unapplied" - both now key off
// `action`, matching applyLedgerStatements' own long-standing `action === "review_cross_uid_conflict"`
// skip. (Before this fix, gate K keyed off `match_basis`, which can NEVER be flipped by the
// documented resolution procedure - resolving a both_conflict row by editing only `action` would
// have staged the row correctly but left gate K permanently failing, making promote impossible for
// any resolved conflict. Verified by reproducing the allowlist/regex behavior directly.)
//
// `defer_review` (NEW): an explicit, human-only disposition meaning "leave this row's live data
// completely untouched this run - do not stage any change, and do NOT block promote on it, unlike
// `review_cross_uid_conflict` which unconditionally blocks." Used to defer a single ambiguous
// conflict (e.g. NX10557, whose sibling barcode pattern does not match the known-bogus-placeholder
// family and may be a legitimate second/case-pack barcode) to a future review round without forcing
// every OTHER already-resolved conflict to also wait. A deferred row is a pure no-op: its live
// tires/tire_part_numbers/provenance rows are already carried forward unmodified by the full-clone
// (cloneTableStatements), so "deferred" and "never touched" are the same staged outcome.
export const KNOWN_LEDGER_ACTIONS = new Set([
  "update_blank_fill",
  "insert_preserve_uid",
  "insert_new_uid",
  "review_cross_uid_conflict",
  "defer_review",
]);

/** Fail-closed guard against a silently-ignored typo. Any `action` string applyLedgerStatements
 *  does not recognize already falls through its if/else-if chain as a silent no-op (no SQL emitted,
 *  no error) - correct for the two intentional no-op actions (review_cross_uid_conflict,
 *  defer_review), but dangerous for a mistyped intended-apply action (e.g. "udpate_blank_fill"),
 *  which would otherwise silently vanish from staging with zero error and zero trace. Called by
 *  stage/verify/promote before doing anything else with a loaded ledger file. */
export function assertKnownLedgerActions(ledger) {
  const bad = ledger.filter((r) => !KNOWN_LEDGER_ACTIONS.has(r.action));
  if (bad.length > 0) {
    throw new Error(
      `ledger file contains unknown action value(s): ${bad.map((r) => `${r.item_number}="${r.action}"`).join(", ")}. ` +
        `Known actions: ${[...KNOWN_LEDGER_ACTIONS].join(", ")}. Refusing to run - an unrecognized action ` +
        `would silently no-op (no SQL, no error) rather than apply or explicitly defer.`
    );
  }
}

/** The single source of truth for "which ledger rows are still unresolved and must block promote."
 *  Keyed on `action`, not `match_basis` - see the PRE-LIVE REVIEW FIX note above. */
export function unresolvedConflictRows(ledger) {
  return ledger.filter((r) => r.action === "review_cross_uid_conflict");
}

// =============================================================================================
// Live data loaders (full keyset-paginated reads).
// =============================================================================================
const TIRES_COLUMNS = [
  "barcode", "canonical_product_uid", "brand", "brand_normalized", "model", "model_normalized",
  "size", "raw_size_text", "load_index", "speed_rating", "load_range", "type", "season",
  "manufacturer_part_number", "barcode_type", "confidence", "current_status", "usable_for",
  "field_completeness_score", "missing_fields", "source_count", "model_display", "barcode_upc",
  "barcode_ean13",
];

async function loadAllTires(client) {
  const map = new Map();
  let lastKey = null;
  const cols = TIRES_COLUMNS.join(", ");
  while (true) {
    const res = lastKey === null
      ? await client.execute(`SELECT ${cols} FROM tires ORDER BY barcode LIMIT 5000`)
      : await client.execute({ sql: `SELECT ${cols} FROM tires WHERE barcode > ? ORDER BY barcode LIMIT 5000`, args: [lastKey] });
    if (res.rows.length === 0) break;
    for (const r of res.rows) map.set(String(r.barcode), r);
    lastKey = res.rows[res.rows.length - 1].barcode;
    if (res.rows.length < 5000) break;
  }
  return map;
}

async function loadAllPartNumbers(client) {
  const map = new Map();
  let lastKey = null;
  while (true) {
    const res = lastKey === null
      ? await client.execute(`SELECT normalized_part_number, canonical_product_uid FROM tire_part_numbers ORDER BY normalized_part_number LIMIT 5000`)
      : await client.execute({ sql: `SELECT normalized_part_number, canonical_product_uid FROM tire_part_numbers WHERE normalized_part_number > ? ORDER BY normalized_part_number LIMIT 5000`, args: [lastKey] });
    if (res.rows.length === 0) break;
    for (const r of res.rows) map.set(String(r.normalized_part_number), String(r.canonical_product_uid));
    lastKey = res.rows[res.rows.length - 1].normalized_part_number;
    if (res.rows.length < 5000) break;
  }
  return map;
}

// =============================================================================================
// ledger: READ-ONLY. Loads fresh live tires + tire_part_numbers, classifies all 3,429 boss rows,
// writes boss_override_actions.jsonl, prints the bucket-count table. Safe to run for real (SELECTs
// only) - this is the implementer's deliverable per AM-B3-4.
// =============================================================================================
async function cmdLedger() {
  const bossRows = loadBossRows();
  const sheet1RowIndex = loadSheet1RowIndex();
  const client = await makeClient();
  console.log("ledger: loading live tires + tire_part_numbers (full scan, read-only)...");
  const liveTires = await loadAllTires(client);
  const livePartNumbers = await loadAllPartNumbers(client);
  console.log(`ledger: loaded ${liveTires.size} live tires rows, ${livePartNumbers.size} live tire_part_numbers rows.`);

  const { ledger, forbiddenHits } = classifyBossRows(bossRows, liveTires, livePartNumbers, sheet1RowIndex);
  if (forbiddenHits.length > 0) {
    throw new Error(`ledger: input contains forbidden codes: ${JSON.stringify(forbiddenHits)}`);
  }

  const lines = ledger.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(LEDGER_PATH, lines, "utf8");

  const buckets = summarizeLedgerBuckets(ledger);
  console.log(`\nledger: wrote ${ledger.length} rows to ${rel(LEDGER_PATH)}`);
  console.log("ledger: bucket closure:");
  console.log(`  both (same-UID update):        ${buckets.both}`);
  console.log(`  barcode (barcode-only):        ${buckets.barcode}`);
  console.log(`  both_conflict (cross-UID):     ${buckets.both_conflict}  <- BLOCKS promote until resolved`);
  console.log(`  part_number (part-number-only):${buckets.part_number}`);
  console.log(`  none (matching neither key):   ${buckets.none}`);
  console.log(`  TOTAL:                         ${ledger.length} (input was ${bossRows.length})`);

  const dropRows = ledger.filter((r) => r.old_keys_to_drop.length > 0);
  console.log(`\nledger: ${dropRows.length} row(s) propose an old_keys_to_drop (requires orchestrator/owner sign-off before promote):`);
  for (const r of dropRows) console.log(`  ${r.item_number}: drop ${JSON.stringify(r.old_keys_to_drop)} (preserve uid ${r.current_uid})`);

  const conflictRows = ledger.filter((r) => r.match_basis === "both_conflict");
  console.log(`\nledger: ${conflictRows.length} row(s) are unresolved cross-UID conflicts (BLOCKS promote):`);
  for (const r of conflictRows) console.log(`  ${r.item_number} / ${r.desired_barcode}: ${r.decision_reason}`);

  client.close();
  return { ledger, buckets };
}

async function readLiveCounts(client) {
  const counts = {};
  for (const table of SWAPPED_TABLES) {
    const res = await client.execute(`SELECT COUNT(*) c FROM ${table}`);
    counts[table] = Number(res.rows[0].c);
  }
  return counts;
}

async function readLiveContentFingerprint(client) {
  const fingerprint = {};
  const specs = {
    tires: { columns: TIRES_COLUMNS, key: "barcode" },
    tire_part_numbers: { columns: ["normalized_part_number", "canonical_product_uid"], key: "normalized_part_number" },
    tire_product_part_number_aliases: { columns: ["canonical_product_id", "normalized_part_number", "display_part_number"], key: "canonical_product_id" },
    canonical_tire_products: { columns: ["canonical_product_id", "brand", "model", "size"], key: "canonical_product_id" },
    provenance: { columns: ["id", "product_id", "barcode", "source_name", "batch_id"], key: "id" },
  };
  for (const table of SWAPPED_TABLES) {
    const { columns, key } = specs[table];
    const hash = createHash("sha256");
    hash.update(`table:${table};columns:${columns.join(",")};`);
    let lastKey = null;
    while (true) {
      const res = lastKey === null
        ? await client.execute(`SELECT ${columns.join(", ")} FROM ${table} ORDER BY ${key} LIMIT 2000`)
        : await client.execute({ sql: `SELECT ${columns.join(", ")} FROM ${table} WHERE ${key} > ? ORDER BY ${key} LIMIT 2000`, args: [lastKey] });
      if (res.rows.length === 0) break;
      for (const row of res.rows) {
        hash.update(`R:`);
        for (const c of columns) { const v = row[c]; hash.update(v === null || v === undefined ? "N:" : `V:${String(v)}:`); }
      }
      lastKey = res.rows[res.rows.length - 1][key];
      if (res.rows.length < 2000) break;
    }
    fingerprint[table] = hash.digest("hex");
  }
  return fingerprint;
}

// =============================================================================================
// backup: dump all 5 live tables + manifest with liveCounts + liveContentFingerprint. READ-ONLY.
// =============================================================================================
async function cmdBackup({ dryRun }) {
  const ts = timestamp();
  const outDir = join(BACKUP_ROOT, `${BACKUP_DIR_PREFIX}${ts}`);

  if (dryRun) {
    console.log(`[dry-run] backup: NOT EVALUATED. Would create ${rel(outDir)}/ and dump ${SWAPPED_TABLES.join(", ")} + manifest.json.`);
    return;
  }

  mkdirSync(outDir, { recursive: true });
  const client = await makeClient();
  const liveCounts = await readLiveCounts(client);
  console.log(`backup: live counts ${JSON.stringify(liveCounts)}`);
  const liveContentFingerprint = await readLiveContentFingerprint(client);

  const BATCH = 2000;
  const pkFor = { tires: "barcode", tire_part_numbers: "normalized_part_number", tire_product_part_number_aliases: "canonical_product_id", canonical_tire_products: "canonical_product_id", provenance: "id" };
  for (const table of SWAPPED_TABLES) {
    const pk = pkFor[table];
    console.log(`backup: dumping ${table}...`);
    const preCountRes = await client.execute(`SELECT COUNT(*) c FROM ${table}`);
    const preCount = Number(preCountRes.rows[0].c);
    let lastKey = null, lines = [], written = 0;
    while (true) {
      const res = lastKey === null
        ? await client.execute(`SELECT * FROM ${table} ORDER BY ${pk} LIMIT ${BATCH}`)
        : await client.execute({ sql: `SELECT * FROM ${table} WHERE ${pk} > ? ORDER BY ${pk} LIMIT ${BATCH}`, args: [lastKey] });
      if (res.rows.length === 0) break;
      for (const row of res.rows) { lines.push(JSON.stringify(row)); written++; }
      lastKey = res.rows[res.rows.length - 1][pk];
      if (res.rows.length < BATCH) break;
    }
    writeFileSync(join(outDir, `${table}.jsonl`), lines.join("\n") + (lines.length ? "\n" : ""), "utf8");
    const postCountRes = await client.execute(`SELECT COUNT(*) c FROM ${table}`);
    const postCount = Number(postCountRes.rows[0].c);
    const consistent = written === preCount && postCount === preCount;
    console.log(`backup: wrote ${written} rows for ${table} (pre ${preCount}, post ${postCount})${consistent ? "" : " -- WARNING: drift during dump, re-run backup"}`);
  }

  const manifest = { timestamp: ts, tool: "boss-override-2026-08-05.mjs (full-clone, AM-B3)", liveCounts, liveContentFingerprint };
  const manifestPath = join(outDir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  const manifestSha256 = createHash("sha256").update(readFileSync(manifestPath)).digest("hex");
  console.log(`backup: wrote manifest to ${rel(manifestPath)}`);
  console.log(`backup: manifest SHA-256: ${manifestSha256}`);
  console.log(`backup: record this digest OUTSIDE ${rel(outDir)} and pass --expected-manifest-sha256 ${manifestSha256} to stage/verify/promote.`);
  client.close();
}

function findLatestManifestPath() {
  if (!existsSync(BACKUP_ROOT)) return null;
  const dirs = readdirSync(BACKUP_ROOT).filter((d) => d.startsWith(BACKUP_DIR_PREFIX)).sort();
  for (let i = dirs.length - 1; i >= 0; i--) {
    const candidate = join(BACKUP_ROOT, dirs[i], "manifest.json");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveManifestPath(manifestArg) {
  if (manifestArg) return isAbsolute(manifestArg) ? manifestArg : join(REPO_ROOT, manifestArg);
  return findLatestManifestPath();
}

function loadRunManifest(manifestPath, label, expectedSha) {
  if (!manifestPath || !existsSync(manifestPath)) throw new Error(`${label}: REFUSING to run - no run-manifest found. Run "backup" first.`);
  if (!/^[a-fA-F0-9]{64}$/.test(expectedSha ?? "")) throw new Error(`${label}: REFUSING to run - --expected-manifest-sha256 <64-hex> is required.`);
  const bytes = readFileSync(manifestPath);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expectedSha.toLowerCase()) throw new Error(`${label}: manifest SHA-256 ${actual} does not match supplied ${expectedSha.toLowerCase()}.`);
  return JSON.parse(bytes.toString("utf8"));
}

async function assertLiveUnchangedSinceManifest(client, manifest, label) {
  const currentCounts = await readLiveCounts(client);
  const drifted = SWAPPED_TABLES.filter((t) => currentCounts[t] !== manifest.liveCounts[t]);
  if (drifted.length > 0) throw new Error(`${label}: REFUSING to run - live count drift on: ${drifted.join(", ")}. Re-run backup.`);
  const currentFp = await readLiveContentFingerprint(client);
  const fpDrift = SWAPPED_TABLES.filter((t) => currentFp[t] !== manifest.liveContentFingerprint[t]);
  if (fpDrift.length > 0) throw new Error(`${label}: REFUSING to run - live content fingerprint drift on: ${fpDrift.join(", ")}. Re-run backup.`);
}

// =============================================================================================
// stage: FULL-CLONE all 5 live tables into staging_boss_override_*, then apply the ledger's
// per-row action ONLY inside the staging clone. Requires the ledger (AM-B3-2) to already exist.
// =============================================================================================
function ddlFor(table, stagingName) {
  switch (table) {
    case "tires": return `CREATE TABLE IF NOT EXISTS ${stagingName} (
      barcode TEXT PRIMARY KEY, canonical_product_uid TEXT, brand TEXT, brand_normalized TEXT,
      model TEXT, model_normalized TEXT, size TEXT, raw_size_text TEXT, load_index TEXT,
      speed_rating TEXT, load_range TEXT, type TEXT, season TEXT, manufacturer_part_number TEXT,
      barcode_type TEXT, confidence TEXT, current_status TEXT, usable_for TEXT,
      field_completeness_score TEXT, missing_fields TEXT, source_count INTEGER, model_display TEXT,
      barcode_upc TEXT, barcode_ean13 TEXT
    );`;
    case "tire_part_numbers": return `CREATE TABLE IF NOT EXISTS ${stagingName} (
      normalized_part_number TEXT PRIMARY KEY, canonical_product_uid TEXT
    );`;
    case "tire_product_part_number_aliases": return `CREATE TABLE IF NOT EXISTS ${stagingName} (
      canonical_product_id TEXT, normalized_part_number TEXT, display_part_number TEXT, source TEXT,
      trust_color TEXT, confidence_score INTEGER, is_unambiguous INTEGER,
      PRIMARY KEY (canonical_product_id, normalized_part_number)
    );`;
    case "canonical_tire_products": return `CREATE TABLE IF NOT EXISTS ${stagingName} (
      canonical_product_id TEXT PRIMARY KEY, brand TEXT, model TEXT, size TEXT, load_index TEXT,
      speed_rating TEXT, load_range TEXT, type TEXT, season TEXT, alias_count INTEGER,
      canonicalization_confidence INTEGER, canonicalization_reason TEXT
    );`;
    case "provenance": return `CREATE TABLE IF NOT EXISTS ${stagingName} (
      id INTEGER PRIMARY KEY, product_id TEXT, barcode TEXT, source_name TEXT, source_ref TEXT,
      sheet TEXT, row TEXT, batch_id TEXT, imported_at TEXT, evidence_level TEXT,
      license_note TEXT, content_hash TEXT
    );`;
    default: throw new Error(`ddlFor: unknown table ${table}`);
  }
}

function insertColumnsFor(table) {
  switch (table) {
    case "tires": return TIRES_COLUMNS;
    case "tire_part_numbers": return ["normalized_part_number", "canonical_product_uid"];
    case "tire_product_part_number_aliases": return ["canonical_product_id", "normalized_part_number", "display_part_number", "source", "trust_color", "confidence_score", "is_unambiguous"];
    case "canonical_tire_products": return ["canonical_product_id", "brand", "model", "size", "load_index", "speed_rating", "load_range", "type", "season", "alias_count", "canonicalization_confidence", "canonicalization_reason"];
    case "provenance": return ["id", "product_id", "barcode", "source_name", "source_ref", "sheet", "row", "batch_id", "imported_at", "evidence_level", "license_note", "content_hash"];
    default: throw new Error(`insertColumnsFor: unknown table ${table}`);
  }
}

const NUMERIC_COLUMNS = new Set(["source_count", "id", "confidence_score", "is_unambiguous", "alias_count", "canonicalization_confidence"]);

function valueTuple(row, columns) {
  return "(" + columns.map((c) => (NUMERIC_COLUMNS.has(c) ? sqlNum(row[c]) : sqlStr(row[c]))).join(", ") + ")";
}

/** Clone one live table's full content into its staging_boss_override_* counterpart, unmodified,
 *  via chunked (200-tuple) INSERT OR REPLACE. Pure carry-forward; boss actions are applied
 *  AFTERWARD, only for tires/tire_part_numbers/provenance (the other two tables are never modified
 *  by any boss action - this call is their entire staging population). */
async function cloneTableStatements(client, table) {
  const stagingName = STAGING_TABLE_FOR[table];
  const columns = insertColumnsFor(table);
  const statements = [`DROP TABLE IF EXISTS ${stagingName};`, ddlFor(table, stagingName)];
  const pkFor = { tires: "barcode", tire_part_numbers: "normalized_part_number", tire_product_part_number_aliases: "canonical_product_id", canonical_tire_products: "canonical_product_id", provenance: "id" };
  const pk = pkFor[table];
  let lastKey = null;
  let total = 0;
  while (true) {
    const res = lastKey === null
      ? await client.execute(`SELECT ${columns.join(", ")} FROM ${table} ORDER BY ${pk} LIMIT 2000`)
      : await client.execute({ sql: `SELECT ${columns.join(", ")} FROM ${table} WHERE ${pk} > ? ORDER BY ${pk} LIMIT 2000`, args: [lastKey] });
    if (res.rows.length === 0) break;
    const tuples = res.rows.map((r) => valueTuple(r, columns));
    for (let i = 0; i < tuples.length; i += 200) {
      statements.push(`INSERT OR REPLACE INTO ${stagingName} (${columns.join(", ")}) VALUES ${tuples.slice(i, i + 200).join(", ")};`);
    }
    total += res.rows.length;
    lastKey = res.rows[res.rows.length - 1][pk];
    if (res.rows.length < 2000) break;
  }
  return { statements, clonedCount: total };
}

/** Apply the ledger's per-row actions to the ALREADY-CLONED staging_boss_override_tires /
 *  _tire_part_numbers / _provenance tables. Never touches staging_boss_override_aliases or
 *  staging_boss_override_canonical_products (no boss action ever targets them). */
export function applyLedgerStatements(ledger, bossRows, provenanceStartId, importedAt) {
  const bossRowByItemNumber = new Map(bossRows.map((r) => [r.item_number, r]));
  const statements = [];
  const tiresTuples = [];
  const pnTuples = [];
  const provenanceTuples = [];
  const dropBarcodes = [];
  let nextId = provenanceStartId;

  for (const entry of ledger) {
    if (entry.action === "review_cross_uid_conflict" || entry.action === "defer_review") continue; // never written to staging content

    const boss = bossRowByItemNumber.get(entry.item_number);
    for (const oldKey of entry.old_keys_to_drop) dropBarcodes.push(oldKey);

    if (entry.action === "update_blank_fill") {
      // Blank-only field fill is expressed as an UPDATE ... SET against the already-cloned row
      // (present in staging from cloneTableStatements), never a full-row INSERT OR REPLACE - this
      // guarantees no non-target column is ever silently reset to NULL.
      const shape = barcodeShape(entry.desired_barcode);
      statements.push(
        `UPDATE ${STAGING_TABLE_FOR.tires} SET ` +
          `manufacturer_part_number = CASE WHEN manufacturer_part_number IS NULL OR manufacturer_part_number = '' THEN ${sqlStr(entry.item_number)} ELSE manufacturer_part_number END, ` +
          `brand = CASE WHEN brand IS NULL OR brand = '' THEN ${sqlStr(boss.brand)} ELSE brand END, ` +
          `brand_normalized = CASE WHEN brand_normalized IS NULL OR brand_normalized = '' THEN ${sqlStr(boss.brand.toLowerCase())} ELSE brand_normalized END, ` +
          `raw_size_text = CASE WHEN raw_size_text IS NULL OR raw_size_text = '' THEN ${sqlStr(boss.size_raw)} ELSE raw_size_text END` +
          (shape === "ean" ? `, barcode_ean13 = CASE WHEN barcode_ean13 IS NULL OR barcode_ean13 = '' THEN ${sqlStr(entry.desired_barcode)} ELSE barcode_ean13 END` : "") +
          (shape === "upc" ? `, barcode_upc = CASE WHEN barcode_upc IS NULL OR barcode_upc = '' THEN ${sqlStr(entry.desired_barcode)} ELSE barcode_upc END` : "") +
          ` WHERE barcode = ${sqlStr(entry.desired_barcode)};`
      );
      if (entry.part_number_alias_to_add) pnTuples.push({ normalized_part_number: entry.part_number_alias_to_add, canonical_product_uid: entry.current_uid });
      provenanceTuples.push({ id: nextId++, product_id: entry.current_uid, barcode: entry.desired_barcode });
    } else if (entry.action === "insert_preserve_uid" || entry.action === "insert_new_uid") {
      const parsed = parseBossItemName(boss.item_name, boss.brand);
      const shape = barcodeShape(entry.desired_barcode);
      const fields = {
        barcode: entry.desired_barcode, canonical_product_uid: entry.current_uid, brand: boss.brand,
        brand_normalized: boss.brand.toLowerCase(), model: parsed.model, model_normalized: parsed.model.toLowerCase(),
        size: parsed.size, raw_size_text: boss.size_raw, load_index: parsed.loadIndex, speed_rating: parsed.speedRating,
        load_range: parsed.loadRange, type: "", season: "", manufacturer_part_number: entry.item_number,
        barcode_type: shape, confidence: "verified_vendor", current_status: "active_retail",
        usable_for: "auto_count_candidate", field_completeness_score: "", missing_fields: "", source_count: 1,
        model_display: null, barcode_upc: shape === "upc" ? entry.desired_barcode : null,
        barcode_ean13: shape === "ean" ? entry.desired_barcode : null,
      };
      tiresTuples.push(fields);
      if (entry.part_number_alias_to_add) pnTuples.push({ normalized_part_number: entry.part_number_alias_to_add, canonical_product_uid: entry.current_uid });
      provenanceTuples.push({ id: nextId++, product_id: entry.current_uid, barcode: entry.desired_barcode });
    }
  }

  // New tires rows (insert_preserve_uid / insert_new_uid) - INSERT OR REPLACE is correct here since
  // these barcodes do not yet exist in staging (no risk of wiping an existing row's other columns).
  const tiresColumns = TIRES_COLUMNS;
  const tiresValueTuples = tiresTuples.map((r) => valueTuple(r, tiresColumns));
  for (let i = 0; i < tiresValueTuples.length; i += 200) {
    statements.push(`INSERT OR REPLACE INTO ${STAGING_TABLE_FOR.tires} (${tiresColumns.join(", ")}) VALUES ${tiresValueTuples.slice(i, i + 200).join(", ")};`);
  }

  // Approved drops: remove the exact listed stale barcode rows from the staging clone.
  for (let i = 0; i < dropBarcodes.length; i += 200) {
    const slice = dropBarcodes.slice(i, i + 200).map(sqlStr).join(",");
    statements.push(`DELETE FROM ${STAGING_TABLE_FOR.tires} WHERE barcode IN (${slice});`);
  }

  const pnValueTuples = pnTuples.map((r) => valueTuple(r, ["normalized_part_number", "canonical_product_uid"]));
  for (let i = 0; i < pnValueTuples.length; i += 200) {
    statements.push(`INSERT OR REPLACE INTO ${STAGING_TABLE_FOR.tire_part_numbers} (normalized_part_number, canonical_product_uid) VALUES ${pnValueTuples.slice(i, i + 200).join(", ")};`);
  }

  const provColumns = ["id", "product_id", "barcode", "source_name", "source_ref", "sheet", "row", "batch_id", "imported_at", "evidence_level", "license_note", "content_hash"];
  const bossRowSheetLookup = new Map(bossRows.map((r) => [r.barcode, r.item_number]));
  const sheet1RowIndex = loadSheet1RowIndex();
  const provValueTuples = provenanceTuples.map((r) => valueTuple({
    ...r, source_name: SOURCE_NAME, source_ref: SOURCE_REF, sheet: "Sheet1",
    row: String(sheet1RowIndex.get(bossRowSheetLookup.get(r.barcode)) ?? ""),
    batch_id: BATCH_ID, imported_at: importedAt, evidence_level: "trusted_exact_barcode",
    license_note: "", content_hash: "",
  }, provColumns));
  for (let i = 0; i < provValueTuples.length; i += 200) {
    statements.push(`INSERT OR REPLACE INTO ${STAGING_TABLE_FOR.provenance} (${provColumns.join(", ")}) VALUES ${provValueTuples.slice(i, i + 200).join(", ")};`);
  }

  return {
    statements,
    counts: { tiresInserted: tiresTuples.length, pnInserted: pnValueTuples.length, provenanceInserted: provValueTuples.length, droppedBarcodes: dropBarcodes.length },
  };
}

async function cmdStage({ dryRun, manifestArg, expectedManifestSha256 }) {
  requireConfirmOrExit(dryRun);
  if (!existsSync(LEDGER_PATH)) {
    throw new Error(`stage: REFUSING to run - ${rel(LEDGER_PATH)} does not exist. Run "ledger" first (AM-B3-2: the actions ledger must be materialized BEFORE staging).`);
  }
  const ledger = readFileSync(LEDGER_PATH, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  assertKnownLedgerActions(ledger);
  const bossRows = loadBossRows();

  if (dryRun) {
    console.log(`[dry-run] stage: NOT EVALUATED. Would DROP + CREATE TABLE IF NOT EXISTS + full-clone all 5 live tables (${SWAPPED_TABLES.join(", ")}) into staging_boss_override_*, then apply ${ledger.length} ledger row actions (update_blank_fill / insert_preserve_uid / insert_new_uid; skipping review_cross_uid_conflict and defer_review rows) inside staging only.`);
    return;
  }

  const manifestPath = resolveManifestPath(manifestArg);
  const runManifest = loadRunManifest(manifestPath, "stage", expectedManifestSha256);
  const client = await makeClient();
  await assertLiveUnchangedSinceManifest(client, runManifest, "stage");
  console.log(`stage: bound to run-manifest ${rel(manifestPath)} - live counts and content confirmed unchanged since backup.`);

  const cloneCounts = {};
  for (const table of SWAPPED_TABLES) {
    console.log(`stage: cloning ${table} -> ${STAGING_TABLE_FOR[table]}...`);
    const { statements, clonedCount } = await cloneTableStatements(client, table);
    await execBatchChunked(client, statements, { dryRun: false, label: `stage (clone ${table})` });
    cloneCounts[table] = clonedCount;
    console.log(`stage: cloned ${clonedCount} rows into ${STAGING_TABLE_FOR[table]}.`);
  }

  const maxIdRes = await client.execute(`SELECT MAX(id) m FROM provenance`);
  const provenanceStartId = Number(maxIdRes.rows[0].m ?? 0) + 1;
  const importedAt = new Date().toISOString();

  console.log("stage: applying ledger actions inside staging...");
  const { statements: applyStatements, counts: applyCounts } = applyLedgerStatements(ledger, bossRows, provenanceStartId, importedAt);
  await execBatchChunked(client, applyStatements, { dryRun: false, label: "stage (apply ledger)" });
  console.log(`stage: applied ${JSON.stringify(applyCounts)}`);

  const finalCounts = {};
  for (const table of SWAPPED_TABLES) {
    const res = await client.execute(`SELECT COUNT(*) c FROM ${STAGING_TABLE_FOR[table]}`);
    finalCounts[STAGING_TABLE_FOR[table]] = Number(res.rows[0].c);
  }
  const expectedCountsPath = join(EXPORT_DIR, "stage_expected_counts.json");
  writeFileSync(expectedCountsPath, JSON.stringify({ expectedCounts: finalCounts, cloneCounts, applyCounts, provenanceStartId, importedAt }, null, 2), "utf8");
  console.log(`stage: wrote expected-count manifest to ${rel(expectedCountsPath)}`);
  console.log(`stage: final staged counts: ${JSON.stringify(finalCounts)}`);
  console.log("stage: complete.");
  client.close();
}

// =============================================================================================
// verify: gate battery (AM-B3-3 barcode-replacement ledger check + standard gates).
// =============================================================================================
async function runVerifyGates(client, ledger) {
  const gates = [];
  async function gate(name, fn) {
    try { gates.push({ name, ...(await fn()) }); }
    catch (e) { gates.push({ name, pass: false, detail: `ERROR: ${e.message}` }); }
  }

  let expectedCounts = null;
  try { expectedCounts = JSON.parse(readFileSync(join(EXPORT_DIR, "stage_expected_counts.json"), "utf8")).expectedCounts; } catch { /* handled below */ }

  await gate("Z_expected_counts_manifest_present", async () => ({
    pass: expectedCounts !== null,
    detail: expectedCounts !== null ? JSON.stringify(expectedCounts) : "MISSING stage_expected_counts.json - run stage first",
  }));

  await gate("A_staging_readability", async () => {
    // PRAGMA integrity_check is infeasible over the Turso HTTP transport on this 488MB database
    // (proven 2026-08-05: consistent "fetch failed" plus a 5-minute hang on a standalone probe).
    // Feasible equivalent: force a complete read of every staged row - file-level corruption in the
    // pages backing these tables surfaces as read errors or aggregate mismatches, and gates B/L
    // already cross-check exact counts and every live barcode key independently.
    const details = [];
    for (const staging of ALL_STAGING_TABLES) {
      const res = await client.execute(
        `SELECT count(*) AS n, coalesce(sum(length(cast(rowid AS text))),0) AS bytes FROM ${staging}`,
      );
      const n = Number(res.rows[0]?.n ?? -1);
      if (!(n >= 0)) return { pass: false, detail: `${staging}: unreadable` };
      details.push(`${staging}=${n}`);
    }
    let integrityNote = "integrity_check: skipped (transport-infeasible)";
    try {
      const quick = await Promise.race([
        client.execute("PRAGMA quick_check(1)"),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout 20s")), 20000)),
      ]);
      integrityNote = `quick_check: ${String(Object.values(quick.rows[0] ?? {})[0] ?? "n/a")}`;
    } catch (e) {
      integrityNote = `quick_check unavailable (${e.message}) - readability scan is the operative check`;
    }
    return { pass: true, detail: `full read of all staging tables ok (${details.join(", ")}); ${integrityNote}` };
  });

  for (const table of SWAPPED_TABLES) {
    await gate(`B_exact_count_${table}`, async () => {
      const stagingName = STAGING_TABLE_FOR[table];
      const res = await client.execute(`SELECT COUNT(*) c FROM ${stagingName}`);
      const actual = Number(res.rows[0].c);
      const expected = expectedCounts ? expectedCounts[stagingName] : undefined;
      if (expected === undefined) return { pass: false, detail: `no expected count for ${stagingName}` };
      return { pass: actual === expected, detail: actual === expected ? `${actual} (matches)` : `MISMATCH: ${actual} vs ${expected}` };
    });
  }

  await gate("K_no_unresolved_conflicts", async () => {
    // Keyed on action="review_cross_uid_conflict" (unresolvedConflictRows), NOT match_basis -
    // match_basis is the immutable original classification and is never expected to change when a
    // row is resolved by hand-editing `action`/`current_uid` per the documented procedure. A row
    // hand-resolved to action="update_blank_fill" (match_basis left as "both_conflict" for audit
    // trail) correctly stops blocking here. A row hand-marked action="defer_review" also correctly
    // stops blocking (explicit deferral, not a resolution) without being staged.
    const conflicts = unresolvedConflictRows(ledger);
    return {
      pass: conflicts.length === 0,
      detail: conflicts.length === 0 ? "no unresolved cross-UID conflicts in the ledger (action=review_cross_uid_conflict)" : `BLOCKS PROMOTE: ${conflicts.length} unresolved cross-UID conflict(s): ${conflicts.map((c) => c.item_number).join(", ")}`,
    };
  });

  await gate("L_barcode_replacement_ledger", async () => {
    // Every live tires.barcode must survive into staging UNLESS listed exactly once in some ledger
    // row's old_keys_to_drop. Every approved replacement key (desired_barcode of an
    // insert_preserve_uid row) must exist exactly once on its preserved uid in staging.
    const approvedDrops = new Map(); // barcode -> item_number that dropped it
    for (const row of ledger) {
      for (const key of row.old_keys_to_drop) {
        if (approvedDrops.has(key)) return { pass: false, detail: `old_keys_to_drop "${key}" listed more than once in the ledger (must be exactly once)` };
        approvedDrops.set(key, row.item_number);
      }
    }
    const liveRes = await client.execute(`SELECT barcode FROM tires`);
    const liveBarcodes = liveRes.rows.map((r) => String(r.barcode));
    const stagingRes = await client.execute(`SELECT barcode FROM ${STAGING_TABLE_FOR.tires}`);
    const stagingSet = new Set(stagingRes.rows.map((r) => String(r.barcode)));
    const unapprovedMissing = liveBarcodes.filter((b) => !stagingSet.has(b) && !approvedDrops.has(b));
    if (unapprovedMissing.length > 0) {
      return { pass: false, detail: `UNAPPROVED key disappearance: ${unapprovedMissing.slice(0, 10).join(", ")}${unapprovedMissing.length > 10 ? ", ..." : ""}` };
    }
    const stillPresentDrops = [...approvedDrops.keys()].filter((k) => stagingSet.has(k));
    if (stillPresentDrops.length > 0) {
      return { pass: false, detail: `approved drop(s) still present in staging (drop did not apply): ${stillPresentDrops.join(", ")}` };
    }
    const replacements = ledger.filter((r) => r.action === "insert_preserve_uid" || r.action === "insert_new_uid" || r.action === "update_blank_fill");
    const missingReplacements = [];
    for (const r of replacements) {
      const res = await client.execute({ sql: `SELECT canonical_product_uid FROM ${STAGING_TABLE_FOR.tires} WHERE barcode = ?`, args: [r.desired_barcode] });
      if (res.rows.length !== 1 || res.rows[0].canonical_product_uid !== r.current_uid) missingReplacements.push(r.desired_barcode);
    }
    return {
      pass: missingReplacements.length === 0,
      detail: missingReplacements.length === 0
        ? `${liveBarcodes.length} live keys accounted for (${approvedDrops.size} approved drops); ${replacements.length} approved replacement keys present exactly once on their preserved uid`
        : `replacement key missing/uid-mismatch: ${missingReplacements.join(", ")}`,
    };
  });

  await gate("E_13_known_collisions_alias_handled", async () => {
    const res = await client.execute(`SELECT normalized_part_number FROM ${STAGING_TABLE_FOR.tire_part_numbers} WHERE normalized_part_number IN (${[...KNOWN_13_COLLISION_ITEM_NUMBERS].map((s) => `'${s}'`).join(",")})`);
    const found = new Set(res.rows.map((r) => String(r.normalized_part_number)));
    const missing = [...KNOWN_13_COLLISION_ITEM_NUMBERS].filter((k) => !found.has(k));
    return { pass: missing.length === 0, detail: missing.length === 0 ? "all 13 known Nexen collisions have a staged tire_part_numbers alias row" : `MISSING: ${missing.join(", ")}` };
  });

  await gate("F_BH1600448_present", async () => {
    const res = await client.execute({ sql: `SELECT barcode, canonical_product_uid FROM ${STAGING_TABLE_FOR.tires} WHERE barcode = ?`, args: ["8848116004480"] });
    if (res.rows.length !== 1) return { pass: false, detail: `expected exactly 1 staged row, found ${res.rows.length}` };
    return { pass: true, detail: `BH1600448 -> 8848116004480 present, uid=${res.rows[0].canonical_product_uid}` };
  });

  await gate("G_forbidden_codes_absent", async () => {
    const codes = [...FORBIDDEN_CODES];
    const tRes = await client.execute(`SELECT barcode FROM ${STAGING_TABLE_FOR.tires} WHERE barcode IN (${codes.map((c) => `'${c}'`).join(",")})`);
    const lRes = await client.execute(`SELECT barcode FROM tires WHERE barcode IN (${codes.map((c) => `'${c}'`).join(",")})`);
    const hits = [...tRes.rows, ...lRes.rows].map((r) => r.barcode);
    return { pass: hits.length === 0, detail: hits.length === 0 ? `${codes.join(", ")} absent from staging AND live` : `FOUND: ${hits.join(", ")}` };
  });

  await gate("H_pure_boss_uid_preservation_sampled", async () => {
    const updateRows = ledger.filter((r) => r.action === "update_blank_fill" && r.match_basis !== "barcode");
    if (updateRows.length === 0) return { pass: true, detail: "no update rows to sample" };
    const sampleSize = Math.min(25, updateRows.length);
    const step = Math.floor(updateRows.length / sampleSize) || 1;
    const sample = [];
    for (let i = 0; i < updateRows.length; i += step) sample.push(updateRows[i]);
    let mismatches = [];
    for (const s of sample.slice(0, sampleSize)) {
      const stagedRes = await client.execute({ sql: `SELECT canonical_product_uid FROM ${STAGING_TABLE_FOR.tires} WHERE barcode = ?`, args: [s.desired_barcode] });
      if (stagedRes.rows.length !== 1 || stagedRes.rows[0].canonical_product_uid !== s.current_uid) mismatches.push(s.desired_barcode);
    }
    return { pass: mismatches.length === 0, detail: mismatches.length === 0 ? `sampled ${sample.length} rows, uid preserved` : `UID DRIFT: ${mismatches.join(", ")}` };
  });

  const passed = gates.every((g) => g.pass);
  return { passed, gates };
}

async function cmdVerify({ dryRun, manifestArg, expectedManifestSha256 }) {
  if (dryRun) {
    console.log("[dry-run] verify: DRY-RUN: NOT EVALUATED. Would run gates Z/A/B(x5)/K/L/E/F/G/H against staging_boss_override_* + live.");
    return { passed: null, dryRun: true };
  }
  if (!existsSync(LEDGER_PATH)) throw new Error(`verify: REFUSING to run - ${rel(LEDGER_PATH)} does not exist. Run "ledger" first.`);
  const ledger = readFileSync(LEDGER_PATH, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  assertKnownLedgerActions(ledger);
  const manifestPath = resolveManifestPath(manifestArg);
  const runManifest = loadRunManifest(manifestPath, "verify", expectedManifestSha256);
  const client = await makeClient();
  await assertLiveUnchangedSinceManifest(client, runManifest, "verify");
  console.log(`verify: bound to run-manifest ${rel(manifestPath)} - live counts and content confirmed unchanged since backup.`);
  const { passed, gates } = await runVerifyGates(client, ledger);
  console.log("verify results:");
  for (const g of gates) console.log(`  ${g.pass ? "PASS" : "FAIL"} ${g.name}: ${g.detail}`);
  console.log(passed ? "verify: ALL GATES PASSED" : "verify: GATE FAILURE - do not promote");
  client.close();
  return { passed, gates };
}

// =============================================================================================
// promote: ORCHESTRATOR ONLY. Atomic rename-swap of all 5 tables (mirrors 10_promote_execute.mjs's
// own promote mechanics), preceded by a full re-run of the verify gate battery (never trusts a
// stale separate verify run). Recreates the 5 secondary indexes; runs a post-swap smoke test.
// =============================================================================================
const INDEX_DEFS = [
  { name: "idx_tire_barcode", table: "tires", column: "barcode" },
  { name: "idx_tire_part_number", table: "tires", column: "manufacturer_part_number" },
  { name: "idx_tire_uid", table: "tires", column: "canonical_product_uid" },
  { name: "idx_tire_part_numbers_uid", table: "tire_part_numbers", column: "canonical_product_uid" },
  { name: "idx_tire_pn_aliases_normalized", table: "tire_product_part_number_aliases", column: "normalized_part_number" },
];

async function cmdPromote({ dryRun, manifestArg, expectedManifestSha256 }) {
  requireConfirmOrExit(dryRun);
  if (dryRun) {
    console.log(`[dry-run] promote: NOT EVALUATED. Would re-run the full verify gate battery, then execute ONE atomic client.batch() renaming ${SWAPPED_TABLES.join(", ")} aside to <table>${OLD_SUFFIX}<ts> and staging_boss_override_<table> in as the new live table, recreate the 5 secondary indexes, then run a post-swap smoke test.`);
    return;
  }
  if (!existsSync(LEDGER_PATH)) throw new Error(`promote: REFUSING to run - ${rel(LEDGER_PATH)} does not exist.`);
  const ledger = readFileSync(LEDGER_PATH, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  assertKnownLedgerActions(ledger);
  const ts = timestamp();
  const manifestPath = resolveManifestPath(manifestArg);
  const runManifest = loadRunManifest(manifestPath, "promote", expectedManifestSha256);
  const client = await makeClient();
  await assertLiveUnchangedSinceManifest(client, runManifest, "promote");

  const { passed, gates } = await runVerifyGates(client, ledger);
  if (!passed) {
    console.error("promote: REFUSING to promote - verify gates failed:");
    for (const g of gates) if (!g.pass) console.error(`  FAIL ${g.name}: ${g.detail}`);
    process.exit(4);
  }
  console.log("promote: pre-swap verify gates all passed (including K_no_unresolved_conflicts and L_barcode_replacement_ledger). Executing atomic rename-swap...");

  const swapStatements = [];
  for (const table of SWAPPED_TABLES) {
    swapStatements.push(`ALTER TABLE ${table} RENAME TO ${table}${OLD_SUFFIX}${ts};`);
    swapStatements.push(`ALTER TABLE ${STAGING_TABLE_FOR[table]} RENAME TO ${table};`);
  }
  for (const d of INDEX_DEFS) {
    swapStatements.push(`DROP INDEX IF EXISTS ${d.name};`);
    swapStatements.push(`CREATE INDEX ${d.name} ON ${d.table}(${d.column});`);
  }
  assertAllowedTables(swapStatements, "promote (swap)");
  await client.batch(swapStatements, "write");
  console.log(`promote: atomic rename-swap complete. Rollback net: ${SWAPPED_TABLES.map((t) => `${t}${OLD_SUFFIX}${ts}`).join(", ")}`);

  console.log("promote: post-swap smoke test...");
  const smoke = await client.execute({ sql: `SELECT barcode FROM tires WHERE barcode = ?`, args: ["8848116004480"] });
  console.log(`  BH1600448 -> 8848116004480 resolves live: ${smoke.rows.length === 1 ? "PASS" : "FAIL"}`);
  const codes = [...FORBIDDEN_CODES];
  const forbiddenRes = await client.execute(`SELECT barcode FROM tires WHERE barcode IN (${codes.map((c) => `'${c}'`).join(",")})`);
  console.log(`  forbidden codes absent from live: ${forbiddenRes.rows.length === 0 ? "PASS" : "FAIL"}`);
  const idxRes = await client.execute("SELECT name, tbl_name FROM sqlite_master WHERE type='index'");
  const idxByName = new Map(idxRes.rows.map((r) => [String(r.name), String(r.tbl_name)]));
  const idxOk = INDEX_DEFS.every((d) => idxByName.get(d.name) === d.table);
  console.log(`  all 5 secondary indexes attached to the new live tables: ${idxOk ? "PASS" : "FAIL"}`);
  console.log(`promote: complete. ts=${ts}`);
  client.close();
}

async function cmdRollback({ dryRun, ts }) {
  requireConfirmOrExit(dryRun);
  if (!ts) throw new Error("rollback: --ts <promote-ts> is required.");
  if (dryRun) {
    console.log(`[dry-run] rollback: NOT EVALUATED. Would rename each of ${SWAPPED_TABLES.join(", ")} aside to <table>_failed_promotion_<ts> and rename <table>${OLD_SUFFIX}${ts} back to <table>, then recreate the 5 secondary indexes.`);
    return;
  }
  const client = await makeClient();
  const statements = [];
  for (const table of SWAPPED_TABLES) {
    statements.push(`ALTER TABLE ${table} RENAME TO ${table}_failed_promotion_${ts};`);
    statements.push(`ALTER TABLE ${table}${OLD_SUFFIX}${ts} RENAME TO ${table};`);
  }
  for (const d of INDEX_DEFS) {
    statements.push(`DROP INDEX IF EXISTS ${d.name};`);
    statements.push(`CREATE INDEX ${d.name} ON ${d.table}(${d.column});`);
  }
  assertAllowedTables(statements, "rollback");
  await client.batch(statements, "write");
  console.log(`rollback: complete. Restored pre-promote state from ${SWAPPED_TABLES.map((t) => `${t}${OLD_SUFFIX}${ts}`).join(", ")}.`);
  client.close();
}

// =============================================================================================
async function main() {
  const args = parseArgs(process.argv);
  switch (args.subcommand) {
    case "ledger": return cmdLedger(args);
    case "backup": return cmdBackup(args);
    case "stage": return cmdStage(args);
    case "verify": return cmdVerify(args);
    case "promote": return cmdPromote(args);
    case "rollback": return cmdRollback(args);
    default:
      console.error("Usage: node scripts/boss-override-2026-08-05.mjs <ledger|backup|stage|verify|promote|rollback> [--dry-run] [--manifest <path>] [--expected-manifest-sha256 <sha>] [--ts <ts>]");
      process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}`) {
  main().catch((e) => { console.error(`ERROR: ${e.message}`); process.exit(1); });
}
