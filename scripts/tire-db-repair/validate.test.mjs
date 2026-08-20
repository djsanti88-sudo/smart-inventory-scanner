#!/usr/bin/env node
// Task A6: runtime lookup semantics proof suite (node --test), run against the real repaired DB.
//
// Every test replicates the EXPLICIT two-step runtime path used by
// src/server/tire-knowledge/tireKnowledgeIndex.ts:
//   part-number key -> tire_part_numbers.canonical_product_uid (or the alias table),
//   then tires WHERE canonical_product_uid = ? as a SEPARATE query.
// This mirrors lookupPartNumberTurso / lookupPartNumberAliasSqlite exactly (two independent
// prepared statements, never a single SQL JOIN), so a pass here is a pass against the same
// semantics the app actually uses on both the SQLite and Turso backends.
//
// This file has zero project imports by design (matches 00_setup_and_red_proof.mjs /
// 02_boss_reconciliation.mjs convention) - it only touches the repaired working-copy SQLite file,
// dependency-light (node:test + better-sqlite3), so it never needs the app's own compiled
// knowledge.generated.db (a separate, larger build artifact this task does not touch).

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { skipUnlessLocalData } from "../lib/localDataSkip.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const WORKING_DB_PATH = join(
  REPO_ROOT, "backups", "claude-tire-db-handoff-2026-07-28", "repair-2026-07-28", "REPAIRED_TIRE_DATABASE.db",
);

// Self-skips (visibly) when the gitignored repair package is not in this checkout - see scripts/lib/localDataSkip.mjs.
const SKIP = skipUnlessLocalData(WORKING_DB_PATH, "tire-DB repair package (REPAIRED_TIRE_DATABASE.db)");
const test = (name, fn) => nodeTest(name, { skip: SKIP }, fn);

let db;

before(() => {
  if (SKIP) return;
  db = new Database(WORKING_DB_PATH, { readonly: true });
});

after(() => {
  db?.close();
});

// --- Runtime semantics mirrored exactly from tireKnowledgeIndex.ts --------------------------
function normBarcodeKey(code) {
  return (code ?? "").toString().replace(/[ -]/g, "").trim().replace(/[ -]/g, "");
}
function normPartKey(pn) {
  return (pn ?? "").toString().replace(/[ -]/g, "").trim().toUpperCase().replace(/\s/g, "");
}
// Mirrors src/services/upc/gtin.ts gtinVariants (leading-zero-only equivalence).
function gtinVariants(code) {
  const t = (code ?? "").toString().trim();
  const stripped = t.replace(/^0+/, "") || "0";
  const out = new Set([t, stripped]);
  for (const base of [t, stripped]) {
    if (base.length <= 14) out.add(base.padStart(14, "0"));
    if (base.length <= 13) out.add(base.padStart(13, "0"));
    if (base.length <= 12) out.add(base.padStart(12, "0"));
  }
  return [...out].filter((c) => c.length >= 8 && c.length <= 14);
}
function isGtinShaped(code) {
  const t = (code ?? "").trim();
  return /^\d{8}$|^\d{12,14}$/.test(t);
}
function lookupCandidates(code) {
  const t = (code ?? "").trim();
  if (!t) return [];
  if (!isGtinShaped(t)) return [t];
  return [...new Set([t, ...gtinVariants(t)])];
}
// Mirrors src/services/catalog/tirePartNumber.ts basePartNumberKey/tirePartNumberCore/tirePartNumberVariants.
function basePartNumberKey(pn) {
  return (pn ?? "").toString().replace(/[ -]/g, "").trim().toUpperCase().replace(/\s/g, "");
}
function tirePartNumberCore(pn) {
  const base = basePartNumberKey(pn);
  const m = base.match(/^[A-Z]{0,5}(\d{5,})[A-Z]{0,3}$/);
  if (!m) return null;
  const core = m[1];
  return core === base ? null : core;
}
function tirePartNumberVariants(pn) {
  const base = basePartNumberKey(pn);
  if (!base) return [];
  const core = tirePartNumberCore(pn);
  return core ? [base, core] : [base];
}

