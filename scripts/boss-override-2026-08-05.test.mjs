// Unit tests for the boss-override-2026-08-05.mjs actions-ledger classifier (AM-B3-2/AM-B3-4).
// Pure-function tests only - no live Turso connection, no network. Run with:
//   node --test scripts/boss-override-2026-08-05.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  classifyBossRows,
  buildUidToBarcodes,
  summarizeLedgerBuckets,
  parseBossItemName,
  mintUid,
  barcodeShape,
  isKnownStaleSiblingPattern,
  FORBIDDEN_CODES,
  KNOWN_13_COLLISION_ITEM_NUMBERS,
  SWAPPED_TABLES,
  KNOWN_LEDGER_ACTIONS,
  assertKnownLedgerActions,
  unresolvedConflictRows,
  applyLedgerStatements,
  summarizeConflictLabels,
  sampleInsertBarcodesForStaleCheck,
  detectStaleLedger,
  loadSheet1RowIndex,
  loadBossRows,
  buildDropAnnotationPlan,
  cmdAnnotateDrops,
  SOURCE_NAME,
  BATCH_ID,
} from "./boss-override-2026-08-05.mjs";

function bossRow(overrides = {}) {
  return {
    item_number: "BH0000001",
    brand: "Blackhawk",
    size_raw: "2755520",
    item_name: "275/55R20 XL Blackhawk Ridgecrawler R/T BSW 117T TL",
    barcode: "8848100000010",
    ...overrides,
  };
}

function liveTireRow(overrides = {}) {
  return {
    canonical_product_uid: "TIRE_EXISTING",
    manufacturer_part_number: "",
    brand: "", brand_normalized: "", model: "", model_normalized: "", size: "", raw_size_text: "",
    load_index: "", speed_rating: "", load_range: "", type: "", season: "", barcode_type: "ean",
    confidence: "verified_vendor", current_status: "active_retail", usable_for: "auto_count_candidate",
    field_completeness_score: "", missing_fields: "", source_count: 0, model_display: null,
    barcode_upc: null, barcode_ean13: null,
    ...overrides,
  };
}

const sheet1Index = new Map([["BH0000001", 42]]);

test("match_basis=none: neither barcode nor item_number live -> insert_new_uid with deterministic uid", () => {
  const rows = [bossRow()];
  const { ledger, forbiddenHits } = classifyBossRows(rows, new Map(), new Map(), sheet1Index);
  assert.equal(forbiddenHits.length, 0);
  assert.equal(ledger.length, 1);
  const entry = ledger[0];
  assert.equal(entry.match_basis, "none");
  assert.equal(entry.action, "insert_new_uid");
  assert.equal(entry.current_barcodes.length, 0);
  assert.equal(entry.old_keys_to_drop.length, 0);
  assert.equal(entry.part_number_alias_to_add, "BH0000001");
  assert.equal(entry.source_row, 42);
  assert.equal(entry.current_uid, mintUid("8848100000010", "BH0000001"));
  // Deterministic: re-classifying the same row produces the identical uid.
  const again = classifyBossRows(rows, new Map(), new Map(), sheet1Index);
  assert.equal(again.ledger[0].current_uid, entry.current_uid);
});

test("match_basis=barcode: barcode already live, item_number has no pn key -> update_blank_fill + new alias", () => {
  const rows = [bossRow()];
  const liveTires = new Map([["8848100000010", liveTireRow({ canonical_product_uid: "TIRE_ABC" })]]);
  const { ledger } = classifyBossRows(rows, liveTires, new Map(), sheet1Index);
  const entry = ledger[0];
  assert.equal(entry.match_basis, "barcode");
  assert.equal(entry.action, "update_blank_fill");
  assert.equal(entry.current_uid, "TIRE_ABC");
  assert.deepEqual(entry.current_barcodes, ["8848100000010"]);
  assert.equal(entry.part_number_alias_to_add, "BH0000001");
  assert.equal(entry.old_keys_to_drop.length, 0);
});

test("match_basis=both: barcode live AND part number already points at the SAME uid -> update, no alias needed", () => {
  const rows = [bossRow()];
  const liveTires = new Map([["8848100000010", liveTireRow({ canonical_product_uid: "TIRE_ABC" })]]);
  const livePN = new Map([["BH0000001", "TIRE_ABC"]]);
  const { ledger } = classifyBossRows(rows, liveTires, livePN, sheet1Index);
  const entry = ledger[0];
  assert.equal(entry.match_basis, "both");
  assert.equal(entry.action, "update_blank_fill");
  assert.equal(entry.current_uid, "TIRE_ABC");
  assert.equal(entry.part_number_alias_to_add, null);
});

test("match_basis=both_conflict: barcode live under one uid, part number already points at a DIFFERENT uid -> review, blocks promote", () => {
  const rows = [bossRow()];
  const liveTires = new Map([
    ["8848100000010", liveTireRow({ canonical_product_uid: "TIRE_BARCODE_UID" })],
    ["003220099999", liveTireRow({ canonical_product_uid: "TIRE_PN_UID", manufacturer_part_number: "BH0000001" })],
  ]);
  const livePN = new Map([["BH0000001", "TIRE_PN_UID"]]);
  const { ledger } = classifyBossRows(rows, liveTires, livePN, sheet1Index);
  const entry = ledger[0];
  assert.equal(entry.match_basis, "both_conflict");
  assert.equal(entry.action, "review_cross_uid_conflict");
  assert.equal(entry.current_uid, null);
  assert.ok(entry.current_barcodes.includes("8848100000010"));
  assert.ok(entry.current_barcodes.includes("003220099999"));
  assert.equal(entry.old_keys_to_drop.length, 0);
  assert.match(entry.decision_reason, /CONFLICT/);
});

