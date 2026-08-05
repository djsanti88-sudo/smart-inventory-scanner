#!/usr/bin/env node
// Task B4 (2026-08-05): Sheet1 overlay per plan amendment AM-B4-1.
//
// The raw backups/boss-export-2026-08-05/boss_sheet1.csv (from NEW_UPDATED_BOSS_DB.xlsx) cannot feed
// scripts/build-tire-exact-index.mjs directly - that builder requires a reviewed BOSS_ROW_RECONCILIATION
// CSV with stable canonical_product_uid identities plus a repair DB it can look barcodes up in.
//
// This script performs a DETERMINISTIC JOIN by source_part_number (== boss item_number) onto the prior
// reviewed reconciliation (backups/claude-tire-db-handoff-2026-07-28/repair-2026-07-28/BOSS_ROW_RECONCILIATION.csv,
// 6990 rows: Sheet1=3543, Sheet2=3447) using backups/boss-export-2026-08-05/boss_override_actions.jsonl
// as the authoritative per-item_number outcome (it already encodes exactly what was promoted live to
// Turso today: 3,108 blank-fills incl. 8 repoints with 16 placeholder drops, +320 inserts, 2 more drops
// via BH4120879, 1 deferral NX10557 - verified: item_number sets of old Sheet1 (3543) and new sheet1
// (3543) are IDENTICAL, so this is a pure field-overlay, never a row insert/delete in the reconciliation).
//
// Sheet2 rows are copied through completely unchanged (frozen, per plan).
//
// Overlay rules per Sheet1 row (keyed by source_part_number == item_number):
//   A. item_number found in boss_override_actions.jsonl, action == "defer_review" (NX10557):
//      row left byte-for-byte unchanged (deferred to owner review, live untouched).
//   B. item_number found in boss_override_actions.jsonl, action in
//      {update_blank_fill, insert_new_uid, insert_preserve_uid}:
//      overlay raw_barcode/normalized_barcode_candidates/gtin_valid/gtin_level/brand/size/
//      matched_stable_product_id/matched_barcode/match_method/evidence/final_status=accepted.
//      matched_stable_product_id becomes action.current_uid (this is what repoints the 8
//      both_conflict rows away from their old bogus-placeholder-derived UID, and mirrors the 320
//      inserts' freshly-minted/preserved UIDs exactly). old placeholder barcodes are dropped
//      implicitly: once no reconciliation row's matched_barcode references them, the exact-index
//      builder never looks them up in the repair DB, so they never enter the projection.
//   C. item_number found in review_remainder.csv with reason == "shared_barcode_variant_pair"
//      (the 36 shared-barcode pairs / 72 rows): marked as their OWN reviewed class,
//      final_status = "shared_barcode_conflict" (excluded from the exact-index build - the builder
//      only admits final_status accepted/alias/packaging_code - but distinct from plain
//      needs_review so it is auditable as its own bucket per plan). matched_stable_product_id and
//      matched_barcode are cleared (never guessed).
//   D. item_number found in review_remainder.csv with reason in
//      {blank_barcode, truncated_code, invalid_placeholder_barcode} (39+1+2=42 rows): no reliable
//      new barcode data exists, so the row is left byte-for-byte unchanged (preserve prior reviewed
//      truth as the identity base).
//
// Companion repair-snapshot update: build-tire-exact-index.mjs resolves every accepted/alias
// reconciliation row via `repair.get(matched_barcode)` against the pinned repair DB. 3,096 of the
// 3,429 eligible desired_barcodes already exist in the (unchanged, SHA-pinned) July 28 repair DB
// under the SAME canonical_product_uid the action record names (0 disagreements verified). The
// remaining 333 (319 insert_new_uid + 13 update_blank_fill drift rows absent from the July 28
// snapshot + 1 insert_preserve_uid) do not exist there at all, so this script also writes a new
// repair-snapshot copy (REPAIRED_TIRE_DATABASE_v2.db) with those 333 rows INSERTed, using the boss
// sheet1's own brand/size/item_number as the (blank-only, single-source, boss-trusted) identity
// fields - never inventing a model, exactly mirroring 02_boss_reconciliation.mjs's own precedent
// that the boss workbook carries no dedicated model column.
//
// A barcode that already exists in the repair DB is only ever skipped when its existing
// canonical_product_uid AGREES with the action's current_uid (the 3,096 verified-agreeing rows
// above). If it exists under a DIFFERENT uid, that is repair-DB drift relative to the reviewed
// action ledger - this script fails closed (throws) rather than silently keeping the stale row,
// because build-tire-exact-index.mjs trusts this repair DB as a hash-pinned production input.
//
// Usage: node scripts/tire-db-repair/12_boss_sheet1_overlay_2026-08-05.mjs
//
// Every input/output path can be overridden (options object when imported as a module, or matching
// BOSS_SHEET1_OVERLAY_* env vars for CLI use) so tests can point the same logic at tiny offline
// fixtures without ever touching the pinned production backups/ files. With no overrides supplied,
// path resolution is byte-identical to the original hardcoded paths.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function csvEscape(value) {
  const s = value === null || value === undefined ? "" : String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function csvLine(fields) {
  return fields.map(csvEscape).join(",") + "\n";
}