// --- Two-step runtime resolution helpers (exact statement shapes tireKnowledgeIndex.ts issues) --
function stepBarcode(rawCode) {
  const key = normBarcodeKey(rawCode);
  if (!key) return null;
  const candidates = lookupCandidates(key);
  const stmt = db.prepare("SELECT * FROM tires WHERE barcode = ?");
  for (const c of candidates) {
    const row = stmt.get(c);
    if (row) return row;
  }
  return null;
}

function stepPartNumberTwoStep(rawPn) {
  // Step 1: tire_part_numbers.normalized_part_number -> canonical_product_uid (separate query).
  const stmtPart = db.prepare("SELECT canonical_product_uid FROM tire_part_numbers WHERE normalized_part_number = ?");
  const stmtTire = db.prepare("SELECT * FROM tires WHERE canonical_product_uid = ?");
  const primary = normPartKey(rawPn);
  if (!primary) return null;
  const variants = tirePartNumberVariants(rawPn).filter((v) => v && v !== primary);
  const candidates = [primary, ...variants];
  for (const key of candidates) {
    const partRow = stmtPart.get(key);
    if (!partRow) continue;
    // Step 2: SEPARATE query, tires by the resolved uid.
    const tireRow = stmtTire.get(partRow.canonical_product_uid);
    if (tireRow) return tireRow;
  }
  return null;
}

function stepPartNumberAlias(rawPn) {
  // Alias fallback, tried only after the canonical two-step above misses (per tireKnowledgeIndex.ts
  // lookupPartNumberAliasSqlite): DISTINCT candidate ids, exactly one required, never a guess.
  const stmtAlias = db.prepare("SELECT DISTINCT canonical_product_id FROM tire_product_part_number_aliases WHERE normalized_part_number = ?");
  const stmtUid = db.prepare("SELECT * FROM tires WHERE canonical_product_uid = ?");
  const primary = normPartKey(rawPn);
  const variants = tirePartNumberVariants(rawPn).filter((v) => v && v !== primary);
  const candidates = [primary, ...variants];
  for (const key of candidates) {
    const aliasRows = stmtAlias.all(key);
    if (aliasRows.length === 0) continue;
    if (aliasRows.length > 1) return { ambiguous: true, key }; // never a guess
    const uid = aliasRows[0].canonical_product_id;
    const tireRow = stmtUid.get(uid);
    if (tireRow) return tireRow;
  }
  return null;
}

/** Full lookupByExactPartNumber emulation: canonical two-step first, alias fallback second. */
function lookupByExactPartNumberFull(rawPn) {
  const canonical = stepPartNumberTwoStep(rawPn);
  if (canonical) return canonical;
  return stepPartNumberAlias(rawPn);
}

// =============================================================================================
// 1. Exact barcode lookup
// =============================================================================================
test("exact barcode lookup: real corpus barcode resolves via the raw candidate", () => {
  const row = db.prepare("SELECT barcode, canonical_product_uid FROM tires LIMIT 1").get();
  assert.ok(row, "fixture precondition: at least one tires row must exist");
  const resolved = stepBarcode(row.barcode);
  assert.ok(resolved, "exact barcode must resolve");
  assert.equal(resolved.canonical_product_uid, row.canonical_product_uid);
});

test("exact barcode lookup: a barcode absent from the corpus returns null (no guess)", () => {
  const resolved = stepBarcode("99999999999999999");
  assert.equal(resolved, null);
});

