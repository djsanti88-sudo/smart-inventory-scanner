// Offline node:test coverage for scripts/tire-db-repair/12_boss_sheet1_overlay_2026-08-05.mjs.
//
// This script's PRODUCTION outputs (BOSS_ROW_RECONCILIATION_v2.csv / REPAIRED_TIRE_DATABASE_v2.db
// under backups/boss-export-2026-08-05/) are already pinned into the shipped exact-index build, so
// these tests never call main() against the real backups/ paths - every test builds its own tiny
// synthetic fixture set (CSV text + an in-memory-shaped tempfile sqlite repair DB) and points main()
// at it via its options object, which is the same override mechanism build-tire-exact-index.mjs's
// buildExactIndex() uses for its own tests.
//
// Run: node --test scripts/tire-db-repair/12_boss_sheet1_overlay.node-test.mjs

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import {
  classifySheet1Row,
  checkExistingRepairAgreement,
  buildInsertRowRecord,
  main,
} from "./12_boss_sheet1_overlay_2026-08-05.mjs";

const OLD_RECON_HEADER = "sheet,row,raw_barcode,normalized_barcode_candidates,gtin_valid,gtin_level,source_part_number,part_number_base_key,part_number_affix_core,brand,size,matched_stable_product_id,matched_barcode,match_method,evidence,final_status";
const NEW_SHEET1_HEADER = "item_number,size_raw,item_name,brand,barcode";
const REMAINDER_HEADER = "item_number,size_raw,item_name,brand,barcode,reason";

const TIRES_SCHEMA = `
  CREATE TABLE tires (
    barcode TEXT PRIMARY KEY,
    canonical_product_uid TEXT,
    brand TEXT,
    brand_normalized TEXT,
    model TEXT,
    model_normalized TEXT,
    size TEXT,
    raw_size_text TEXT,
    load_index TEXT,
    speed_rating TEXT,
    load_range TEXT,
    type TEXT,
    season TEXT,
    manufacturer_part_number TEXT,
    barcode_type TEXT,
    confidence TEXT,
    current_status TEXT,
    usable_for TEXT,
    field_completeness_score TEXT,
    missing_fields TEXT,
    source_count INTEGER,
    model_display TEXT,
    barcode_upc TEXT,
    barcode_ean13 TEXT
  )
`;