// Mirrors build-tire-exact-index.mjs's csvRows() so parsing behaves identically to the consumer.
function csvRows(text) {
  const rows = []; let row = [], cell = "", quote = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') { if (quote && text[i + 1] === '"') { cell += '"'; i++; } else quote = !quote; }
    else if (char === "," && !quote) { row.push(cell); cell = ""; }
    else if ((char === "\n" || char === "\r") && !quote) { if (char === "\r" && text[i + 1] === "\n") i++; row.push(cell); if (row.some(Boolean)) rows.push(row); row = []; cell = ""; }
    else cell += char;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [headers, ...values] = rows;
  return values.map((fields) => Object.fromEntries(headers.map((header, index) => [header, fields[index] ?? ""])));
}

// --- Barcode / part-number normalization, mirroring 02_boss_reconciliation.mjs exactly. -----------
function isGtinShaped(code) {
  const t = (code ?? "").trim();
  return /^\d{8}$|^\d{12,14}$/.test(t);
}
function isValidCheckDigit(code) {
  const t = (code ?? "").trim();
  if (!isGtinShaped(t)) return false;
  const digits = t.split("").map(Number);
  const check = digits.pop();
  let sum = 0;
  for (let i = digits.length - 1, w = 3; i >= 0; i--, w = 4 - w) sum += digits[i] * w;
  return (10 - (sum % 10)) % 10 === check;
}
function gtinLevel(code) {
  const t = (code ?? "").trim();
  if (!/^\d+$/.test(t)) return null;
  if (t.length === 8) return "GTIN-8";
  if (t.length === 12) return "UPC-A";
  if (t.length === 13) return "EAN-13";
  if (t.length === 14) return "GTIN-14";
  return null;
}
function barcodeType(code) {
  const t = (code ?? "").trim();
  if (t.length === 12) return "upc";
  if (t.length === 13) return "ean";
  if (t.length === 14) return "gtin14";
  if (t.length === 8) return "gtin8";
  return "";
}

// --- Sheet1 row classification (overlay classes A/B/C/D above). Pure: no I/O, easy to unit test. ---
// Returns { newRow, caseTag, actionType } where caseTag is one of "A" | "B" | "C" | "D" | "unmatched".
// actionType carries the action.action for case B (for counts.sheet1CaseB_byAction) or the review
// remainder reason for case D (for counts.sheet1CaseD_frozenUnchanged); null otherwise.
export function classifySheet1Row(oldRow, { actionsByItem, newSheet1ByItem, remainderByItem }) {
  const itemNumber = oldRow.source_part_number;
  const action = actionsByItem.get(itemNumber);
  if (action) {
    if (action.action === "defer_review") {
      return { newRow: oldRow, caseTag: "A", actionType: action.action }; // byte-for-byte unchanged
    }
    // Case B: update_blank_fill | insert_new_uid | insert_preserve_uid.
    const sheet1 = newSheet1ByItem.get(itemNumber);
    if (!sheet1) throw new Error(`action item_number ${itemNumber} missing from new sheet1`);
    const desired = action.desired_barcode;
    if (!isValidCheckDigit(desired)) throw new Error(`action desired_barcode fails check digit: ${itemNumber} ${desired}`);
    const newRow = {
      sheet: "Sheet1",
      row: oldRow.row,
      raw_barcode: desired,
      normalized_barcode_candidates: desired,
      gtin_valid: "true",
      gtin_level: gtinLevel(desired) ?? "",
      source_part_number: itemNumber,
      part_number_base_key: oldRow.part_number_base_key,
      part_number_affix_core: oldRow.part_number_affix_core,
      brand: sheet1.brand,
      size: sheet1.size_raw,
      matched_stable_product_id: action.current_uid,
      matched_barcode: desired,
      match_method: "exact_barcode",
      evidence: `boss truth override 2026-08-05 (${action.action}, match_basis=${action.match_basis}): ${action.decision_reason}`,
      final_status: "accepted",
    };
    return { newRow, caseTag: "B", actionType: action.action };
  }

  const remainder = remainderByItem.get(itemNumber);
  if (remainder && remainder.reason === "shared_barcode_variant_pair") {
    const newRow = {
      sheet: "Sheet1",
      row: oldRow.row,
      raw_barcode: remainder.barcode,
      normalized_barcode_candidates: remainder.barcode,
      gtin_valid: isValidCheckDigit(remainder.barcode) ? "true" : "false",
      gtin_level: gtinLevel(remainder.barcode) ?? "",
      source_part_number: itemNumber,
      part_number_base_key: oldRow.part_number_base_key,
      part_number_affix_core: oldRow.part_number_affix_core,
      brand: remainder.brand,
      size: remainder.size_raw,
      matched_stable_product_id: "",
      matched_barcode: "",
      match_method: "none",
      evidence: `boss truth override 2026-08-05: shared_barcode_variant_pair - barcode ${remainder.barcode} is claimed by more than one boss item_number (studdable/studded pair); routed to review, never guessed (plan risk R6)`,
      final_status: "shared_barcode_conflict",
    };
    return { newRow, caseTag: "C", actionType: remainder.reason };
  }
  if (remainder) {
    // blank_barcode | truncated_code | invalid_placeholder_barcode: no reliable new data, freeze.
    return { newRow: oldRow, caseTag: "D", actionType: remainder.reason };
  }

  // Should never happen: every old Sheet1 item_number was verified to appear in either the
  // actions map or the review remainder (3429 + 114 == 3543 == old Sheet1 row count).
  return { newRow: oldRow, caseTag: "unmatched", actionType: null };
}