test("match_basis=part_number, no stale siblings: barcode not live, item_number points at an existing uid with a normal-looking sibling barcode -> preserve uid, no drop proposed", () => {
  const rows = [bossRow()];
  const liveTires = new Map([
    ["8848199999999", liveTireRow({ canonical_product_uid: "TIRE_PRESERVE", manufacturer_part_number: "BH0000001" })],
  ]);
  const livePN = new Map([["BH0000001", "TIRE_PRESERVE"]]);
  const { ledger } = classifyBossRows(rows, liveTires, livePN, sheet1Index);
  const entry = ledger[0];
  assert.equal(entry.match_basis, "part_number");
  assert.equal(entry.action, "insert_preserve_uid");
  assert.equal(entry.current_uid, "TIRE_PRESERVE");
  assert.deepEqual(entry.current_barcodes, ["8848199999999"]);
  assert.equal(entry.old_keys_to_drop.length, 0, "a normal-looking sibling barcode must never be auto-proposed for drop");
});

test("match_basis=part_number, ALL siblings match the known stale-placeholder pattern -> proposes old_keys_to_drop with evidence", () => {
  const rows = [bossRow({ item_number: "BH4120879", barcode: "8935341208797" })];
  const liveTires = new Map([
    ["0003220018428", liveTireRow({ canonical_product_uid: "TIRE_PRESERVE", manufacturer_part_number: "BH4120879" })],
    ["003220018428", liveTireRow({ canonical_product_uid: "TIRE_PRESERVE", manufacturer_part_number: "BH4120879" })],
  ]);
  const livePN = new Map([["BH4120879", "TIRE_PRESERVE"]]);
  const { ledger } = classifyBossRows(rows, liveTires, livePN, sheet1Index);
  const entry = ledger[0];
  assert.equal(entry.match_basis, "part_number");
  assert.equal(entry.action, "insert_preserve_uid");
  assert.deepEqual(new Set(entry.old_keys_to_drop), new Set(["0003220018428", "003220018428"]));
  assert.match(entry.decision_reason, /bogus zero-padded placeholder/);
});

test("match_basis=part_number, MIXED siblings (one stale-looking, one not) -> does NOT propose a drop (fail closed)", () => {
  const rows = [bossRow({ item_number: "BH4120879", barcode: "8935341208797" })];
  const liveTires = new Map([
    ["0003220018428", liveTireRow({ canonical_product_uid: "TIRE_PRESERVE", manufacturer_part_number: "BH4120879" })],
    ["191563099999", liveTireRow({ canonical_product_uid: "TIRE_PRESERVE", manufacturer_part_number: "BH4120879" })], // legit-looking real barcode
  ]);
  const livePN = new Map([["BH4120879", "TIRE_PRESERVE"]]);
  const { ledger } = classifyBossRows(rows, liveTires, livePN, sheet1Index);
  const entry = ledger[0];
  assert.equal(entry.old_keys_to_drop.length, 0, "mixed sibling set must never be silently dropped - fail closed, no guessing");
});

test("forbidden codes (9235030211 / 9315030311 / 3220015959) never enter the ledger", () => {
  const rows = [bossRow({ barcode: "9235030211" }), bossRow({ item_number: "X2", barcode: "9315030311" }), bossRow({ item_number: "X3", barcode: "3220015959" }), bossRow({ item_number: "X4" })];
  const { ledger, forbiddenHits } = classifyBossRows(rows, new Map(), new Map(), sheet1Index);
  assert.equal(ledger.length, 1, "only the one legitimate row should reach the ledger");
  assert.equal(forbiddenHits.length, 3);
  for (const code of FORBIDDEN_CODES) {
    assert.ok(!ledger.some((e) => e.desired_barcode === code));
  }
});

test("summarizeLedgerBuckets closes exactly over all match_basis values, no row double-counted or dropped", () => {
  const rows = [
    bossRow({ item_number: "A" }), // none
    bossRow({ item_number: "B", barcode: "8848100000020" }),
    bossRow({ item_number: "C", barcode: "8848100000030" }),
  ];
  const liveTires = new Map([
    ["8848100000020", liveTireRow({ canonical_product_uid: "TIRE_B" })], // barcode
    ["8848100000030", liveTireRow({ canonical_product_uid: "TIRE_C" })],
  ]);
  const livePN = new Map([["C", "TIRE_C"]]); // C -> both
  const { ledger } = classifyBossRows(rows, liveTires, livePN, sheet1Index);
  const buckets = summarizeLedgerBuckets(ledger);
  assert.equal(buckets.none, 1);
  assert.equal(buckets.barcode, 1);
  assert.equal(buckets.both, 1);
  const total = Object.values(buckets).reduce((a, b) => a + b, 0);
  assert.equal(total, rows.length);
  assert.equal(ledger.length, rows.length);
});