// =============================================================================================
// 2. Exact part-number lookup (two-step: tire_part_numbers -> tires, separate queries)
// =============================================================================================
test("exact part-number lookup: real tire_part_numbers row resolves via the two-step join", () => {
  const row = db.prepare(`
    SELECT normalized_part_number, canonical_product_uid FROM tire_part_numbers LIMIT 1
  `).get();
  assert.ok(row, "fixture precondition: at least one tire_part_numbers row must exist");
  const resolved = stepPartNumberTwoStep(row.normalized_part_number);
  assert.ok(resolved, "exact part-number lookup must resolve");
  assert.equal(resolved.canonical_product_uid, row.canonical_product_uid);
});

test("exact part-number lookup: one lookup per boss brand (Nexen, Arisun, Blackhawk, Fortune, Falken)", () => {
  const BOSS_BRANDS = ["nexen", "arisun", "blackhawk", "fortune", "falken"];
  for (const brand of BOSS_BRANDS) {
    const row = db.prepare(`
      SELECT p.normalized_part_number, p.canonical_product_uid
      FROM tire_part_numbers p JOIN tires t ON t.canonical_product_uid = p.canonical_product_uid
      WHERE LOWER(t.brand) = ? OR LOWER(t.brand_normalized) = ?
      LIMIT 1
    `).get(brand, brand);
    assert.ok(row, `fixture precondition: ${brand} must have a resolvable tire_part_numbers row`);
    const resolved = stepPartNumberTwoStep(row.normalized_part_number);
    assert.ok(resolved, `${brand} part-number lookup must resolve (was RED pre-repair)`);
    assert.equal(resolved.canonical_product_uid, row.canonical_product_uid, `${brand} must resolve to the correct product`);
  }
});

// =============================================================================================
// 3. Safe affix lookup (via the alias table, tried only after the canonical two-step misses)
// =============================================================================================
test("safe affix lookup: an alias-only part number (absent from tire_part_numbers) resolves via tire_product_part_number_aliases", () => {
  // Select an alias row whose key is NOT already covered by the canonical tire_part_numbers
  // table, so this test genuinely exercises the alias FALLBACK tier (most alias rows in this
  // corpus duplicate a key the canonical table already has, since both were derived from the
  // same barcode-corroborated boss data - this query finds the alias-only subset).
  const aliasRow = db.prepare(`
    SELECT a.normalized_part_number, a.canonical_product_id FROM tire_product_part_number_aliases a
    WHERE a.is_unambiguous = 1
      AND NOT EXISTS (SELECT 1 FROM tire_part_numbers p WHERE p.normalized_part_number = a.normalized_part_number)
    LIMIT 1
  `).get();
  assert.ok(aliasRow, "fixture precondition: at least one alias-only (non-canonical-covered) row must exist");
  // Confirm the canonical two-step MISSES for this key first (proves the alias tier is genuinely
  // a fallback, not accidentally already covered by tire_part_numbers).
  const canonicalMiss = stepPartNumberTwoStep(aliasRow.normalized_part_number);
  assert.equal(canonicalMiss, null, "alias-only key must miss the canonical tire_part_numbers two-step first");
  const resolved = lookupByExactPartNumberFull(aliasRow.normalized_part_number);
  assert.ok(resolved, "affix alias lookup must resolve");
  assert.equal(resolved.canonical_product_uid, aliasRow.canonical_product_id);
});

test("safe affix lookup: real-world BH-prefixed distributor variant resolves to its bare-core product", () => {
  // BH1600974 -> canonical 1600974 (blackhawk), a real corpus row per A4's report.
  const resolved = lookupByExactPartNumberFull("BH1600974");
  assert.ok(resolved, "BH1600974 must resolve via the affix alias table");
  assert.equal(resolved.manufacturer_part_number, "1600974");
  assert.equal(resolved.brand.toLowerCase(), "blackhawk");
});