// --- Repair-row agreement check (fail-closed). Pure aside from the already-fetched DB row. ---------
// existingRow is either undefined (no such barcode yet) or the DB row { barcode, canonical_product_uid }
// fetched via `SELECT barcode, canonical_product_uid FROM tires WHERE barcode = ?`.
// - No existing row: caller should INSERT.
// - Existing row whose canonical_product_uid AGREES with action.current_uid: caller should SKIP
//   (already present, nothing to do - this is the verified 3,096-row steady state).
// - Existing row whose canonical_product_uid DISAGREES: this is repair-DB drift. Throw loudly instead
//   of silently keeping the stale row, naming the barcode, both uids, and the action's item_number so
//   a drifted repair DB can never silently poison the hash-pinned production inputs.
export function checkExistingRepairAgreement({ existingRow, desired, itemNumber, action }) {
  if (!existingRow) return { decision: "insert" };
  if (existingRow.canonical_product_uid === action.current_uid) return { decision: "skip" };
  throw new Error(
    `Repair DB drift detected for barcode ${desired} (boss item_number ${itemNumber}, action=${action.action}): ` +
    `repair DB already has canonical_product_uid ${JSON.stringify(existingRow.canonical_product_uid)}, but the ` +
    `boss override action expects canonical_product_uid ${JSON.stringify(action.current_uid)}. Refusing to ` +
    `silently skip - a drifted repair DB must never silently poison the hash-pinned production inputs.`,
  );
}

// --- Insert-row synthesis for the repair-snapshot tires table. Pure: no DB, no I/O. -----------------
export function buildInsertRowRecord({ itemNumber, action, sheet1 }) {
  const desired = action.desired_barcode;
  const btype = barcodeType(desired);
  return {
    barcode: desired,
    canonical_product_uid: action.current_uid,
    brand: sheet1.brand ?? "",
    brand_normalized: (sheet1.brand ?? "").trim().toLowerCase(),
    model: "",
    model_normalized: "",
    size: sheet1.size_raw ?? "",
    raw_size_text: sheet1.size_raw ?? "",
    load_index: "",
    speed_rating: "",
    load_range: "",
    type: "",
    season: "",
    manufacturer_part_number: itemNumber,
    barcode_type: btype,
    confidence: "verified_vendor",
    current_status: "active_retail",
    usable_for: "auto_count_candidate",
    field_completeness_score: "40",
    missing_fields: "model,load_index,speed_rating,load_range,type,season",
    source_count: 0,
    model_display: "",
    barcode_upc: btype === "upc" ? desired : null,
    barcode_ean13: btype === "ean" ? desired : null,
  };
}