test("live 2026-08-05 full-dataset closure: 3,429 rows split into exactly the buckets found by direct live query", () => {
  // Regression fixture mirroring the live query used to produce boss_override_actions.jsonl
  // (documented in the B3-PREP report): 1,734 both + 1,366 barcode + 9 both_conflict + 1 part_number
  // + 319 none = 3,429. This test only proves the CLASSIFIER logic partitions correctly on a
  // synthetic dataset shaped like the real one; it does not touch Turso.
  const rows = [];
  const liveTires = new Map();
  const livePN = new Map();
  for (let i = 0; i < 5; i++) {
    const bc = `999900000000${i}`;
    rows.push(bossRow({ item_number: `BOTH${i}`, barcode: bc }));
    liveTires.set(bc, liveTireRow({ canonical_product_uid: `UID_BOTH_${i}` }));
    livePN.set(`BOTH${i}`, `UID_BOTH_${i}`);
  }
  for (let i = 0; i < 3; i++) {
    const bc = `999900000010${i}`;
    rows.push(bossRow({ item_number: `BCONLY${i}`, barcode: bc }));
    liveTires.set(bc, liveTireRow({ canonical_product_uid: `UID_BC_${i}` }));
  }
  {
    const bc = "9999000000200";
    rows.push(bossRow({ item_number: "CONFLICT0", barcode: bc }));
    liveTires.set(bc, liveTireRow({ canonical_product_uid: "UID_CONFLICT_BARCODE" }));
    livePN.set("CONFLICT0", "UID_CONFLICT_PN");
    liveTires.set("9999000000300", liveTireRow({ canonical_product_uid: "UID_CONFLICT_PN" }));
  }
  {
    rows.push(bossRow({ item_number: "PNONLY0", barcode: "9999000000400" }));
    livePN.set("PNONLY0", "UID_PN_PRESERVE");
    liveTires.set("9999000000500", liveTireRow({ canonical_product_uid: "UID_PN_PRESERVE", manufacturer_part_number: "PNONLY0" }));
  }
  for (let i = 0; i < 2; i++) {
    rows.push(bossRow({ item_number: `NONE${i}`, barcode: `999900000060${i}` }));
  }
  const idx = new Map(rows.map((r) => [r.item_number, 1]));
  const { ledger, forbiddenHits } = classifyBossRows(rows, liveTires, livePN, idx);
  assert.equal(forbiddenHits.length, 0);
  const buckets = summarizeLedgerBuckets(ledger);
  assert.equal(buckets.both, 5);
  assert.equal(buckets.barcode, 3);
  assert.equal(buckets.both_conflict, 1);
  assert.equal(buckets.part_number, 1);
  assert.equal(buckets.none, 2);
  assert.equal(ledger.length, rows.length);
});

test("parseBossItemName: brand-anchored split handles the passenger-metric shape", () => {
  const parsed = parseBossItemName("275/55R20 XL Blackhawk Ridgecrawler R/T BSW 117T TL", "Blackhawk");
  assert.equal(parsed.size, "275/55R20");
  assert.equal(parsed.loadRange, "XL");
  assert.equal(parsed.loadIndex, "117");
  assert.equal(parsed.speedRating, "T");
  assert.equal(parsed.model, "Ridgecrawler R/T BSW");
});

test("parseBossItemName: LT-metric shape (embedded /E load range, no space token)", () => {
  const parsed = parseBossItemName("LT245/70R17/E Blackhawk Ridgecrawler R/T BSW 119/116Q TL", "Blackhawk");
  assert.equal(parsed.size, "LT245/70R17");
  assert.equal(parsed.loadRange, "E");
  assert.equal(parsed.loadIndex, "119/116");
  assert.equal(parsed.speedRating, "Q");
});

test("parseBossItemName: flotation shape (33X12.50R18LT/F)", () => {
  const parsed = parseBossItemName("33X12.50R18LT/F Blackhawk Ridgecrawler R/T BSW 122Q TL", "Blackhawk");
  assert.equal(parsed.size, "33X12.50R18LT");
  assert.equal(parsed.loadRange, "F");
});

test("mintUid is deterministic and collision-resistant across distinct inputs", () => {
  const a = mintUid("123", "ITEM1");
  const b = mintUid("123", "ITEM1");
  const c = mintUid("123", "ITEM2");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^TIRE_[0-9A-F]{20}$/);
});

test("barcodeShape: 13-digit=ean, 12-digit=upc, other=unknown", () => {
  assert.equal(barcodeShape("8848116004480"), "ean");
  assert.equal(barcodeShape("884811600448"), "upc");
  assert.equal(barcodeShape("12345"), "");
});

test("isKnownStaleSiblingPattern matches the documented bogus-placeholder family", () => {
  assert.ok(isKnownStaleSiblingPattern("3220015959"));
  assert.ok(isKnownStaleSiblingPattern("003220017209"));
  assert.ok(isKnownStaleSiblingPattern("0003220018428"));
  assert.ok(!isKnownStaleSiblingPattern("8848116004480"));
  assert.ok(!isKnownStaleSiblingPattern("191563009774"));
});

test("buildUidToBarcodes groups multiple barcodes under one uid correctly", () => {
  const liveTires = new Map([
    ["A", liveTireRow({ canonical_product_uid: "UID1" })],
    ["B", liveTireRow({ canonical_product_uid: "UID1" })],
    ["C", liveTireRow({ canonical_product_uid: "UID2" })],
  ]);
  const map = buildUidToBarcodes(liveTires);
  assert.deepEqual(new Set(map.get("UID1")), new Set(["A", "B"]));
  assert.deepEqual(map.get("UID2"), ["C"]);
});

test("KNOWN_13_COLLISION_ITEM_NUMBERS has exactly 13 entries (b2-drift-report.md)", () => {
  assert.equal(KNOWN_13_COLLISION_ITEM_NUMBERS.size, 13);
});

test("SWAPPED_TABLES is exactly the 5-table scope (no operational tables)", () => {
  assert.deepEqual(SWAPPED_TABLES, ["tires", "tire_part_numbers", "tire_product_part_number_aliases", "canonical_tire_products", "provenance"]);
});

// =============================================================================================
// PRE-LIVE REVIEW REGRESSION TESTS (2026-08-05): the resolution-encoding fix for both_conflict
// rows. Gate K (K_no_unresolved_conflicts, wired via unresolvedConflictRows) must key off `action`
// - the field the documented orchestrator procedure hand-edits to resolve a conflict - never off
// `match_basis`, which the same procedure deliberately leaves unchanged as an audit trail. Before
// this fix, a resolved conflict (action edited, match_basis untouched) would have permanently
// failed gate K, making promote unreachable for any resolved conflict.
// =============================================================================================

function conflictLedgerRow(overrides = {}) {
  // Shaped exactly like a real both_conflict row from boss_override_actions.jsonl (e.g. BH1600462)
  // BEFORE any hand-edit: action="review_cross_uid_conflict", current_uid=null.
  return {
    item_number: "BH1600462", desired_barcode: "8848116004626",
    current_barcodes: ["8848116004626", "0003220017209", "003220017209"],
    match_basis: "both_conflict", current_uid: null, action: "review_cross_uid_conflict",
    old_keys_to_drop: [], part_number_alias_to_add: null, source_row: 16,
    decision_reason: "CONFLICT: ...",
    ...overrides,
  };
}

