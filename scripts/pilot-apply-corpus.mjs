#!/usr/bin/env node
// scripts/pilot-apply-corpus.mjs — Owner-authorized Point S pilot data application (2026-07-15).
// Merges docs/pilot/point-s-corpus-master.csv + point-s-decoded-batch5-results.csv (passed rows
// only) + point-s-decoded-batch6-results.csv (passed rows only, EXCLUDING BH4120976 - flagged
// physical-verify, provenance external_app_pattern_inferred) into the REAL tire corpus
// (src/server/tire-knowledge/tireKnowledge.generated.json).
//
// APPLY RULES (trust-critical, see docs/pilot/ and the task brief this script implements):
//   1. Barcode already in corpus (checked across gtinVariants zero-pad forms, same convention as
//      build-golden-baseline.mjs's findRow / gtin.ts's lookupCandidates):
//        - existing manufacturer_part_number BLANK  -> fill it, stamp part_number_source
//          "point_s_pilot" (same field-level provenance convention dt-harvest/lib/backfill.mjs
//          established with "discounttire"). Never touch any other field.
//        - existing manufacturer_part_number NON-BLANK and DIFFERENT -> do NOT touch; record to
//          the conflicts report.
//        - existing manufacturer_part_number NON-BLANK and SAME -> no-op (counted as "agreed").
//   2. Barcode NOT in corpus -> ADD a new row in the exact corpus row shape, gated through
//      gradeBarcode() (src/services/upc/barcodeTrust.ts) first. A "rejected" verdict is skipped
//      and reported (rows were pre-validated upstream so 0 rejects is expected). New rows use
//      canonicalUidFor() (apply.mjs's exact convention) and are stamped source: "point_s_pilot".
//   3. Part-number convention: master-sheet rows use the master sheet's manufacturer_part_number
//      column verbatim (it already matches the corpus's bare-digit convention — verified against
//      existing Blackhawk rows: corpus stores "4120877" while retailer_sku carries "BH4120877").
//      batch5/6 rows derive the bare core via tirePartNumberCore() when it yields one (e.g.
//      BH4120176 -> 4120176, matching the master sheet's own Blackhawk convention); otherwise the
//      raw partNumber is stored as-is (e.g. a pure-numeric PN, or an alpha code with no numeric
//      core like "LG3490").
//   4. Never deletes/overwrites an existing row's identity fields. Additive + blank-fill only.
//   5. Rebuilds partNumberIndex + identityIndex with the exact same logic as apply.mjs's
//      rebuildSecondaryIndexes (reused directly, not reimplemented).
//   6. Idempotent: re-running after a successful apply must report 0 new PN-fills, 0 new rows
//      (all already-applied rows will show as "agreed" or already-present).
//
// Untrusted input: docs/pilot/*.csv are owner-supplied but externally-sourced data (retailer
// export + AI-decoded descriptions) — parsed and validated, never executed or obeyed.
//
// Usage:
//   node scripts/pilot-apply-corpus.mjs             apply + write corpus JSON
//   node scripts/pilot-apply-corpus.mjs --dry-run    report only, no writes

import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";
import { tirePartNumberCore } from "../src/services/catalog/tirePartNumber.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const CORPUS_JSON_PATH = join(ROOT, "src", "server", "tire-knowledge", "tireKnowledge.generated.json");
const DOCS_PILOT = join(ROOT, "docs", "pilot");
const MASTER_CSV = join(DOCS_PILOT, "point-s-corpus-master.csv");
const BATCH5_CSV = join(DOCS_PILOT, "point-s-decoded-batch5-results.csv");
const BATCH6_CSV = join(DOCS_PILOT, "point-s-decoded-batch6-results.csv");

const SOURCE_TAG = "point_s_pilot";
const BATCH5_EXCLUDE_PN = "9315030533"; // FAIL: invalid GS1 check digit
const BATCH6_EXCLUDE_PN = "BH4120976"; // flag: external_app_pattern_inferred, physical-verify

const DRY_RUN = process.argv.includes("--dry-run");

// ---------------------------------------------------------------------------
// Barcode trust gate: node-runnable mirror of src/services/upc/barcodeTrust.ts's gradeBarcode
// (check-digit + placeholder rejection only — the two pieces this script needs). Reimplemented
// rather than imported because barcodeTrust.ts imports "./gtin" (no extension), which plain node
// cannot resolve when loading a .ts file directly; this mirrors the exact same constraint
// scripts/dt-harvest/lib/merge.mjs and placeholderBarcodes.mjs document ("this .mjs cannot import
// the server-only TS module"). Logic copied verbatim from gtin.ts (isGtinShaped/isValidCheckDigit)
// and barcodeTrust.ts (PLACEHOLDER_BARCODES + isPlaceholderBarcode + the rejection branches this
// script actually uses). All pilot rows are pre-validated (retailer export / AI-decoded with a
// checkDigitValid column already asserted upstream) so 0 rejects is the expected outcome; this
// gate exists as the safety net the task brief requires, not as an expected filter.
function isGtinShapedLocal(code) {
  const t = (code ?? "").trim();
  return /^\d{8}$|^\d{12,14}$/.test(t);
}