function resolvePaths(options) {
  return {
    oldReconPath: options.oldReconPath ?? process.env.BOSS_SHEET1_OVERLAY_OLD_RECON_PATH
      ?? join(REPO_ROOT, "backups/claude-tire-db-handoff-2026-07-28/repair-2026-07-28/BOSS_ROW_RECONCILIATION.csv"),
    oldRepairDbPath: options.oldRepairDbPath ?? process.env.BOSS_SHEET1_OVERLAY_OLD_REPAIR_DB_PATH
      ?? join(REPO_ROOT, "backups/claude-tire-db-handoff-2026-07-28/repair-2026-07-28/REPAIRED_TIRE_DATABASE.db"),
    newSheet1Path: options.newSheet1Path ?? process.env.BOSS_SHEET1_OVERLAY_NEW_SHEET1_PATH
      ?? join(REPO_ROOT, "backups/boss-export-2026-08-05/boss_sheet1.csv"),
    actionsPath: options.actionsPath ?? process.env.BOSS_SHEET1_OVERLAY_ACTIONS_PATH
      ?? join(REPO_ROOT, "backups/boss-export-2026-08-05/boss_override_actions.jsonl"),
    reviewRemainderPath: options.reviewRemainderPath ?? process.env.BOSS_SHEET1_OVERLAY_REVIEW_REMAINDER_PATH
      ?? join(REPO_ROOT, "backups/boss-export-2026-08-05/review_remainder.csv"),
    outDir: options.outDir ?? process.env.BOSS_SHEET1_OVERLAY_OUT_DIR
      ?? join(REPO_ROOT, "backups/boss-export-2026-08-05"),
  };
}