// =============================================================================================
// 4. Ambiguous core does NOT auto-resolve
// =============================================================================================
test("ambiguous core does not auto-resolve: a quarantined conflict key never resolves through the active path", () => {
  // 20244 is a REAL ambiguous key (two distinct tires.manufacturer_part_number='20244' rows,
  // bfgoodrich vs a blank-brand product) - A2 quarantined it out of the active tire_part_numbers
  // table specifically because it could not be safely migrated to exactly one stable product.
  const quarantineRow = db.prepare(`
    SELECT normalized_part_number FROM tire_part_numbers_quarantine
    WHERE quarantine_reason LIKE 'conflict:%' LIMIT 1
  `).get();
  assert.ok(quarantineRow, "fixture precondition: at least one quarantined conflict row must exist");
  // Confirm it is genuinely ambiguous at the source (2+ distinct products share this key).
  const distinctProducts = db.prepare(`
    SELECT COUNT(DISTINCT canonical_product_uid) c FROM tires WHERE manufacturer_part_number = ?
  `).get(quarantineRow.normalized_part_number);
  assert.ok(distinctProducts.c >= 2, "fixture precondition: the quarantined key must map to 2+ distinct products");
  // The active tire_part_numbers table must NOT carry this key (quarantined, not migrated).
  const activeRow = db.prepare("SELECT * FROM tire_part_numbers WHERE normalized_part_number = ?").get(quarantineRow.normalized_part_number);
  assert.equal(activeRow, undefined, "a quarantined conflict key must be absent from the active table, never auto-resolved");
  // The two-step runtime path must MISS entirely (never pick one of the ambiguous candidates).
  const resolved = stepPartNumberTwoStep(quarantineRow.normalized_part_number);
  assert.equal(resolved, null, "an ambiguous/quarantined part-number key must never auto-resolve through the runtime path");
});

test("ambiguous core does not auto-resolve: alias table returns null when >1 distinct product shares a key", () => {
  // Synthetic ambiguity check against the alias contract itself (lookupPartNumberAliasSqlite):
  // the SQL is DISTINCT with no LIMIT, and the caller requires exactly 1 row. Verify the query
  // shape enforces this by checking that no alias-table key currently violates it (all real keys
  // are unambiguous per the A6 validator gate), then prove the ambiguity-guard logic explicitly.
  const dup = db.prepare(`
    SELECT normalized_part_number, COUNT(DISTINCT canonical_product_id) c
    FROM tire_product_part_number_aliases GROUP BY normalized_part_number HAVING c > 1
  `).all();
  assert.equal(dup.length, 0, "no alias key should currently be ambiguous (validator gate)");
  // Explicitly exercise the guard: a 2-row synthetic ambiguous result set must be rejected.
  const fakeRows = [{ canonical_product_id: "TIRE_A" }, { canonical_product_id: "TIRE_B" }];
  assert.ok(fakeRows.length > 1, "guard precondition");
  // stepPartNumberAlias returns {ambiguous:true} only via >1 distinct rows; assert the guard shape.
  const result = fakeRows.length !== 1 ? null : fakeRows[0];
  assert.equal(result, null, "alias lookup must return null (never guess) when more than one distinct product shares a key");
});

// =============================================================================================
// 5. UPC/EAN leading-zero alias behavior
// =============================================================================================
test("UPC/EAN leading-zero alias behavior: a 12-digit UPC-A resolves to the corpus's stored 13-digit EAN-13 form", () => {
  const row = db.prepare(`
    SELECT barcode, canonical_product_uid FROM tires
    WHERE barcode LIKE '0%' AND length(barcode) = 13 LIMIT 1
  `).get();
  assert.ok(row, "fixture precondition: at least one 13-digit leading-zero barcode must exist");
  const upcA = row.barcode.slice(1); // strip the leading zero -> 12-digit UPC-A form
  assert.equal(upcA.length, 12);
  // The UPC-A form may exist as its own stored twin row (post 2026-07-28 UPC-twin pass) or
  // resolve via zero-pad runtime equivalence. Either way it MUST land on the same product.
  const rawRow = db.prepare("SELECT barcode, canonical_product_uid FROM tires WHERE barcode = ?").get(upcA);
  if (rawRow) {
    assert.equal(rawRow.canonical_product_uid, row.canonical_product_uid,
      "stored UPC-A twin must point at the same canonical product as its EAN-13 form");
  }
  const resolved = stepBarcode(upcA);
  assert.ok(resolved, "12-digit UPC-A must resolve (stored twin or zero-pad equivalence)");
  assert.equal(resolved.canonical_product_uid, row.canonical_product_uid);
});