test("unresolvedConflictRows: an UNEDITED both_conflict row (action still review_cross_uid_conflict) blocks", () => {
  const ledger = [conflictLedgerRow()];
  const conflicts = unresolvedConflictRows(ledger);
  assert.equal(conflicts.length, 1);
});

test("unresolvedConflictRows: a HAND-RESOLVED both_conflict row (action changed, match_basis left as-is) no longer blocks", () => {
  // This is the exact documented resolution recipe: repoint the part number to the barcode-holding
  // uid and drop the losing uid's bogus placeholder barcodes, expressed as update_blank_fill with
  // current_uid set to the barcode-holding uid, part_number_alias_to_add set to the item_number, and
  // old_keys_to_drop listing the losing uid's stale siblings. match_basis is deliberately NOT
  // changed (stays "both_conflict" as the historical record of why review was needed).
  const resolved = conflictLedgerRow({
    action: "update_blank_fill",
    current_uid: "TIRE_E244BE67DF8DBFDEFC72", // the barcode-holding (correct) uid
    old_keys_to_drop: ["0003220017209", "003220017209"], // the losing uid's bogus placeholder siblings
    part_number_alias_to_add: "BH1600462",
    decision_reason: "RESOLVED (owner decision): repoint to the barcode-holding uid; drop losing uid's placeholders.",
  });
  assert.equal(resolved.match_basis, "both_conflict", "match_basis must stay unchanged as the audit trail");
  const conflicts = unresolvedConflictRows([resolved]);
  assert.equal(conflicts.length, 0, "a row resolved via action must not block promote even though match_basis is unchanged");
});

test("unresolvedConflictRows: a DEFERRED conflict (action=defer_review) does not block, independent of the other 8", () => {
  const deferred = conflictLedgerRow({ item_number: "NX10557", action: "defer_review" });
  const resolved = conflictLedgerRow({ action: "update_blank_fill", current_uid: "TIRE_X" });
  const stillOpen = conflictLedgerRow({ item_number: "BH1600467" }); // untouched, still blocking
  const conflicts = unresolvedConflictRows([deferred, resolved, stillOpen]);
  assert.deepEqual(conflicts.map((c) => c.item_number), ["BH1600467"], "only the still-unresolved row should block");
});

test("applyLedgerStatements: a defer_review row produces ZERO statements (pure no-op, exactly like review_cross_uid_conflict)", () => {
  const bossRows = [bossRow({ item_number: "NX10557", barcode: "191563020526" })];
  const deferred = { item_number: "NX10557", desired_barcode: "191563020526", current_barcodes: [], match_basis: "both_conflict", current_uid: null, action: "defer_review", old_keys_to_drop: [], part_number_alias_to_add: null, source_row: 1734, decision_reason: "deferred" };
  const { statements, counts } = applyLedgerStatements([deferred], bossRows, 1, new Date().toISOString());
  assert.equal(statements.length, 0);
  assert.equal(counts.tiresInserted, 0);
  assert.equal(counts.pnInserted, 0);
  assert.equal(counts.provenanceInserted, 0);
  assert.equal(counts.droppedBarcodes, 0);
});

test("applyLedgerStatements: the documented conflict-resolution recipe (update_blank_fill + current_uid=barcode-holding uid + old_keys_to_drop=losing uid's placeholders + part_number_alias_to_add) emits an UPDATE targeting the barcode-holding row, a DELETE for the dropped placeholders, and a tire_part_numbers repoint", () => {
  const bossRows = [bossRow({ item_number: "BH1600462", barcode: "8848116004626", brand: "Blackhawk", size_raw: "2755520" })];
  const resolved = conflictLedgerRow({
    action: "update_blank_fill",
    current_uid: "TIRE_E244BE67DF8DBFDEFC72",
    old_keys_to_drop: ["0003220017209", "003220017209"],
    part_number_alias_to_add: "BH1600462",
  });
  const { statements, counts } = applyLedgerStatements([resolved], bossRows, 1, "2026-08-05T00:00:00.000Z");
  assert.equal(counts.droppedBarcodes, 2);
  const updateStmt = statements.find((s) => s.startsWith("UPDATE staging_boss_override_tires"));
  assert.ok(updateStmt, "expected a blank-fill UPDATE statement");
  assert.match(updateStmt, /WHERE barcode = '8848116004626'/, "UPDATE must target the barcode-holding row, not the losing uid's rows");
  const deleteStmt = statements.find((s) => s.startsWith("DELETE FROM staging_boss_override_tires"));
  assert.ok(deleteStmt, "expected a DELETE statement for the approved drops");
  assert.match(deleteStmt, /'0003220017209'/);
  assert.match(deleteStmt, /'003220017209'/);
  const pnStmt = statements.find((s) => s.startsWith("INSERT OR REPLACE INTO staging_boss_override_tire_part_numbers"));
  assert.ok(pnStmt, "expected a tire_part_numbers repoint");
  assert.match(pnStmt, /\('BH1600462', 'TIRE_E244BE67DF8DBFDEFC72'\)/, "part number must repoint to the barcode-holding (winning) uid, not the losing uid");
});

test("assertKnownLedgerActions: accepts every KNOWN_LEDGER_ACTIONS value and rejects an unrecognized/typo'd action", () => {
  for (const action of KNOWN_LEDGER_ACTIONS) {
    assert.doesNotThrow(() => assertKnownLedgerActions([conflictLedgerRow({ action })]));
  }
  assert.throws(
    () => assertKnownLedgerActions([conflictLedgerRow({ action: "udpate_blank_fill" })]), // typo
    /unknown action value/
  );
});

