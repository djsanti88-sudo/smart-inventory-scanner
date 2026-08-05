// Unit tests for the boss-override-2026-08-05.mjs actions-ledger classifier (AM-B3-2/AM-B3-4).
// Pure-function tests only - no live Turso connection, no network. Run with:
//   node --test scripts/boss-override-2026-08-05.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
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