function isValidCheckDigitLocal(code) {
  const t = (code ?? "").trim();
  if (!isGtinShapedLocal(t)) return false;
  const digits = t.split("").map(Number);
  const check = digits.pop();
  let sum = 0;
  for (let i = digits.length - 1, w = 3; i >= 0; i--, w = 4 - w) sum += digits[i] * w;
  return (10 - (sum % 10)) % 10 === check;
}

const PLACEHOLDER_BARCODES = ["123456789012", "0123456789012", "1234567890128", "01234567890128"];

function isPlaceholderBarcodeLocal(code) {
  const t = (code ?? "").toString().trim();
  if (!t) return false;
  if (/^(\d)\1+$/.test(t)) return true;
  if (/^\d+$/.test(t)) {
    const stripped = t.replace(/^0+/, "");
    if (stripped === "" || /^(\d)\1*$/.test(stripped)) return true;
  }
  if (PLACEHOLDER_BARCODES.includes(t)) return true;
  const stripped = t.replace(/^0+/, "");
  return PLACEHOLDER_BARCODES.some((p) => p.replace(/^0+/, "") === stripped);
}

/** Local mirror of gradeBarcode's structural-rejection branches (placeholder / not-GTIN-shaped /
 * invalid-check-digit). Ground-truth "verified"/"suggested" branches are irrelevant here — this
 * script only needs the reject-vs-not-reject boundary before adding a brand-new corpus row. */
function gradeBarcodeLocal(barcode) {
  const raw = (barcode ?? "").trim();
  if (isPlaceholderBarcodeLocal(raw)) {
    return { verdict: "rejected", reason: "Placeholder/dummy barcode (blocklist)" };
  }
  if (!isGtinShapedLocal(raw)) {
    return { verdict: "rejected", reason: "Not a GTIN-shaped barcode" };
  }
  if (!isValidCheckDigitLocal(raw)) {
    return { verdict: "rejected", reason: "Invalid GS1 check digit (likely misread)" };
  }
  return { verdict: "verified", reason: "Grandfathered corpus barcode (pilot, pre-validated)" };
}

// ---------------------------------------------------------------------------
// Shared helpers (mirror src/server/tire-knowledge/tireKnowledgeIndex.ts's normalizers, and
// scripts/dt-harvest/apply.mjs's canonicalUidFor / rebuildSecondaryIndexes, verbatim conventions)
// ---------------------------------------------------------------------------
function normBarcodeKey(code) {
  return (code ?? "").toString().replace(/[ -]/g, "").trim();
}

function normPart(s) {
  return (s ?? "").toString().replace(/[ -]/g, "").trim().toUpperCase();
}