test("KNOWN_LEDGER_ACTIONS is exactly the five documented dispositions", () => {
  assert.deepEqual(
    new Set(KNOWN_LEDGER_ACTIONS),
    new Set(["update_blank_fill", "insert_preserve_uid", "insert_new_uid", "review_cross_uid_conflict", "defer_review"])
  );
});

// =============================================================================================
// FINDING 2 FIX (Codex ultra-review MEDIUM, 2026-08-05): `ledger`'s printed conflict summary must
// report blocking/resolved/deferred honestly, matching unresolvedConflictRows (keyed on `action`)
// rather than the immutable `match_basis` alone.
// =============================================================================================

test("summarizeConflictLabels: an unedited both_conflict row is blocking, not resolved or deferred", () => {
  const ledger = [conflictLedgerRow()];
  const { blocking, resolved, deferred } = summarizeConflictLabels(ledger);
  assert.equal(blocking.length, 1);
  assert.equal(resolved.length, 0);
  assert.equal(deferred.length, 0);
});

test("summarizeConflictLabels: a hand-resolved both_conflict row (action=update_blank_fill) is reported RESOLVED, not blocking", () => {
  const resolved = conflictLedgerRow({ action: "update_blank_fill", current_uid: "TIRE_WINNER" });
  const labels = summarizeConflictLabels([resolved]);
  assert.equal(labels.blocking.length, 0, "must not appear in the blocking list Codex flagged as dishonest");
  assert.equal(labels.resolved.length, 1);
  assert.equal(labels.resolved[0].item_number, "BH1600462");
  assert.equal(labels.deferred.length, 0);
});

test("summarizeConflictLabels: a deferred both_conflict row (action=defer_review) is reported DEFERRED, not blocking or resolved", () => {
  const deferred = conflictLedgerRow({ item_number: "NX10557", action: "defer_review" });
  const labels = summarizeConflictLabels([deferred]);
  assert.equal(labels.blocking.length, 0);
  assert.equal(labels.resolved.length, 0);
  assert.equal(labels.deferred.length, 1);
  assert.equal(labels.deferred[0].item_number, "NX10557");
});

test("summarizeConflictLabels: mixed set splits into exactly blocking/resolved/deferred, agrees with unresolvedConflictRows for blocking, and ignores non-conflict rows entirely", () => {
  const stillOpen = conflictLedgerRow({ item_number: "BH1600467" });
  const resolvedRow = conflictLedgerRow({ item_number: "BH1600462", action: "insert_preserve_uid", current_uid: "TIRE_X" });
  const deferredRow = conflictLedgerRow({ item_number: "NX10557", action: "defer_review" });
  const nonConflict = { item_number: "BH0000099", desired_barcode: "1", current_barcodes: [], match_basis: "none", current_uid: "TIRE_NEW", action: "insert_new_uid", old_keys_to_drop: [], part_number_alias_to_add: "BH0000099", source_row: 1, decision_reason: "n/a" };
  const ledger = [stillOpen, resolvedRow, deferredRow, nonConflict];
  const { blocking, resolved, deferred } = summarizeConflictLabels(ledger);
  assert.deepEqual(blocking.map((r) => r.item_number), ["BH1600467"]);
  assert.deepEqual(resolved.map((r) => r.item_number), ["BH1600462"]);
  assert.deepEqual(deferred.map((r) => r.item_number), ["NX10557"]);
  assert.deepEqual(
    blocking.map((r) => r.item_number),
    unresolvedConflictRows(ledger).map((r) => r.item_number),
    "blocking list must always agree with the real promote gate (unresolvedConflictRows)"
  );
});

// =============================================================================================
// FINDING 1 FIX (Codex ultra-review HIGH, 2026-08-05): stale-ledger rerun guard - protects a future
// `stage` run against re-applying an already-promoted ledger.
// =============================================================================================

function insertLedgerRow(overrides = {}) {
  return {
    item_number: "BH9999001", desired_barcode: "8848199990010", current_barcodes: [],
    match_basis: "none", current_uid: "TIRE_FRESH", action: "insert_new_uid",
    old_keys_to_drop: [], part_number_alias_to_add: "BH9999001", source_row: 100,
    decision_reason: "n/a",
    ...overrides,
  };
}

test("sampleInsertBarcodesForStaleCheck: returns [] when the ledger has no insert_* rows", () => {
  const ledger = [conflictLedgerRow()]; // review_cross_uid_conflict, not insert_*
  assert.deepEqual(sampleInsertBarcodesForStaleCheck(ledger), []);
});

test("sampleInsertBarcodesForStaleCheck: returns every barcode when the insert_* count is below sampleSize, excluding non-insert_* rows", () => {
  const ledger = [
    insertLedgerRow({ item_number: "A", desired_barcode: "1" }),
    insertLedgerRow({ item_number: "B", desired_barcode: "2", action: "insert_preserve_uid" }),
    conflictLedgerRow(), // must be excluded - not insert_*
  ];
  const sample = sampleInsertBarcodesForStaleCheck(ledger, 25);
  assert.deepEqual(new Set(sample), new Set(["1", "2"]));
});

test("sampleInsertBarcodesForStaleCheck: caps at sampleSize and is deterministic across repeated calls (no randomness)", () => {
  const ledger = [];
  for (let i = 0; i < 100; i++) ledger.push(insertLedgerRow({ item_number: `I${i}`, desired_barcode: `BC${i}` }));
  const first = sampleInsertBarcodesForStaleCheck(ledger, 10);
  const second = sampleInsertBarcodesForStaleCheck(ledger, 10);
  assert.equal(first.length, 10);
  assert.deepEqual(first, second, "sampling must be deterministic - no randomness");
});

test("detectStaleLedger: neither signal present -> not stale", () => {
  const result = detectStaleLedger({ batchAlreadyExists: false, existingSampledBarcodes: [] });
  assert.equal(result.stale, false);
  assert.equal(result.reason, "");
});