export function main(options = {}) {
  const paths = resolvePaths(options);
  const outReconPath = join(paths.outDir, "BOSS_ROW_RECONCILIATION_v2.csv");
  const outRepairDbPath = join(paths.outDir, "REPAIRED_TIRE_DATABASE_v2.db");
  const outSummaryPath = join(paths.outDir, "overlay_summary.json");
  mkdirSync(paths.outDir, { recursive: true });

  const oldReconText = readFileSync(paths.oldReconPath, "utf8");
  const oldReconRows = csvRows(oldReconText);
  console.log(`Loaded ${oldReconRows.length} old reconciliation rows (expect 6990).`);

  const newSheet1Rows = csvRows(readFileSync(paths.newSheet1Path, "utf8"));
  const newSheet1ByItem = new Map(newSheet1Rows.map((r) => [r.item_number, r]));
  console.log(`Loaded ${newSheet1Rows.length} new sheet1 rows (expect 3543).`);

  const actionLines = readFileSync(paths.actionsPath, "utf8").split("\n").filter(Boolean);
  const actionsByItem = new Map();
  for (const line of actionLines) {
    const obj = JSON.parse(line);
    if (actionsByItem.has(obj.item_number)) throw new Error(`duplicate item_number in actions: ${obj.item_number}`);
    actionsByItem.set(obj.item_number, obj);
  }
  console.log(`Loaded ${actionsByItem.size} override actions (expect 3429).`);

  const remainderRows = csvRows(readFileSync(paths.reviewRemainderPath, "utf8"));
  const remainderByItem = new Map(remainderRows.map((r) => [r.item_number, r]));
  console.log(`Loaded ${remainderRows.length} review-remainder rows (expect 114).`);

  const counts = {
    sheet2FrozenUnchanged: 0,
    sheet1CaseA_deferred: 0,
    sheet1CaseB_overlaid: 0,
    sheet1CaseB_byAction: {},
    sheet1CaseC_sharedBarcodeConflict: 0,
    sheet1CaseD_frozenUnchanged: { blank_barcode: 0, truncated_code: 0, invalid_placeholder_barcode: 0 },
    sheet1Unmatched: 0,
  };

  const newRows = [];
  for (const r of oldReconRows) {
    if (r.sheet !== "Sheet1") {
      // Sheet2 frozen unchanged.
      newRows.push(r);
      counts.sheet2FrozenUnchanged++;
      continue;
    }

    const { newRow, caseTag, actionType } = classifySheet1Row(r, { actionsByItem, newSheet1ByItem, remainderByItem });
    newRows.push(newRow);
    if (caseTag === "A") counts.sheet1CaseA_deferred++;
    else if (caseTag === "B") {
      counts.sheet1CaseB_overlaid++;
      counts.sheet1CaseB_byAction[actionType] = (counts.sheet1CaseB_byAction[actionType] ?? 0) + 1;
    } else if (caseTag === "C") counts.sheet1CaseC_sharedBarcodeConflict++;
    else if (caseTag === "D") counts.sheet1CaseD_frozenUnchanged[actionType] = (counts.sheet1CaseD_frozenUnchanged[actionType] ?? 0) + 1;
    else if (caseTag === "unmatched") counts.sheet1Unmatched++;
  }

  if (counts.sheet1Unmatched > 0) throw new Error(`${counts.sheet1Unmatched} Sheet1 rows matched neither actions nor review remainder`);

  const header = [
    "sheet", "row", "raw_barcode", "normalized_barcode_candidates", "gtin_valid", "gtin_level",
    "source_part_number", "part_number_base_key", "part_number_affix_core", "brand", "size",
    "matched_stable_product_id", "matched_barcode", "match_method", "evidence", "final_status",
  ];
  const lines = [csvLine(header)];
  for (const r of newRows) {
    lines.push(csvLine(header.map((h) => r[h])));
  }
  const outBytes = Buffer.from(lines.join(""), "utf8");
  writeFileSync(outReconPath, outBytes);
  const reconSha = sha256(outBytes);
  console.log(`Wrote ${outReconPath} (${newRows.length} rows + header). SHA-256 ${reconSha}`);

  // --- Repair snapshot: copy the pinned July 28 DB, then INSERT the 333 rows the exact-index
  // builder cannot find there (verified offline against the unmodified original beforehand). -------
  if (existsSync(outRepairDbPath)) {
    // Idempotent re-run: start from a clean copy each time.
    writeFileSync(outRepairDbPath, Buffer.alloc(0));
  }
  copyFileSync(paths.oldRepairDbPath, outRepairDbPath);
  const db = new Database(outRepairDbPath);
  const findStmt = db.prepare("SELECT barcode, canonical_product_uid FROM tires WHERE barcode = ?");
  const insertStmt = db.prepare(`
    INSERT INTO tires (
      barcode, canonical_product_uid, brand, brand_normalized, model, model_normalized, size,
      raw_size_text, load_index, speed_rating, load_range, type, season, manufacturer_part_number,
      barcode_type, confidence, current_status, usable_for, field_completeness_score, missing_fields,
      source_count, model_display, barcode_upc, barcode_ean13
    ) VALUES (
      @barcode, @canonical_product_uid, @brand, @brand_normalized, @model, @model_normalized, @size,
      @raw_size_text, @load_index, @speed_rating, @load_range, @type, @season, @manufacturer_part_number,
      @barcode_type, @confidence, @current_status, @usable_for, @field_completeness_score, @missing_fields,
      @source_count, @model_display, @barcode_upc, @barcode_ean13
    )
  `);

  let inserted = 0;
  const insertedItems = [];
  const insertTxn = db.transaction((rows) => {
    for (const row of rows) {
      const action = row.action;
      const desired = action.desired_barcode;
      const existingRow = findStmt.get(desired);
      const { decision } = checkExistingRepairAgreement({ existingRow, desired, itemNumber: row.itemNumber, action });
      if (decision === "skip") continue;
      const sheet1 = newSheet1ByItem.get(row.itemNumber);
      insertStmt.run(buildInsertRowRecord({ itemNumber: row.itemNumber, action, sheet1 }));
      inserted++;
      insertedItems.push({ item_number: row.itemNumber, barcode: desired, canonical_product_uid: action.current_uid, action: action.action });
    }
  });
  const actionRowsForInsert = [...actionsByItem.entries()]
    .filter(([, a]) => a.action !== "defer_review")
    .map(([itemNumber, action]) => ({ itemNumber, action }));
  try {
    insertTxn(actionRowsForInsert);
  } finally {
    // Always release the file handle, including on the fail-closed drift throw above - an open
    // handle on a failed run must never block cleanup or a retry from touching the same path.
    db.close();
  }
  console.log(`Repair snapshot: inserted ${inserted} new tires rows (expect 333).`);

  const repairBytes = readFileSync(outRepairDbPath);
  const repairSha = sha256(repairBytes);
  console.log(`Wrote ${outRepairDbPath}. SHA-256 ${repairSha}`);

  const summary = {
    generatedAt: new Date().toISOString(),
    inputs: {
      oldReconciliationPath: paths.oldReconPath,
      oldRepairDbPath: paths.oldRepairDbPath,
      newSheet1Path: paths.newSheet1Path,
      actionsPath: paths.actionsPath,
      reviewRemainderPath: paths.reviewRemainderPath,
    },
    outputs: {
      reconciliationPath: outReconPath,
      reconciliationSha256: reconSha,
      reconciliationRowCount: newRows.length,
      repairDbPath: outRepairDbPath,
      repairDbSha256: repairSha,
      repairRowsInserted: inserted,
    },
    counts,
  };
  writeFileSync(outSummaryPath, JSON.stringify(summary, null, 2) + "\n");
  console.log(`Wrote ${outSummaryPath}`);
  console.log(JSON.stringify(counts, null, 2));
  return { counts, reconSha, repairSha, inserted, insertedItems };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