// Builds one tiny fixture exercising every overlay class named in the script header (A/B/C/D) plus
// the Sheet2 passthrough. `preExisting` controls what the old repair DB already contains for
// ITEM-B2's desired barcode, so callers can pick the agreeing-skip path or the drifted-throw path.
function buildFixture(root, { preExistingB2Uid } = { preExistingB2Uid: "TIRE_TESTB2UID00000000000" }) {
  mkdirSync(root, { recursive: true });

  const oldReconPath = join(root, "old_reconciliation.csv");
  writeFileSync(oldReconPath, [
    OLD_RECON_HEADER,
    "Sheet2,1,9999999999999,9999999999999,true,GTIN-13,S2-ITEM,S2ITEM,,,,uid-s2,9999999999999,exact_barcode,,packaging_code",
    "Sheet1,2,OLDPLACE-A,OLDPLACE-A,false,,ITEM-A,ITEMA,,OldBrand,225/50R17,,,none,,needs_review",
    "Sheet1,3,OLDPLACE-B1,OLDPLACE-B1,false,,ITEM-B1,ITEMB1,,OldBrand,235/40R18,,,none,,needs_review",
    "Sheet1,4,OLDPLACE-B2,OLDPLACE-B2,false,,ITEM-B2,ITEMB2,,OldBrand,265/70R16,,,none,,needs_review",
    "Sheet1,5,OLDPLACE-C,OLDPLACE-C,false,,ITEM-C,ITEMC,,OldBrand,255/45R20,,,none,,needs_review",
    "Sheet1,6,,,false,,ITEM-D,ITEMD,,OldBrand,235/40R18,,,none,,needs_review",
    "",
  ].join("\n"));

  const newSheet1Path = join(root, "new_sheet1.csv");
  writeFileSync(newSheet1Path, [
    NEW_SHEET1_HEADER,
    "ITEM-A,225/50R17,test item A,OldBrand,OLDPLACE-A",
    "ITEM-B1,235/40R18,test item B1,NewBrand,8848116004480",
    "ITEM-B2,265/70R16,test item B2,NewBrand,8848116004596",
    "",
  ].join("\n"));

  const actionsPath = join(root, "actions.jsonl");
  const actions = [
    { item_number: "ITEM-A", desired_barcode: "191563020526", current_barcodes: ["191563020526"], match_basis: "both_conflict", current_uid: null, action: "defer_review", old_keys_to_drop: [], part_number_alias_to_add: null, source_row: 2, decision_reason: "test defer" },
    { item_number: "ITEM-B1", desired_barcode: "8848116004480", current_barcodes: ["8848116004480"], match_basis: "barcode", current_uid: "TIRE_TESTB1UID00000000000", action: "update_blank_fill", old_keys_to_drop: [], part_number_alias_to_add: "ITEM-B1", source_row: 3, decision_reason: "test blank fill insert path" },
    { item_number: "ITEM-B2", desired_barcode: "8848116004596", current_barcodes: [], match_basis: "none", current_uid: "TIRE_TESTB2UID00000000000", action: "insert_new_uid", old_keys_to_drop: [], part_number_alias_to_add: "ITEM-B2", source_row: 4, decision_reason: "test skip/drift path" },
  ];
  writeFileSync(actionsPath, actions.map((a) => JSON.stringify(a)).join("\n") + "\n");

  const remainderPath = join(root, "review_remainder.csv");
  writeFileSync(remainderPath, [
    REMAINDER_HEADER,
    "ITEM-C,255/45R20,test item C,NewBrandC,191563007435,shared_barcode_variant_pair",
    "ITEM-D,235/40R18,test item D,OldBrand,,blank_barcode",
    "",
  ].join("\n"));

  const oldRepairDbPath = join(root, "old_repair.db");
  const db = new Database(oldRepairDbPath);
  db.exec(TIRES_SCHEMA);
  if (preExistingB2Uid !== null) {
    db.prepare(`
      INSERT INTO tires (barcode, canonical_product_uid, brand, brand_normalized, model, model_normalized, size,
        raw_size_text, load_index, speed_rating, load_range, type, season, manufacturer_part_number, barcode_type,
        confidence, current_status, usable_for, field_completeness_score, missing_fields, source_count, model_display,
        barcode_upc, barcode_ean13)
      VALUES ('8848116004596', @uid, 'NewBrand', 'newbrand', '', '', '265/70R16', '265/70R16', '', '', '', '', '',
        'ITEM-B2', 'ean', 'verified_vendor', 'active_retail', 'auto_count_candidate', '40',
        'model,load_index,speed_rating,load_range,type,season', 0, '', NULL, '8848116004596')
    `).run({ uid: preExistingB2Uid });
  }
  db.close();

  return { oldReconPath, newSheet1Path, actionsPath, remainderPath, oldRepairDbPath };
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

// --- Case routing: the A/B/C/D overlay classes from the script header. ------------------------------

test("classifySheet1Row case A (defer_review): row passes through byte-for-byte unchanged", () => {
  const oldRow = { sheet: "Sheet1", row: "2", source_part_number: "ITEM-A", part_number_base_key: "ITEMA", part_number_affix_core: "" };
  const actionsByItem = new Map([["ITEM-A", { action: "defer_review", current_uid: null, desired_barcode: "191563020526" }]]);
  const result = classifySheet1Row(oldRow, { actionsByItem, newSheet1ByItem: new Map(), remainderByItem: new Map() });
  assert.equal(result.caseTag, "A");
  assert.equal(result.newRow, oldRow, "case A must return the identical row reference, not a copy");
});

test("classifySheet1Row case B (update_blank_fill / insert_new_uid): overlays barcode identity fields and stamps final_status accepted", () => {
  const oldRow = { sheet: "Sheet1", row: "3", source_part_number: "ITEM-B1", part_number_base_key: "ITEMB1", part_number_affix_core: "" };
  const action = { action: "update_blank_fill", current_uid: "TIRE_TESTB1UID00000000000", desired_barcode: "8848116004480", match_basis: "barcode", decision_reason: "test" };
  const actionsByItem = new Map([["ITEM-B1", action]]);
  const newSheet1ByItem = new Map([["ITEM-B1", { brand: "NewBrand", size_raw: "235/40R18" }]]);
  const result = classifySheet1Row(oldRow, { actionsByItem, newSheet1ByItem, remainderByItem: new Map() });

  assert.equal(result.caseTag, "B");
  assert.equal(result.actionType, "update_blank_fill");
  assert.equal(result.newRow.raw_barcode, "8848116004480");
  assert.equal(result.newRow.normalized_barcode_candidates, "8848116004480");
  assert.equal(result.newRow.matched_barcode, "8848116004480");
  assert.equal(result.newRow.matched_stable_product_id, "TIRE_TESTB1UID00000000000");
  assert.equal(result.newRow.brand, "NewBrand");
  assert.equal(result.newRow.size, "235/40R18");
  assert.equal(result.newRow.gtin_valid, "true");
  assert.equal(result.newRow.gtin_level, "EAN-13", "8848116004480 is 13 digits");
  assert.equal(result.newRow.final_status, "accepted");
  assert.equal(result.newRow.match_method, "exact_barcode");
  assert.match(result.newRow.evidence, /update_blank_fill/);
});

test("classifySheet1Row case B throws on a bad check digit instead of silently accepting a corrupt barcode", () => {
  const oldRow = { sheet: "Sheet1", row: "3", source_part_number: "ITEM-BAD", part_number_base_key: "X", part_number_affix_core: "" };
  const actionsByItem = new Map([["ITEM-BAD", { action: "update_blank_fill", current_uid: "u", desired_barcode: "000000000001" }]]);
  const newSheet1ByItem = new Map([["ITEM-BAD", { brand: "B", size_raw: "1/1R1" }]]);
  assert.throws(() => classifySheet1Row(oldRow, { actionsByItem, newSheet1ByItem, remainderByItem: new Map() }), /fails check digit/);
});

test("classifySheet1Row case B throws when the action's item_number is missing from the new sheet1", () => {
  const oldRow = { sheet: "Sheet1", row: "3", source_part_number: "ITEM-MISSING", part_number_base_key: "X", part_number_affix_core: "" };
  const actionsByItem = new Map([["ITEM-MISSING", { action: "update_blank_fill", current_uid: "u", desired_barcode: "8848116004480" }]]);
  assert.throws(() => classifySheet1Row(oldRow, { actionsByItem, newSheet1ByItem: new Map(), remainderByItem: new Map() }), /missing from new sheet1/);
});

test("classifySheet1Row case C (shared_barcode_variant_pair): routed to its own reviewed class, never guessed", () => {
  const oldRow = { sheet: "Sheet1", row: "5", source_part_number: "ITEM-C", part_number_base_key: "ITEMC", part_number_affix_core: "" };
  const remainderByItem = new Map([["ITEM-C", { reason: "shared_barcode_variant_pair", barcode: "191563007435", brand: "NewBrandC", size_raw: "255/45R20" }]]);
  const result = classifySheet1Row(oldRow, { actionsByItem: new Map(), newSheet1ByItem: new Map(), remainderByItem });

  assert.equal(result.caseTag, "C");
  assert.equal(result.newRow.final_status, "shared_barcode_conflict");
  assert.equal(result.newRow.matched_stable_product_id, "", "never guess an identity for a shared-barcode conflict");
  assert.equal(result.newRow.matched_barcode, "", "never guess a match for a shared-barcode conflict");
  assert.equal(result.newRow.raw_barcode, "191563007435");
});

test("classifySheet1Row case D (blank_barcode / truncated_code / invalid_placeholder_barcode): frozen unchanged", () => {
  const oldRow = { sheet: "Sheet1", row: "6", source_part_number: "ITEM-D", part_number_base_key: "ITEMD", part_number_affix_core: "" };
  const remainderByItem = new Map([["ITEM-D", { reason: "blank_barcode" }]]);
  const result = classifySheet1Row(oldRow, { actionsByItem: new Map(), newSheet1ByItem: new Map(), remainderByItem });

  assert.equal(result.caseTag, "D");
  assert.equal(result.actionType, "blank_barcode");
  assert.equal(result.newRow, oldRow, "case D must return the identical row reference, not a copy");
});

test("classifySheet1Row falls back to unmatched when an item_number is in neither actions nor the review remainder", () => {
  const oldRow = { sheet: "Sheet1", row: "7", source_part_number: "ITEM-ORPHAN", part_number_base_key: "X", part_number_affix_core: "" };
  const result = classifySheet1Row(oldRow, { actionsByItem: new Map(), newSheet1ByItem: new Map(), remainderByItem: new Map() });
  assert.equal(result.caseTag, "unmatched");
  assert.equal(result.newRow, oldRow);
});

// --- The new uid-agreement assertion: agreeing row skips, disagreeing row throws loudly. ------------

test("checkExistingRepairAgreement: no existing row means insert", () => {
  const action = { action: "insert_new_uid", current_uid: "TIRE_NEW", desired_barcode: "8848116004596" };
  const result = checkExistingRepairAgreement({ existingRow: undefined, desired: "8848116004596", itemNumber: "ITEM-B2", action });
  assert.deepEqual(result, { decision: "insert" });
});

test("checkExistingRepairAgreement: existing row with an agreeing canonical_product_uid skips (fine, already present)", () => {
  const action = { action: "insert_new_uid", current_uid: "TIRE_TESTB2UID00000000000", desired_barcode: "8848116004596" };
  const existingRow = { barcode: "8848116004596", canonical_product_uid: "TIRE_TESTB2UID00000000000" };
  const result = checkExistingRepairAgreement({ existingRow, desired: "8848116004596", itemNumber: "ITEM-B2", action });
  assert.deepEqual(result, { decision: "skip" });
});

test("checkExistingRepairAgreement: existing row with a DIFFERENT canonical_product_uid throws loudly naming barcode, both uids, and the item_number", () => {
  const action = { action: "insert_new_uid", current_uid: "TIRE_ACTION_EXPECTED_UID", desired_barcode: "8848116004596" };
  const existingRow = { barcode: "8848116004596", canonical_product_uid: "TIRE_DRIFTED_STALE_UID" };
  assert.throws(
    () => checkExistingRepairAgreement({ existingRow, desired: "8848116004596", itemNumber: "ITEM-B2", action }),
    (err) => {
      assert.match(err.message, /8848116004596/, "must name the barcode");
      assert.match(err.message, /ITEM-B2/, "must name the item_number / action row");
      assert.match(err.message, /TIRE_ACTION_EXPECTED_UID/, "must name the action's expected uid");
      assert.match(err.message, /TIRE_DRIFTED_STALE_UID/, "must name the existing (drifted) uid");
      return true;
    },
  );
});

// --- Row synthesis for an insert action. -------------------------------------------------------------

test("buildInsertRowRecord synthesizes a boss-trusted, blank-only tires row for a UPC-12 barcode", () => {
  const action = { action: "update_blank_fill", current_uid: "TIRE_TESTB1UID00000000000", desired_barcode: "848983006257" };
  const sheet1 = { brand: "Falken", size_raw: "265/70R17" };
  const record = buildInsertRowRecord({ itemNumber: "ITEM-B1", action, sheet1 });

  assert.equal(record.barcode, "848983006257");
  assert.equal(record.canonical_product_uid, "TIRE_TESTB1UID00000000000");
  assert.equal(record.brand, "Falken");
  assert.equal(record.brand_normalized, "falken");
  assert.equal(record.model, "", "never invent a model - the boss workbook carries no dedicated model column");
  assert.equal(record.size, "265/70R17");
  assert.equal(record.raw_size_text, "265/70R17");
  assert.equal(record.manufacturer_part_number, "ITEM-B1");
  assert.equal(record.barcode_type, "upc");
  assert.equal(record.barcode_upc, "848983006257");
  assert.equal(record.barcode_ean13, null);
  assert.equal(record.confidence, "verified_vendor");
  assert.equal(record.current_status, "active_retail");
  assert.equal(record.usable_for, "auto_count_candidate");
  assert.equal(record.field_completeness_score, "40");
  assert.equal(record.missing_fields, "model,load_index,speed_rating,load_range,type,season");
  assert.equal(record.source_count, 0);
});

test("buildInsertRowRecord classifies a 13-digit desired barcode as EAN and never double-fills the UPC column", () => {
  const action = { action: "insert_new_uid", current_uid: "TIRE_TESTB2UID00000000000", desired_barcode: "8848116004596" };
  const sheet1 = { brand: "NewBrand", size_raw: "265/70R16" };
  const record = buildInsertRowRecord({ itemNumber: "ITEM-B2", action, sheet1 });

  assert.equal(record.barcode_type, "ean");
  assert.equal(record.barcode_ean13, "8848116004596");
  assert.equal(record.barcode_upc, null);
});

test("buildInsertRowRecord tolerates a sheet1 row with no brand (never throws on blank optional fields)", () => {
  const action = { action: "insert_preserve_uid", current_uid: "TIRE_X", desired_barcode: "848983006257" };
  const record = buildInsertRowRecord({ itemNumber: "ITEM-X", action, sheet1: {} });
  assert.equal(record.brand, "");
  assert.equal(record.brand_normalized, "");
  assert.equal(record.size, "");
});

// --- Full-pipeline integration: case routing + uid-agreement wired together via main(). -------------

test("main(): end-to-end fixture exercises every overlay class, skips the agreeing repair row, and inserts the missing one", () => {
  const root = mkdtempSync(join(tmpdir(), "boss-sheet1-overlay-"));
  const outDir = join(root, "out");
  try {
    const fx = buildFixture(root);
    const result = main({
      oldReconPath: fx.oldReconPath, oldRepairDbPath: fx.oldRepairDbPath, newSheet1Path: fx.newSheet1Path,
      actionsPath: fx.actionsPath, reviewRemainderPath: fx.remainderPath, outDir,
    });

    assert.deepEqual(result.counts, {
      sheet2FrozenUnchanged: 1,
      sheet1CaseA_deferred: 1,
      sheet1CaseB_overlaid: 2,
      sheet1CaseB_byAction: { update_blank_fill: 1, insert_new_uid: 1 },
      sheet1CaseC_sharedBarcodeConflict: 1,
      sheet1CaseD_frozenUnchanged: { blank_barcode: 1, truncated_code: 0, invalid_placeholder_barcode: 0 },
      sheet1Unmatched: 0,
    });
    assert.equal(result.inserted, 1, "only ITEM-B1 was missing from the old repair DB; ITEM-B2 already agreed and was skipped");
    assert.deepEqual(result.insertedItems.map((i) => i.item_number), ["ITEM-B1"]);

    const reconText = readFileSync(join(outDir, "BOSS_ROW_RECONCILIATION_v2.csv"), "utf8");
    assert.match(reconText, /Sheet1,3,8848116004480,8848116004480,true,EAN-13,ITEM-B1/, "case B overlays the desired barcode onto the row");
    assert.match(reconText, /OLDPLACE-A/, "case A row is left byte-for-byte unchanged");
    assert.match(reconText, /shared_barcode_conflict/, "case C is routed to its own reviewed class");

    const db = new Database(join(outDir, "REPAIRED_TIRE_DATABASE_v2.db"), { readonly: true });
    try {
      const b1 = db.prepare("SELECT canonical_product_uid FROM tires WHERE barcode = ?").get("8848116004480");
      assert.equal(b1.canonical_product_uid, "TIRE_TESTB1UID00000000000");
      const b2 = db.prepare("SELECT canonical_product_uid FROM tires WHERE barcode = ?").get("8848116004596");
      assert.equal(b2.canonical_product_uid, "TIRE_TESTB2UID00000000000", "pre-existing agreeing row is left untouched, not re-inserted");
      const count = db.prepare("SELECT COUNT(*) AS n FROM tires").get().n;
      assert.equal(count, 2, "exactly one pre-existing row plus one newly inserted row");
    } finally { db.close(); }
  } finally { cleanup(root); }
});

test("main(): fails closed instead of silently poisoning the repair DB when it has drifted off the reviewed action ledger", () => {
  const root = mkdtempSync(join(tmpdir(), "boss-sheet1-overlay-drift-"));
  const outDir = join(root, "out");
  try {
    const fx = buildFixture(root, { preExistingB2Uid: "TIRE_DRIFTED_STALE_UID" });
    assert.throws(
      () => main({
        oldReconPath: fx.oldReconPath, oldRepairDbPath: fx.oldRepairDbPath, newSheet1Path: fx.newSheet1Path,
        actionsPath: fx.actionsPath, reviewRemainderPath: fx.remainderPath, outDir,
      }),
      (err) => {
        assert.match(err.message, /8848116004596/);
        assert.match(err.message, /TIRE_DRIFTED_STALE_UID/);
        assert.match(err.message, /TIRE_TESTB2UID00000000000/);
        return true;
      },
    );
  } finally { cleanup(root); }
});

// --- Determinism: the script explicitly claims BOSS_ROW_RECONCILIATION_v2.csv and
// REPAIRED_TIRE_DATABASE_v2.db are stable outputs for the same inputs (that is the whole premise of
// pinning their SHA-256 into the shipped exact-index build). overlay_summary.json is NOT claimed
// deterministic (it carries a generatedAt timestamp), so it is excluded from this comparison. --------

test("main(): same inputs produce byte-identical BOSS_ROW_RECONCILIATION_v2.csv and REPAIRED_TIRE_DATABASE_v2.db across independent runs", () => {
  const root = mkdtempSync(join(tmpdir(), "boss-sheet1-overlay-determinism-"));
  const outDirA = join(root, "out-a");
  const outDirB = join(root, "out-b");
  try {
    const fx = buildFixture(root);
    const runOnce = (outDir) => main({
      oldReconPath: fx.oldReconPath, oldRepairDbPath: fx.oldRepairDbPath, newSheet1Path: fx.newSheet1Path,
      actionsPath: fx.actionsPath, reviewRemainderPath: fx.remainderPath, outDir,
    });
    runOnce(outDirA);
    runOnce(outDirB);

    const reconA = readFileSync(join(outDirA, "BOSS_ROW_RECONCILIATION_v2.csv"));
    const reconB = readFileSync(join(outDirB, "BOSS_ROW_RECONCILIATION_v2.csv"));
    assert.ok(reconA.equals(reconB), "reconciliation CSV must be byte-identical across independent runs of the same inputs");

    const repairA = readFileSync(join(outDirA, "REPAIRED_TIRE_DATABASE_v2.db"));
    const repairB = readFileSync(join(outDirB, "REPAIRED_TIRE_DATABASE_v2.db"));
    assert.ok(repairA.equals(repairB), "repair snapshot DB must be byte-identical across independent runs of the same inputs");
  } finally { cleanup(root); }
});