test("detectStaleLedger: provenance batch already exists in the clone -> stale, ABORT reason names the batch and instructs a fresh ledger re-run", () => {
  const result = detectStaleLedger({ batchAlreadyExists: true, existingSampledBarcodes: [] });
  assert.equal(result.stale, true);
  assert.ok(result.reason.includes(`${SOURCE_NAME}/${BATCH_ID}`));
  assert.match(result.reason, /Re-run "ledger"/);
});

test("detectStaleLedger: >0 sampled insert targets already exist in the clone -> stale, ABORT reason lists the offending barcodes", () => {
  const result = detectStaleLedger({ batchAlreadyExists: false, existingSampledBarcodes: ["8848100000010", "8848100000020"] });
  assert.equal(result.stale, true);
  assert.match(result.reason, /8848100000010/);
  assert.match(result.reason, /8848100000020/);
});

test("detectStaleLedger: either signal alone is sufficient to ABORT (and both together also stale)", () => {
  assert.equal(detectStaleLedger({ batchAlreadyExists: true, existingSampledBarcodes: [] }).stale, true);
  assert.equal(detectStaleLedger({ batchAlreadyExists: false, existingSampledBarcodes: ["x"] }).stale, true);
  assert.equal(detectStaleLedger({ batchAlreadyExists: true, existingSampledBarcodes: ["x"] }).stale, true);
});

test("applyLedgerStatements: existingProvenanceKeys default (empty) inserts provenance normally - no behavior change for a fresh stage run", () => {
  const bossRows = [bossRow()];
  const entry = insertLedgerRow({ item_number: "BH0000001", desired_barcode: "8848100000010", current_uid: "TIRE_NEW", part_number_alias_to_add: "BH0000001" });
  const { statements, counts } = applyLedgerStatements([entry], bossRows, 1, "2026-08-05T00:00:00.000Z");
  assert.equal(counts.provenanceInserted, 1);
  assert.equal(counts.provenanceSkippedDuplicate, 0);
  assert.ok(statements.some((s) => s.startsWith("INSERT OR REPLACE INTO staging_boss_override_provenance")));
});

test("applyLedgerStatements: a provenance row whose (batch_id, product_id, row, barcode) key already exists is skipped (idempotent), while a non-matching row in the same call still inserts", () => {
  const sheet1 = loadSheet1RowIndex();
  const itemA = "BH0000001";
  const itemB = "BH0000002";
  const rowA = String(sheet1.get(itemA) ?? "");
  const bossRows = [bossRow({ item_number: itemA, barcode: "8848100000010" }), bossRow({ item_number: itemB, barcode: "8848100000020" })];
  const entryA = insertLedgerRow({ item_number: itemA, desired_barcode: "8848100000010", current_uid: "TIRE_NEW_A", part_number_alias_to_add: itemA });
  const entryB = insertLedgerRow({ item_number: itemB, desired_barcode: "8848100000020", current_uid: "TIRE_NEW_B", part_number_alias_to_add: itemB });
  const existingProvenanceKeys = new Set([`${BATCH_ID}::TIRE_NEW_A::${rowA}::8848100000010`]);
  const { statements, counts } = applyLedgerStatements([entryA, entryB], bossRows, 1, "2026-08-05T00:00:00.000Z", existingProvenanceKeys);
  assert.equal(counts.provenanceInserted, 1, "only entryB's provenance row should be inserted");
  assert.equal(counts.provenanceSkippedDuplicate, 1, "entryA's duplicate provenance row must be skipped");
  const provStmt = statements.find((s) => s.startsWith("INSERT OR REPLACE INTO staging_boss_override_provenance"));
  assert.ok(provStmt);
  assert.match(provStmt, /'TIRE_NEW_B'/);
  assert.ok(!provStmt.includes("'TIRE_NEW_A'"), "the deduped row's product_id must not appear in the provenance INSERT");
});

test("applyLedgerStatements: idempotency guard is per-key, not all-or-nothing - both rows insert when neither key matches an unrelated existing key", () => {
  const bossRows = [bossRow({ item_number: "BH0000001", barcode: "8848100000010" }), bossRow({ item_number: "BH0000002", barcode: "8848100000020" })];
  const entryA = insertLedgerRow({ item_number: "BH0000001", desired_barcode: "8848100000010", current_uid: "TIRE_NEW_A", part_number_alias_to_add: "BH0000001" });
  const entryB = insertLedgerRow({ item_number: "BH0000002", desired_barcode: "8848100000020", current_uid: "TIRE_NEW_B", part_number_alias_to_add: "BH0000002" });
  const existingProvenanceKeys = new Set(["SOME_OTHER_BATCH::TIRE_UNRELATED::999::0"]);
  const { counts } = applyLedgerStatements([entryA, entryB], bossRows, 1, "2026-08-05T00:00:00.000Z", existingProvenanceKeys);
  assert.equal(counts.provenanceInserted, 2);
  assert.equal(counts.provenanceSkippedDuplicate, 0);
});

// =============================================================================================
// DROP-PROVENANCE FIX (second-reviewer finding, 2026-08-05): every old_keys_to_drop barcode must get
// its own provenance documentation row (evidence_level=superseded_placeholder_dropped), so the
// removal has an in-database trace, not only the external boss_override_actions.jsonl.
// =============================================================================================