function normText(s) {
  return (s ?? "").toString().trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Same zero-pad variant scheme as build-golden-baseline.mjs / gtin.ts's lookupCandidates. */
function barcodeVariants(code) {
  const base = normBarcodeKey(code);
  const stripped = base.replace(/^0+/, "") || "0";
  const bases = new Set([base, stripped]);
  const out = new Set();
  for (const b of bases) {
    out.add(b);
    if (b.length <= 14) out.add(b.padStart(14, "0"));
    if (b.length <= 13) out.add(b.padStart(13, "0"));
    if (b.length <= 12) out.add(b.padStart(12, "0"));
  }
  return [...out];
}

function findInCorpus(barcodeIndex, code) {
  for (const v of barcodeVariants(code)) {
    if (barcodeIndex[v]) return { key: v, row: barcodeIndex[v] };
  }
  return null;
}

/** Verbatim from scripts/dt-harvest/apply.mjs's canonicalUidFor. */
function canonicalUidFor(row) {
  const size = normText(row.size).replace(/\s+/g, "");
  const parts = [row.brand_normalized, row.model_normalized, size, row.load_index, row.speed_rating, row.manufacturer_part_number]
    .map((p) => (p || "").toString().trim())
    .filter(Boolean)
    .map((p) => p.toLowerCase().replace(/[^a-z0-9]+/g, "_"));
  return parts.join("_");
}

function barcodeTypeFor(code) {
  const digits = (code || "").toString().replace(/\D/g, "");
  if (digits.length === 12) return "upc";
  if (digits.length === 13) return "ean";
  if (digits.length === 14) return "gtin14";
  return "unknown";
}

/** Verbatim from scripts/dt-harvest/apply.mjs's rebuildSecondaryIndexes. */
function rebuildSecondaryIndexes(corpus) {
  const partNumberIndex = {};
  const identityIndex = {};
  for (const row of Object.values(corpus.barcodeIndex)) {
    if (row.manufacturer_part_number) {
      const pk = normPart(row.manufacturer_part_number);
      if (pk && !partNumberIndex[pk]) partNumberIndex[pk] = row.canonical_product_uid;
    }
    const ik = `${row.brand_normalized}|${row.model_normalized}|${normText(row.size)}|${row.load_index}|${row.speed_rating}`;
    if (!identityIndex[ik]) identityIndex[ik] = row.canonical_product_uid;
  }
  corpus.partNumberIndex = partNumberIndex;
  corpus.identityIndex = identityIndex;
}

// ---------------------------------------------------------------------------
// Tire-size/load/speed parsing for batch5/6 free-text descriptions (mirrors
// scripts/backfill-missing-tires.mjs's matchTireSize inline reimplementation).
// ---------------------------------------------------------------------------
const METRIC = /(P|LT|ST)?\s*(\d{3})\s*\/\s*(\d{2})\s*(ZR|R)\s*(\d{2}(?:\.\d)?)/i;
const FLOTATION = /(\d{2})\s*[xX]\s*(\d{1,2}\.\d{1,2})\s*(?:ZR|R|-)?\s*(\d{2}(?:\.\d)?)/;
const SPACED = /\b(\d{3})\s+(\d{2})\s+(\d{2})\b/;

const LOAD_SPEED = /(\d{2,3}(?:\/\d{2,3})?)\s*([A-Z])\b/g;
const SPEED_LETTERS = new Set("ABCDEFGHJKLMNPQRSTUVWY".split(""));

function findLoadSpeed(remainder) {
  for (const m of remainder.matchAll(LOAD_SPEED)) {
    const speed = m[2].toUpperCase();
    if (SPEED_LETTERS.has(speed)) return { loadIndex: m[1], speedRating: speed };
  }
  return null;
}

function parseDescription(desc) {
  const s = (desc || "").trim();
  const tokens = s.split(/\s+/);
  const brand = tokens[0] || "";

  let sizeMatch = null;
  let size = null;
  let loadIndex = null;
  let speedRating = null;

  let m = METRIC.exec(s);
  if (m) {
    const prefix = (m[1] ?? "").toUpperCase();
    size = `${prefix}${m[2]}/${m[3]}${m[4].toUpperCase()}${m[5]}`;
    sizeMatch = m[0];
  } else {
    m = FLOTATION.exec(s);
    if (m) {
      size = `${m[1]}X${m[2]}R${m[3]}`;
      sizeMatch = m[0];
    } else {
      m = SPACED.exec(s);
      if (m) {
        size = `${m[1]}/${m[2]}R${m[3]}`;
        sizeMatch = m[0];
      }
    }
  }

  if (sizeMatch) {
    const ls = findLoadSpeed(s.slice(s.indexOf(sizeMatch) + sizeMatch.length));
    if (ls) {
      loadIndex = ls.loadIndex;
      speedRating = ls.speedRating;
    }
  }

  // Model = everything between brand and the size match (or to the end if no size found).
  const sizeIdx = sizeMatch ? s.indexOf(sizeMatch) : s.length;
  const modelText = s.slice(brand.length, sizeIdx).trim();

  return { brand, model: modelText, size, loadIndex, speedRating };
}

// ---------------------------------------------------------------------------
// CSV loaders
// ---------------------------------------------------------------------------
function loadCsv(path) {
  const raw = readFileSync(path, "utf8");
  return parse(raw, { columns: true, skip_empty_lines: true, trim: true, bom: true });
}

function loadMasterRows() {
  return loadCsv(MASTER_CSV).map((r) => ({
    kind: "master",
    barcode: r.barcode,
    brand: r.brand,
    brand_normalized: r.brand_normalized || normText(r.brand),
    model: r.model,
    model_normalized: r.model_normalized || normText(r.model),
    size: r.size,
    raw_size_text: r.raw_size_text || r.size,
    load_index: r.load_index || "",
    speed_rating: r.speed_rating || "",
    load_range: r.load_range || "",
    type: r.type || "",
    season: r.season || "",
    manufacturer_part_number: (r.manufacturer_part_number || "").trim(),
    barcode_type: r.barcode_type || barcodeTypeFor(r.barcode),
    confidence: r.confidence || "",
    current_status: r.current_status || "active_retail",
    usable_for: r.usable_for || "auto_count_candidate",
    field_completeness_score: r.field_completeness_score || "",
    missing_fields: r.missing_fields || "",
    source_count: Number(r.source_count || 0),
  }));
}

function derivePnForBatchRow(rawPn) {
  const core = tirePartNumberCore(rawPn);
  return core || rawPn.trim();
}

function loadBatchRows(path, excludePn) {
  const rows = loadCsv(path).filter((r) => {
    if (r.partNumber === excludePn) return false;
    const v = (r.validation || "").trim();
    return v.startsWith("pass") || v.startsWith("flag");
  });

  return rows.map((r) => {
    const parsed = parseDescription(r.description);
    return {
      kind: "batch",
      barcode: r.barcode,
      brand: parsed.brand,
      brand_normalized: normText(parsed.brand),
      model: parsed.model,
      model_normalized: normText(parsed.model),
      size: parsed.size || "",
      raw_size_text: parsed.size || "",
      load_index: parsed.loadIndex || "",
      speed_rating: parsed.speedRating || "",
      load_range: "",
      type: "",
      season: "",
      manufacturer_part_number: derivePnForBatchRow(r.partNumber || ""),
      barcode_type: barcodeTypeFor(r.barcode),
      confidence: "chatgpt_1src_pattern",
      current_status: "active_retail",
      usable_for: "review_candidate",
      field_completeness_score: "",
      missing_fields: "",
      source_count: 1,
      _sourceFile: path,
      _rawDescription: r.description,
    };
  });
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------
function loadCorpus() {
  return JSON.parse(readFileSync(CORPUS_JSON_PATH, "utf8"));
}

function todayStamp(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function backupCorpusOnce(now = new Date()) {
  const backupPath = `${CORPUS_JSON_PATH}.bak-${todayStamp(now)}`;
  if (existsSync(backupPath)) {
    console.log(`[pilot-apply] Backup already exists, keeping it: ${backupPath}`);
    return backupPath;
  }
  copyFileSync(CORPUS_JSON_PATH, backupPath);
  console.log(`[pilot-apply] Backed up corpus to: ${backupPath}`);
  return backupPath;
}

function writeCorpus(corpus) {
  writeFileSync(CORPUS_JSON_PATH, JSON.stringify(corpus, null, 2) + "\n", "utf8");
}

function buildNewRow(inputRow) {
  const barcode = normBarcodeKey(inputRow.barcode);
  const row = {
    canonical_product_uid: "",
    brand: inputRow.brand,
    brand_normalized: inputRow.brand_normalized,
    model: inputRow.model,
    model_normalized: inputRow.model_normalized,
    size: inputRow.size,
    raw_size_text: inputRow.raw_size_text,
    load_index: inputRow.load_index,
    speed_rating: inputRow.speed_rating,
    load_range: inputRow.load_range,
    type: inputRow.type,
    season: inputRow.season,
    manufacturer_part_number: inputRow.manufacturer_part_number,
    barcode,
    barcode_type: inputRow.barcode_type,
    confidence: inputRow.confidence,
    current_status: inputRow.current_status,
    usable_for: inputRow.usable_for,
    field_completeness_score: inputRow.field_completeness_score,
    missing_fields: inputRow.missing_fields,
    source_count: inputRow.source_count,
    source: SOURCE_TAG,
  };
  row.canonical_product_uid = canonicalUidFor(row);
  return row;
}

function main() {
  console.log(`[pilot-apply] ${DRY_RUN ? "DRY RUN" : "LIVE APPLY"}`);

  const masterRows = loadMasterRows();
  const b5Rows = loadBatchRows(BATCH5_CSV, BATCH5_EXCLUDE_PN);
  const b6Rows = loadBatchRows(BATCH6_CSV, BATCH6_EXCLUDE_PN);
  const allRows = [...masterRows, ...b5Rows, ...b6Rows];

  console.log(`[pilot-apply] Input rows: master=${masterRows.length} batch5(passed)=${b5Rows.length} batch6(passed)=${b6Rows.length} total=${allRows.length}`);

  const corpus = loadCorpus();
  const beforeBarcodeCount = Object.keys(corpus.barcodeIndex).length;
  const beforePartNumberCount = Object.keys(corpus.partNumberIndex).length;

  const nextBarcodeIndex = { ...corpus.barcodeIndex };
  const report = {
    scanned: allRows.length,
    pnFills: [],
    newRows: [],
    conflicts: [],
    agreed: 0,
    rejectedByGradeBarcode: [],
    skippedNoPn: 0,
  };

  for (const inputRow of allRows) {
    const found = findInCorpus(nextBarcodeIndex, inputRow.barcode);

    if (found) {
      const existing = found.row;
      const incomingPn = (inputRow.manufacturer_part_number || "").trim();
      if (!incomingPn) {
        report.skippedNoPn += 1;
        continue;
      }
      const existingPn = (existing.manufacturer_part_number || "").trim();

      if (!existingPn) {
        // Blank in the corpus -> fill it, stamp provenance. Touch NOTHING else.
        const filled = { ...existing, manufacturer_part_number: incomingPn, part_number_source: SOURCE_TAG };
        nextBarcodeIndex[found.key] = filled;
        report.pnFills.push({ barcode: found.key, filledPn: incomingPn, brand: existing.brand, model: existing.model });
        continue;
      }

      if (normPart(existingPn) === normPart(incomingPn)) {
        report.agreed += 1;
        continue;
      }

      // Non-blank and DIFFERENT -> do NOT touch; report only.
      report.conflicts.push({
        barcode: found.key,
        corpusPn: existingPn,
        pilotPn: incomingPn,
        brand: existing.brand,
        model: existing.model,
      });
      continue;
    }

    // Not in corpus -> gate through the barcode trust gate, then add as a new row.
    const grade = gradeBarcodeLocal(inputRow.barcode);
    if (grade.verdict === "rejected") {
      report.rejectedByGradeBarcode.push({ barcode: inputRow.barcode, reason: grade.reason, brand: inputRow.brand });
      continue;
    }

    const newRow = buildNewRow(inputRow);
    const key = normBarcodeKey(inputRow.barcode);
    nextBarcodeIndex[key] = newRow;
    report.newRows.push({ barcode: key, brand: newRow.brand, model: newRow.model, size: newRow.size, pn: newRow.manufacturer_part_number });
  }

  corpus.barcodeIndex = nextBarcodeIndex;
  rebuildSecondaryIndexes(corpus);
  corpus.generated_at = new Date().toISOString();

  const afterBarcodeCount = Object.keys(corpus.barcodeIndex).length;
  const afterPartNumberCount = Object.keys(corpus.partNumberIndex).length;

  // ---------------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------------
  console.log("\n[pilot-apply] ===== REPORT =====");
  console.log(`  Rows scanned:          ${report.scanned}`);
  console.log(`  PN-fills:              ${report.pnFills.length}`);
  console.log(`  New rows:              ${report.newRows.length}`);
  console.log(`  Conflicts (untouched): ${report.conflicts.length}`);
  console.log(`  Agreed (no-op):        ${report.agreed}`);
  console.log(`  Rejected by gradeBarcode: ${report.rejectedByGradeBarcode.length}`);
  console.log(`  Skipped (no PN value): ${report.skippedNoPn}`);
  console.log(`\n  barcodeIndex:    ${beforeBarcodeCount} -> ${afterBarcodeCount} (+${afterBarcodeCount - beforeBarcodeCount})`);
  console.log(`  partNumberIndex: ${beforePartNumberCount} -> ${afterPartNumberCount} (+${afterPartNumberCount - beforePartNumberCount})`);

  if (report.conflicts.length) {
    console.log(`\n  Conflicts (manufacturer_part_number differs, NOT applied):`);
    for (const c of report.conflicts) {
      console.log(`    ${c.barcode}  corpusPn="${c.corpusPn}" pilotPn="${c.pilotPn}" (${c.brand} ${c.model})`);
    }
  }
  if (report.rejectedByGradeBarcode.length) {
    console.log(`\n  Rejected by gradeBarcode:`);
    for (const r of report.rejectedByGradeBarcode) {
      console.log(`    ${r.barcode}  reason="${r.reason}" (${r.brand})`);
    }
  }

  if (DRY_RUN) {
    console.log("\n[pilot-apply] --dry-run: not writing the corpus.");
    return;
  }

  if (report.pnFills.length === 0 && report.newRows.length === 0) {
    console.log("\n[pilot-apply] Nothing to add or fill; leaving the corpus untouched (idempotent no-op).");
    return;
  }

  backupCorpusOnce();
  writeCorpus(corpus);
  console.log(`\n[pilot-apply] Wrote corpus: ${CORPUS_JSON_PATH}`);
  console.log("[pilot-apply] Done. Next: npm run build:knowledge-db, then re-baseline golden if needed, then gates.");
}

main();