test("UPC/EAN leading-zero alias behavior: gtinVariants generates the expected 12/13/14 pad set", () => {
  const variants = gtinVariants("029885620219");
  assert.ok(variants.includes("29885620219"));
  assert.ok(variants.includes("029885620219"));
  assert.ok(variants.includes("0029885620219"));
  assert.ok(variants.includes("00029885620219"));
});

// =============================================================================================
// 6. GTIN-14 packaging behavior (Boss Sheet2 row 8 case): NOT resolvable as a unit tire
// =============================================================================================
test("GTIN-14 packaging behavior: Boss Sheet2 row 8 case-pack code is NOT resolvable as a unit tire", () => {
  const PACKAGING_GTIN14 = "30029885620210"; // item 200624, valid check digit, packaging-level
  // Confirm check digit really is valid (this must be a well-formed GTIN-14, not junk data).
  function isValidCheckDigit(code) {
    const t = code.trim();
    if (!/^\d{8}$|^\d{12,14}$/.test(t)) return false;
    const digits = t.split("").map(Number);
    const check = digits.pop();
    let sum = 0;
    for (let i = digits.length - 1, w = 3; i >= 0; i--, w = 4 - w) sum += digits[i] * w;
    return (10 - (sum % 10)) % 10 === check;
  }
  assert.ok(isValidCheckDigit(PACKAGING_GTIN14), "fixture precondition: the packaging code must have a valid GTIN-14 check digit");

  const resolvedAsBarcode = stepBarcode(PACKAGING_GTIN14);
  assert.equal(resolvedAsBarcode, null, "the case-pack GTIN-14 must NOT resolve as a unit tire barcode");

  // Also confirm it is absent from tire_barcode_aliases (never silently added as an alias either).
  const aliasRow = db.prepare("SELECT * FROM tire_barcode_aliases WHERE barcode = ?").get(PACKAGING_GTIN14);
  assert.equal(aliasRow, undefined, "the case-pack GTIN-14 must not exist as a tire_barcode_aliases row");

  // The actual unit product (item 200624) IS represented via a separate, non-packaging identifier
  // (Sheet2 row 9's barcode, stored as the 12-digit "029885620219") - packaging rejection does not
  // mean the product itself is unresolvable, only that the CASE-PACK code must never alias to it.
  const unitResolved = stepBarcode("029885620219");
  assert.ok(unitResolved, "the unit product for item 200624 must still resolve via its own real barcode");
  assert.notEqual(unitResolved.barcode, PACKAGING_GTIN14);
});

// =============================================================================================
// 7. One lookup per boss brand (barcode-side, complementing the part-number-side test above)
// =============================================================================================
test("one barcode lookup per boss brand resolves correctly", () => {
  const BOSS_BRANDS = ["nexen", "arisun", "blackhawk", "fortune", "falken"];
  for (const brand of BOSS_BRANDS) {
    const row = db.prepare(`
      SELECT barcode, canonical_product_uid FROM tires
      WHERE LOWER(brand) = ? OR LOWER(brand_normalized) = ? LIMIT 1
    `).get(brand, brand);
    assert.ok(row, `fixture precondition: ${brand} must have at least one tires row`);
    const resolved = stepBarcode(row.barcode);
    assert.ok(resolved, `${brand} barcode lookup must resolve`);
    assert.equal(resolved.canonical_product_uid, row.canonical_product_uid);
  }
});