test("applyLedgerStatements: every old_keys_to_drop barcode gets its own provenance documentation row (evidence_level=superseded_placeholder_dropped, license_note=decision_reason)", () => {
  const bossRows = [bossRow({ item_number: "BH1600462", barcode: "8848116004626", brand: "Blackhawk", size_raw: "2755520" })];
  const decisionReason = "RESOLVED (owner decision): repoint to the barcode-holding uid; drop losing uid's placeholders.";
  const resolved = conflictLedgerRow({
    action: "update_blank_fill",
    current_uid: "TIRE_E244BE67DF8DBFDEFC72",
    old_keys_to_drop: ["0003220017209", "003220017209"],
    part_number_alias_to_add: "BH1600462",
    decision_reason: decisionReason,
  });
  const { statements, counts } = applyLedgerStatements([resolved], bossRows, 1, "2026-08-05T00:00:00.000Z");
  // 1 provenance row for the update_blank_fill itself + 2 for the 2 dropped barcodes = 3 total.
  assert.equal(counts.provenanceInserted, 3);
  const provStmt = statements.find((s) => s.startsWith("INSERT OR REPLACE INTO staging_boss_override_provenance"));
  assert.ok(provStmt);
  assert.match(provStmt, /superseded_placeholder_dropped/);
  assert.match(provStmt, /'0003220017209'/);
  assert.match(provStmt, /'003220017209'/);
  const escapedReason = decisionReason.replace(/'/g, "''");
  assert.ok(provStmt.includes(escapedReason), "decision_reason must be carried into license_note (SQL-escaped)");
});

test("applyLedgerStatements: drop-provenance rows record product_id=current_uid (the surviving uid), same as the row's own apply-provenance row", () => {
  const bossRows = [bossRow({ item_number: "BH1600462", barcode: "8848116004626" })];
  const resolved = conflictLedgerRow({ action: "update_blank_fill", current_uid: "TIRE_WINNER", old_keys_to_drop: ["0003220017209"] });
  const { statements } = applyLedgerStatements([resolved], bossRows, 1, "2026-08-05T00:00:00.000Z");
  const provStmt = statements.find((s) => s.startsWith("INSERT OR REPLACE INTO staging_boss_override_provenance"));
  const winnerCount = (provStmt.match(/'TIRE_WINNER'/g) || []).length;
  assert.equal(winnerCount, 2, "both the apply row and the drop-documentation row must be attributed to the surviving uid");
});

test("applyLedgerStatements: an entry with NO old_keys_to_drop produces no extra drop-documentation rows", () => {
  const bossRows = [bossRow()];
  const entry = insertLedgerRow({ item_number: "BH0000001", desired_barcode: "8848100000010", current_uid: "TIRE_NEW", part_number_alias_to_add: "BH0000001" });
  const { counts } = applyLedgerStatements([entry], bossRows, 1, "2026-08-05T00:00:00.000Z");
  assert.equal(counts.provenanceInserted, 1, "only the row's own apply-provenance row - no drops means no drop rows");
});

// =============================================================================================
// annotate-drops (second-reviewer finding, 2026-08-05): LIVE backfill documentation for the
// already-promoted run's 18 old_keys_to_drop barcodes, which predate the drop-provenance fix above
// and currently have no in-database trace. buildDropAnnotationPlan is pure (fixture-testable);
// cmdAnnotateDrops is exercised end-to-end against a MOCKED client (no live Turso, no network).
// =============================================================================================

test("buildDropAnnotationPlan: builds one row per old_keys_to_drop barcode, with the entry's decision_reason as license_note and evidence_level=superseded_placeholder_dropped", () => {
  const bossRows = [bossRow({ item_number: "BH1600462", barcode: "8848116004626" })];
  const ledger = [conflictLedgerRow({
    action: "update_blank_fill", current_uid: "TIRE_WINNER",
    old_keys_to_drop: ["0003220017209", "003220017209"],
    decision_reason: "already-promoted drop, backfilled",
  })];
  const { toInsert, skipped, totalCandidates } = buildDropAnnotationPlan(ledger, bossRows, new Set(), 500, "2026-08-05T12:00:00.000Z");
  assert.equal(totalCandidates, 2);
  assert.equal(skipped, 0);
  assert.equal(toInsert.length, 2);
  assert.deepEqual(new Set(toInsert.map((r) => r.barcode)), new Set(["0003220017209", "003220017209"]));
  for (const r of toInsert) {
    assert.equal(r.product_id, "TIRE_WINNER");
    assert.equal(r.evidence_level, "superseded_placeholder_dropped");
    assert.equal(r.license_note, "already-promoted drop, backfilled");
    assert.equal(r.batch_id, BATCH_ID);
    assert.equal(r.source_name, SOURCE_NAME);
  }
  assert.deepEqual(new Set(toInsert.map((r) => r.id)), new Set([500, 501]));
});

test("buildDropAnnotationPlan: skips any (batch_id, product_id, row, barcode) already present in existingLiveProvenanceKeys - idempotent for a rerun", () => {
  const bossRows = [bossRow({ item_number: "BH1600462", barcode: "8848116004626" })];
  const ledger = [conflictLedgerRow({ action: "update_blank_fill", current_uid: "TIRE_WINNER", old_keys_to_drop: ["0003220017209", "003220017209"] })];
  const sheet1 = loadSheet1RowIndex();
  const row = String(sheet1.get("BH1600462") ?? "");
  const existingKeys = new Set([`${BATCH_ID}::TIRE_WINNER::${row}::0003220017209`]);
  const { toInsert, skipped, totalCandidates } = buildDropAnnotationPlan(ledger, bossRows, existingKeys, 1, "2026-08-05T12:00:00.000Z");
  assert.equal(totalCandidates, 2);
  assert.equal(skipped, 1);
  assert.equal(toInsert.length, 1);
  assert.equal(toInsert[0].barcode, "003220017209");
});

test("buildDropAnnotationPlan: entries with no drops contribute nothing; review_cross_uid_conflict / defer_review entries are excluded even if they carried old_keys_to_drop", () => {
  const bossRows = [bossRow({ item_number: "BH0000001", barcode: "8848100000010" })];
  const noDrops = insertLedgerRow({ item_number: "BH0000001", desired_barcode: "8848100000010", current_uid: "TIRE_NEW", part_number_alias_to_add: "BH0000001" });
  const stillBlocking = conflictLedgerRow({ old_keys_to_drop: ["SHOULD_NOT_APPEAR"] }); // action still review_cross_uid_conflict
  const deferred = conflictLedgerRow({ item_number: "NX10557", action: "defer_review", old_keys_to_drop: ["ALSO_SHOULD_NOT_APPEAR"] });
  const { toInsert, totalCandidates } = buildDropAnnotationPlan([noDrops, stillBlocking, deferred], bossRows, new Set(), 1, "2026-08-05T12:00:00.000Z");
  assert.equal(totalCandidates, 0);
  assert.equal(toInsert.length, 0);
});

function makeMockProvenanceClient({ existingRows = [], maxId = 999999 } = {}) {
  const batchCalls = [];
  const executeCalls = [];
  const client = {
    async execute(query) {
      const sql = typeof query === "string" ? query : query.sql;
      executeCalls.push(sql);
      if (sql.includes("MAX(id)")) return { rows: [{ m: maxId }] };
      if (sql.includes("FROM provenance WHERE batch_id")) return { rows: existingRows };
      throw new Error(`mock provenance client: unexpected query: ${sql}`);
    },
    async batch(statements) {
      batchCalls.push(statements);
      return statements.map(() => ({}));
    },
    close() {},
  };
  return { client, batchCalls, executeCalls };
}

function loadRealBossLedgerForTest() {
  const lines = readFileSync("backups/boss-export-2026-08-05/boss_override_actions.jsonl", "utf8").split(/\r?\n/).filter(Boolean);
  return lines.map((l) => JSON.parse(l));
}

test("cmdAnnotateDrops (mocked client, NO live Turso): a fresh run with nothing pre-documented inserts all 18 real drop rows in one batch() call targeting LIVE provenance", async () => {
  const prevConfirm = process.env.PROMOTE_CONFIRM;
  process.env.PROMOTE_CONFIRM = "YES";
  try {
    const { client, batchCalls } = makeMockProvenanceClient({ existingRows: [] });
    const result = await cmdAnnotateDrops({ dryRun: false }, async () => client);
    assert.equal(result.totalCandidates, 18, "the real 2026-08-05 boss ledger has exactly 18 old_keys_to_drop barcodes across 9 both_conflict resolutions");
    assert.equal(result.skipped, 0);
    assert.equal(result.toInsert.length, 18);
    assert.equal(batchCalls.length, 1, "18 rows fit in a single 200-tuple chunk - exactly one client.batch() call");
    const [statements] = batchCalls;
    assert.ok(statements.every((s) => s.startsWith("INSERT OR REPLACE INTO provenance")), "must target LIVE provenance, not a staging_boss_override_* table");
    assert.ok(statements.some((s) => s.includes("superseded_placeholder_dropped")));
  } finally {
    if (prevConfirm === undefined) delete process.env.PROMOTE_CONFIRM;
    else process.env.PROMOTE_CONFIRM = prevConfirm;
  }
});

test("cmdAnnotateDrops (mocked client, NO live Turso): a rerun where every candidate is already documented inserts nothing and never calls client.batch() (idempotent)", async () => {
  const prevConfirm = process.env.PROMOTE_CONFIRM;
  process.env.PROMOTE_CONFIRM = "YES";
  try {
    const ledger = loadRealBossLedgerForTest();
    const bossRows = loadBossRows();
    const { toInsert: allCandidates } = buildDropAnnotationPlan(ledger, bossRows, new Set(), 1, "2026-08-05T00:00:00.000Z");
    assert.equal(allCandidates.length, 18);
    const alreadyDocumentedRows = allCandidates.map((r) => ({ batch_id: r.batch_id, product_id: r.product_id, row: r.row, barcode: r.barcode }));
    const { client, batchCalls } = makeMockProvenanceClient({ existingRows: alreadyDocumentedRows });
    const result = await cmdAnnotateDrops({ dryRun: false }, async () => client);
    assert.equal(result.totalCandidates, 18);
    assert.equal(result.skipped, 18);
    assert.equal(result.toInsert.length, 0);
    assert.equal(batchCalls.length, 0, "nothing to insert means client.batch() must never be called");
  } finally {
    if (prevConfirm === undefined) delete process.env.PROMOTE_CONFIRM;
    else process.env.PROMOTE_CONFIRM = prevConfirm;
  }
});

test("cmdAnnotateDrops: dry-run never touches the client at all (no execute, no batch) and does not require PROMOTE_CONFIRM", async () => {
  const prevConfirm = process.env.PROMOTE_CONFIRM;
  delete process.env.PROMOTE_CONFIRM;
  try {
    const { client, batchCalls, executeCalls } = makeMockProvenanceClient();
    await cmdAnnotateDrops({ dryRun: true }, async () => client);
    assert.equal(executeCalls.length, 0);
    assert.equal(batchCalls.length, 0);
  } finally {
    if (prevConfirm === undefined) delete process.env.PROMOTE_CONFIRM;
    else process.env.PROMOTE_CONFIRM = prevConfirm;
  }
});

test("cmdAnnotateDrops: without --dry-run and without PROMOTE_CONFIRM=YES, refuses to run (same live-write gate as backup/stage/verify/promote/rollback)", async () => {
  const prevConfirm = process.env.PROMOTE_CONFIRM;
  delete process.env.PROMOTE_CONFIRM;
  const prevExit = process.exit;
  let exitCode = null;
  process.exit = (code) => { exitCode = code; throw new Error("__mock_process_exit__"); };
  try {
    const { client } = makeMockProvenanceClient();
    await assert.rejects(() => cmdAnnotateDrops({ dryRun: false }, async () => client), /__mock_process_exit__/);
    assert.equal(exitCode, 3);
  } finally {
    process.exit = prevExit;
    if (prevConfirm === undefined) delete process.env.PROMOTE_CONFIRM;
    else process.env.PROMOTE_CONFIRM = prevConfirm;
  }
});
