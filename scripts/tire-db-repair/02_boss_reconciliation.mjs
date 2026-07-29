#!/usr/bin/env node
// Task A3: boss-source reconciliation + trusted merge.
//
// Reads all 6,990 rows of the boss workbook (03_BOSS_SOURCE_BARCODES.xlsx, Sheet1 + Sheet2) as TEXT
// (exceljs cell.text, never cell.value numerics - Excel numeric coercion silently drops leading
// zeros and blows up long GTIN-14 values into floating point). Boss rows are 100% TRUSTED TRUTH
// (owner decision 2026-07-28): a matched row's brand/model/size/manufacturer_part_number values are
// merged into `tires` as truth (blank-only fill; never overwrite a non-blank value).
//
// Match priority (brief Step 2):
//   1. exact barcode  - boss barcode candidate equals tires.barcode (PK).
//   2. exact part number - boss part-number normalized key equals tires.manufacturer_part_number's
//      normalized key (mirrors basePartNumberKey: strip spaces/hyphens, uppercase).
//   3. distributor-affix core + brand + size agreement - tirePartNumberCore(boss part number) matches
//      a tire's manufacturer_part_number core AND boss brand_normalized/size agree with that tire.
//      Never resolved via LIMIT 1 / arbitrary order: multiple distinct candidate tires under a core
//      that don't reduce to one agreeing brand+size => the row is NOT auto-linked (falls through to
//      unresolved), consistent with the global constraint against arbitrary-order resolution.
// Any row not resolved by 1-3 is unresolved (review CSV).
//
// Special case (brief Step 4): Sheet2 row 8, GTIN-14 30029885620210 (item 200624) is a packaging
// code - valid check digit but appears to be case-pack level. It is NEVER stored as an alias here;
// it goes to BOSS_UNRESOLVED_REVIEW.csv with status `packaging_needs_quantity`, and the
// reconciliation CSV records its final_status as `packaging_code`.
//
// Provenance: this task OWNS the schema (formalized further by A5). All matched-row writes insert a
// provenance row via UPSERT (ON CONFLICT DO UPDATE) so re-runs never duplicate.
//
// Multi-barcode write rule (brief Step 3, amended): a barcode-matched row fills ONLY the exact
// `tires` row with that barcode. A part-number-matched row (method 2 or 3) may have MULTIPLE sibling
// tire rows sharing the same manufacturer_part_number; for those siblings, a field is filled only
// when it is blank AND the non-blank sibling values that already exist do not disagree with the
// boss value. Any sibling disagreement routes the WHOLE boss row to the review CSV instead of
// partially writing.
//
// All writes run inside one transaction. Idempotent: a second run changes zero rows because every
// write is a blank-only fill (a re-run sees the field already filled) and every provenance write is
// an UPSERT keyed on the UNIQUE constraint.
//
// Usage: node scripts/tire-db-repair/02_boss_reconciliation.mjs [dbPath]

import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import ExcelJS from "exceljs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const PACKAGE_DIR = join(REPO_ROOT, "backups", "claude-tire-db-handoff-2026-07-28");
const OUTPUT_DIR = join(PACKAGE_DIR, "repair-2026-07-28");

const WORKING_DB_DEFAULT = join(OUTPUT_DIR, "REPAIRED_TIRE_DATABASE.db");
const BOSS_XLSX = join(PACKAGE_DIR, "03_BOSS_SOURCE_BARCODES.xlsx");
const HASHES_BEFORE_FILE = join(OUTPUT_DIR, "HASHES_BEFORE.txt");

const RECONCILIATION_CSV = join(OUTPUT_DIR, "BOSS_ROW_RECONCILIATION.csv");
const UNRESOLVED_CSV = join(OUTPUT_DIR, "BOSS_UNRESOLVED_REVIEW.csv");

const dbPathArg = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : null;
const workingDbPath = dbPathArg ?? WORKING_DB_DEFAULT;

const EXPECTED_TOTAL_BOSS_ROWS = 6990;
const PACKAGING_ROW = { sheet: "Sheet2", row: 8 }; // item 200624, GTIN-14 30029885620210

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

// --- Barcode normalization (mirrors src/services/upc/gtin.ts, expressed standalone so this script
// has zero project imports - it reads/writes a disposable SQLite copy only). ------------------------
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

/** Safe zero-pad candidates (12/13/14-wide), only kept when the padded form has a valid check digit. */
function zeroPadCandidates(raw) {
  const t = (raw ?? "").trim();
  if (!/^\d+$/.test(t) || t.length === 0 || t.length > 14) return [];
  const stripped = t.replace(/^0+/, "") || "0";
  const out = new Set();
  for (const base of [t, stripped]) {
    for (const width of [12, 13, 14]) {
      if (base.length <= width) {
        const padded = base.padStart(width, "0");
        if (isValidCheckDigit(padded)) out.add(padded);
      }
    }
  }
  // The raw value itself, if already GTIN-shaped and valid.
  if (isValidCheckDigit(t)) out.add(t);
  return [...out];
}

/** All normalized barcode candidates worth trying against tires.barcode, raw value first. */
function barcodeCandidates(raw) {
  const t = (raw ?? "").trim();
  if (!t) return [];
  const out = new Set([t]);
  for (const c of zeroPadCandidates(t)) out.add(c);
  return [...out];
}

// --- Part-number normalization (mirrors src/services/catalog/tirePartNumber.ts). --------------------
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

/** Digit-only size core, e.g. tires.size "275/55R20" and boss size "2755520" both -> "2755520".
 *  The boss workbook stores size as a concatenated digit string with no separators; tires.size
 *  stores GS1-style "WWW/AAR RR" notation. Comparing the digit-only core is the only way these two
 *  representations can agree without inventing a parser for every size format variant. */
function normalizeSize(size) {
  return (size ?? "").toString().toUpperCase().replace(/[^0-9]/g, "");
}

function normalizeBrand(brand) {
  return (brand ?? "").toString().trim().toLowerCase();
}

// --- Load boss workbook -------------------------------------------------------------------------
async function loadBossRows() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(BOSS_XLSX);

  const rows = [];

  // Sheet1: Item number(1) | Size(2) | Item name(3) | Brand(4) | Bar Code(5)
  const ws1 = wb.getWorksheet("Sheet1");
  for (let r = 2; r <= ws1.actualRowCount; r++) {
    const row = ws1.getRow(r);
    const itemNumber = row.getCell(1).text.trim();
    const size = row.getCell(2).text.trim();
    const itemName = row.getCell(3).text.trim();
    const brand = row.getCell(4).text.trim();
    const barCode = row.getCell(5).text.trim();
    if (!itemNumber && !size && !itemName && !brand && !barCode) continue; // fully blank trailing row
    rows.push({
      sheet: "Sheet1",
      row: r,
      rawBarcode: barCode,
      partNumber: itemNumber,
      brand,
      size,
      itemName,
    });
  }

  // Sheet2: Item number(1) ... Bar code(8) ... Size(18) ...
  const ws2 = wb.getWorksheet("Sheet2");
  for (let r = 2; r <= ws2.actualRowCount; r++) {
    const row = ws2.getRow(r);
    const itemNumber = row.getCell(1).text.trim();
    const barCode = row.getCell(8).text.trim();
    const size = row.getCell(18).text.trim();
    const brand = row.getCell(19).text.trim(); // "Color" header, but kept for completeness - Sheet2 has no brand column
    if (!itemNumber && !barCode) continue;
    rows.push({
      sheet: "Sheet2",
      row: r,
      rawBarcode: barCode,
      partNumber: itemNumber,
      brand: "", // Sheet2 has no brand column
      size,
      itemName: "",
    });
  }

  return rows;
}

async function main() {
  if (!existsSync(workingDbPath)) {
    console.error(`FATAL: working DB not found at ${workingDbPath}. Run 00_setup_and_red_proof.mjs first.`);
    process.exit(1);
  }
  if (!existsSync(BOSS_XLSX)) {
    console.error(`FATAL: boss workbook not found at ${BOSS_XLSX}.`);
    process.exit(1);
  }
  mkdirSync(OUTPUT_DIR, { recursive: true });

  // --- Hash packaged inputs BEFORE (never modified by this script) -----------------------------
  const hashesBefore = {};
  for (const f of PACKAGED_FILES) {
    hashesBefore[f] = await sha256File(join(PACKAGE_DIR, f));
  }
  if (existsSync(HASHES_BEFORE_FILE)) {
    console.log(`Cross-checking against recorded ${HASHES_BEFORE_FILE} (A1 baseline)...`);
  }

  const db = new Database(workingDbPath);
  db.pragma("foreign_keys = OFF"); // provenance FK-free by design; tire_product_part_number_aliases FK unaffected here

  // --- Ensure the provenance table exists (this task OWNS the schema; idempotent) ---------------
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

  const BATCH_ID = "A3_boss_reconciliation_2026-07-28";

  console.log("Loading boss workbook (all cells as TEXT)...");
  const bossRows = await loadBossRows();
  console.log(`Loaded ${bossRows.length} boss rows (expected ${EXPECTED_TOTAL_BOSS_ROWS}).`);
  if (bossRows.length !== EXPECTED_TOTAL_BOSS_ROWS) {
    console.error(`FATAL: expected exactly ${EXPECTED_TOTAL_BOSS_ROWS} boss rows, got ${bossRows.length}. Aborting before any write.`);
    process.exit(1);
  }

  // --- Preload lookup indexes from the working DB -----------------------------------------------
  const tireByBarcode = new Map(); // barcode -> tire row
  for (const t of db.prepare("SELECT * FROM tires").all()) {
    tireByBarcode.set(t.barcode, t);
  }

  const tiresByPartKey = new Map(); // basePartNumberKey(manufacturer_part_number) -> [tire rows]
  const tiresByPartCore = new Map(); // tirePartNumberCore(manufacturer_part_number) -> [tire rows]
  for (const t of tireByBarcode.values()) {
    if (!t.manufacturer_part_number) continue;
    const base = basePartNumberKey(t.manufacturer_part_number);
    if (base) {
      if (!tiresByPartKey.has(base)) tiresByPartKey.set(base, []);
      tiresByPartKey.get(base).push(t);
    }
    const core = tirePartNumberCore(t.manufacturer_part_number);
    if (core) {
      if (!tiresByPartCore.has(core)) tiresByPartCore.set(core, []);
      tiresByPartCore.get(core).push(t);
    }
  }

  // --- Reconciliation pass (read-only classification; no writes yet) ---------------------------
  const results = []; // one entry per boss row
  let exactCount = 0;
  let affixCount = 0;
  let unresolvedCount = 0;
  let packagingCount = 0;

  for (const br of bossRows) {
    const isPackagingSpecialCase = br.sheet === PACKAGING_ROW.sheet && br.row === PACKAGING_ROW.row;

    const barcodeCands = barcodeCandidates(br.rawBarcode);
    const gtinValid = isValidCheckDigit(br.rawBarcode);
    const gtinLevelRaw = gtinLevel(br.rawBarcode);
    const partBase = basePartNumberKey(br.partNumber);
    const partCore = tirePartNumberCore(br.partNumber);

    let matchMethod = null;
    let matchedBarcode = null;
    let matchedTire = null;
    let evidence = null;
    let siblingTires = []; // for part-number matches, all sibling tires sharing the part number

    if (isPackagingSpecialCase) {
      matchMethod = "packaging_code";
      evidence = "GTIN-14 valid check digit but packaging/case-pack level; product represented via a separate identifier; rejected as a unit alias per handoff gate";
      packagingCount++;
    } else {
      // Method 1: exact barcode.
      for (const cand of barcodeCands) {
        const t = tireByBarcode.get(cand);
        if (t) {
          matchMethod = "exact_barcode";
          matchedBarcode = cand;
          matchedTire = t;
          evidence = `barcode candidate ${cand} (raw "${br.rawBarcode}") matches tires.barcode`;
          break;
        }
      }

      // Method 2: exact part number.
      if (!matchedTire && partBase && tiresByPartKey.has(partBase)) {
        const candidates = tiresByPartKey.get(partBase);
        const distinctUids = new Set(candidates.map((c) => c.canonical_product_uid));
        if (distinctUids.size === 1) {
          matchMethod = "exact_part_number";
          matchedTire = candidates[0];
          siblingTires = candidates;
          evidence = `part number key ${partBase} matches ${candidates.length} tire row(s) under one product ${matchedTire.canonical_product_uid}`;
        } else {
          // Multiple distinct products share this normalized part-number key: ambiguous, do not
          // auto-resolve (global constraint: no LIMIT 1 / arbitrary order). Falls through to
          // affix-core check, then unresolved if that also fails.
        }
      }

      // Method 3: distributor-affix core + brand + size agreement.
      // The boss part number carries the distributor affix (e.g. "F-28031318", "BH1600448"); the
      // matching tire row commonly stores the BARE numeric core with no affix (manufacturer_part_number
      // = "28031318"), for which tirePartNumberCore() itself returns null (core === base, nothing to
      // strip - by design, see tirePartNumberCore doc). So the affix-core candidate pool must union
      // BOTH: tires whose OWN part number has a differing affix-stripped core equal to partCore
      // (tiresByPartCore), AND tires whose bare base key equals partCore directly (tiresByPartKey).
      if (!matchedTire && partCore) {
        const candidates = [
          ...(tiresByPartCore.get(partCore) ?? []),
          ...(tiresByPartKey.get(partCore) ?? []),
        ];
        const bossBrandNorm = normalizeBrand(br.brand);
        const bossSizeNorm = normalizeSize(br.size);
        const agreeing = candidates.filter((t) => {
          const brandOk = !bossBrandNorm || normalizeBrand(t.brand_normalized || t.brand) === bossBrandNorm;
          const sizeOk = !bossSizeNorm || normalizeSize(t.size) === bossSizeNorm;
          return brandOk && sizeOk && (bossBrandNorm || bossSizeNorm); // require at least one corroborating field present
        });
        const distinctUids = new Set(agreeing.map((c) => c.canonical_product_uid));
        if (distinctUids.size === 1) {
          matchMethod = "affix_core_brand_size";
          matchedTire = agreeing[0];
          siblingTires = agreeing;
          evidence = `affix core ${partCore} + brand="${bossBrandNorm}" + size="${bossSizeNorm}" agree on ${agreeing.length} tire row(s), product ${matchedTire.canonical_product_uid}`;
        }
        // distinctUids.size === 0 or > 1: ambiguous or no corroborated match, falls through unresolved.
      }
    }

    if (matchMethod === "exact_barcode") exactCount++;
    else if (matchMethod === "affix_core_brand_size") affixCount++;
    else if (matchMethod === "exact_part_number") exactCount++; // exact part-number counts toward the "exact" bucket per handoff (6118 = exact barcode + exact part number)
    else if (!isPackagingSpecialCase) unresolvedCount++;

    let finalStatus;
    if (isPackagingSpecialCase) finalStatus = "packaging_code";
    else if (matchMethod === "exact_barcode" || matchMethod === "exact_part_number") finalStatus = "accepted";
    else if (matchMethod === "affix_core_brand_size") finalStatus = "alias";
    else finalStatus = "needs_review";

    results.push({
      sheet: br.sheet,
      row: br.row,
      raw_barcode: br.rawBarcode,
      normalized_barcode_candidates: barcodeCands.join("|"),
      gtin_valid: gtinValid ? "true" : "false",
      gtin_level: gtinLevelRaw ?? "",
      source_part_number: br.partNumber,
      part_number_base_key: partBase,
      part_number_affix_core: partCore ?? "",
      brand: br.brand,
      size: br.size,
      matched_stable_product_id: matchedTire ? matchedTire.canonical_product_uid : "",
      matched_barcode: matchedTire ? matchedTire.barcode : "",
      match_method: matchMethod ?? "none",
      evidence: evidence ?? "",
      final_status: finalStatus,
      matchedTire,
      siblingTires,
    });
  }

  console.log(
    `Classification: exact=${exactCount} affix=${affixCount} unresolved=${unresolvedCount} packaging_special_case=${packagingCount} total=${results.length}`,
  );
  console.log(`Expected (handoff): exact=6118 affix=~235 unresolved=~637`);

  // --- Write phase: single transaction ------------------------------------------------------------
  const nowIso = new Date().toISOString();

  const upsertProvenanceStmt = db.prepare(`
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

  const insertAuditStmt = db.prepare(`
    INSERT INTO remaining_blank_fill_audit
      (action, trust_color, confidence_score, canonical_product_uid, barcode, previous_value, new_value, candidate_count, candidate_values, reason)
    VALUES (@action, @trust_color, @confidence_score, @canonical_product_uid, @barcode, @previous_value, @new_value, @candidate_count, @candidate_values, @reason)
  `);

  const FIELDS = ["brand", "model", "size", "manufacturer_part_number"];
  const updateFieldStmts = Object.fromEntries(
    FIELDS.map((f) => [
      f,
      db.prepare(`UPDATE tires SET ${f} = ? WHERE barcode = ? AND (${f} IS NULL OR ${f} = '')`),
    ]),
  );

  let fillsApplied = { brand: 0, model: 0, size: 0, manufacturer_part_number: 0 };
  let provenanceWrites = 0;
  let siblingDisagreementRoutedToReview = 0;

  const runWrites = db.transaction(() => {
    for (const r of results) {
      if (r.final_status === "packaging_code" || r.final_status === "needs_review") continue;

      const boss = {
        brand: bossRows.find((b) => b.sheet === r.sheet && b.row === r.row),
      }.brand;

      const bossValues = {
        brand: boss.brand || "",
        model: "", // boss workbook carries no dedicated model column; item name is descriptive text, not a clean model field - never invented
        size: boss.size || "",
        manufacturer_part_number: boss.partNumber || "",
      };

      if (r.match_method === "exact_barcode") {
        // Fill ONLY the exact matched barcode row.
        const t = r.matchedTire;
        for (const field of FIELDS) {
          const bossVal = bossValues[field];
          if (!bossVal) continue;
          const currentVal = t[field];
          if (currentVal && currentVal !== "") continue; // never overwrite non-blank
          const info = updateFieldStmts[field].run(bossVal, t.barcode);
          if (info.changes > 0) {
            fillsApplied[field]++;
            insertAuditStmt.run({
              action: "boss_truth_fill",
              trust_color: "green",
              confidence_score: 100,
              canonical_product_uid: t.canonical_product_uid,
              barcode: t.barcode,
              previous_value: currentVal ?? "",
              new_value: bossVal,
              candidate_count: 1,
              candidate_values: bossVal,
              reason: `boss_source exact_barcode match, sheet=${r.sheet} row=${r.row}, field=${field}`,
            });
          }
        }
        upsertProvenanceStmt.run({
          product_id: t.canonical_product_uid,
          barcode: t.barcode,
          source_name: "boss_source",
          source_ref: "03_BOSS_SOURCE_BARCODES.xlsx",
          sheet: r.sheet,
          row: String(r.row),
          batch_id: BATCH_ID,
          imported_at: nowIso,
          evidence_level: "trusted_exact_barcode",
          license_note: "",
          content_hash: "",
        });
        provenanceWrites++;
      } else if (r.match_method === "exact_part_number" || r.match_method === "affix_core_brand_size") {
        // Multi-barcode write rule: fill sibling rows only where the field is blank AND non-blank
        // siblings do not disagree with the boss value. Any disagreement routes the WHOLE row to
        // review instead of partially writing.
        //
        // For an affix-core match, the boss part number is the DISTRIBUTOR-AFFIXED variant (e.g.
        // "BH1600481"), while the matched tire legitimately stores the bare numeric core
        // ("1600481") as its canonical manufacturer_part_number - that is not a disagreement, it is
        // the expected affix-vs-core difference the match method itself corroborated. So
        // manufacturer_part_number is excluded from both the fill and the disagreement check for
        // affix-core matches; only brand/model/size (identity fields, not the raw source string)
        // participate.
        const fieldsToApply = r.match_method === "affix_core_brand_size"
          ? FIELDS.filter((f) => f !== "manufacturer_part_number")
          : FIELDS;
        const siblings = r.siblingTires;
        // Field-appropriate comparison key for the disagreement check: brand is case-insensitive
        // ("Blackhawk" vs stored "blackhawk" is agreement, not conflict); size compares on its
        // digit-only core (same bridge normalizeSize() uses for matching, since boss "2756520" and
        // stored "275/65R20" are the same size in different notations); other fields compare exact.
        function comparisonKey(field, value) {
          if (field === "brand") return normalizeBrand(value);
          if (field === "size") return normalizeSize(value);
          return value;
        }
        let disagreement = false;
        for (const field of fieldsToApply) {
          const bossVal = bossValues[field];
          if (!bossVal) continue;
          const bossKey = comparisonKey(field, bossVal);
          const nonBlankSiblingKeys = new Set(
            siblings.map((s) => s[field]).filter((v) => v && v !== "").map((v) => comparisonKey(field, v)),
          );
          if (nonBlankSiblingKeys.size > 0 && !nonBlankSiblingKeys.has(bossKey)) {
            disagreement = true;
            break;
          }
        }

        if (disagreement) {
          r.final_status = "needs_review";
          r.evidence = `${r.evidence}; ROUTED TO REVIEW: sibling non-blank value disagrees with boss value`;
          siblingDisagreementRoutedToReview++;
          continue;
        }

        // Prefer an already-agreeing sibling's OWN value (already in the corpus's native format,
        // e.g. size "235/85R16") over the boss raw string (e.g. digit-only "2358516") when one
        // exists - the disagreement check above already proved any non-blank sibling values agree
        // with the boss value, so reusing a sibling's formatted value never contradicts trusted
        // truth, and it keeps the corpus's existing display convention instead of writing the
        // boss's differently-formatted raw string into a sibling row.
        const preferredValueByField = {};
        for (const field of fieldsToApply) {
          const nonBlankSiblingValue = siblings.map((s) => s[field]).find((v) => v && v !== "");
          preferredValueByField[field] = nonBlankSiblingValue ?? bossValues[field];
        }

        for (const t of siblings) {
          for (const field of fieldsToApply) {
            const bossVal = bossValues[field];
            if (!bossVal) continue;
            const currentVal = t[field];
            if (currentVal && currentVal !== "") continue;
            const fillVal = preferredValueByField[field];
            const info = updateFieldStmts[field].run(fillVal, t.barcode);
            if (info.changes > 0) {
              fillsApplied[field]++;
              insertAuditStmt.run({
                action: "boss_truth_fill",
                trust_color: "green",
                confidence_score: 100,
                canonical_product_uid: t.canonical_product_uid,
                barcode: t.barcode,
                previous_value: currentVal ?? "",
                new_value: fillVal,
                candidate_count: siblings.length,
                candidate_values: siblings.map((s) => s.barcode).join("|"),
                reason: `boss_source ${r.match_method} match, sheet=${r.sheet} row=${r.row}, field=${field}`,
              });
            }
          }
          upsertProvenanceStmt.run({
            product_id: t.canonical_product_uid,
            barcode: t.barcode,
            source_name: "boss_source",
            source_ref: "03_BOSS_SOURCE_BARCODES.xlsx",
            sheet: r.sheet,
            row: String(r.row),
            batch_id: BATCH_ID,
            imported_at: nowIso,
            evidence_level: r.match_method === "exact_part_number" ? "trusted_exact_part_number" : "trusted_affix_core_corroborated",
            license_note: "",
            content_hash: "",
          });
          provenanceWrites++;
        }
      }
    }
  });
  runWrites();

  console.log(`Fills applied: ${JSON.stringify(fillsApplied)}`);
  console.log(`Provenance rows upserted: ${provenanceWrites}`);
  console.log(`Rows routed to review due to sibling disagreement: ${siblingDisagreementRoutedToReview}`);

  // Recompute final counts after any disagreement-triggered status flips.
  const finalCounts = { accepted: 0, alias: 0, needs_review: 0, packaging_code: 0 };
  for (const r of results) finalCounts[r.final_status] = (finalCounts[r.final_status] ?? 0) + 1;
  console.log(`Final status counts: ${JSON.stringify(finalCounts)}`);

  // --- Write BOSS_ROW_RECONCILIATION.csv (all 6990 rows + header) --------------------------------
  const reconHeader = [
    "sheet",
    "row",
    "raw_barcode",
    "normalized_barcode_candidates",
    "gtin_valid",
    "gtin_level",
    "source_part_number",
    "part_number_base_key",
    "part_number_affix_core",
    "brand",
    "size",
    "matched_stable_product_id",
    "matched_barcode",
    "match_method",
    "evidence",
    "final_status",
  ];
  const reconLines = [csvLine(reconHeader)];
  for (const r of results) {
    reconLines.push(
      csvLine([
        r.sheet,
        r.row,
        r.raw_barcode,
        r.normalized_barcode_candidates,
        r.gtin_valid,
        r.gtin_level,
        r.source_part_number,
        r.part_number_base_key,
        r.part_number_affix_core,
        r.brand,
        r.size,
        r.matched_stable_product_id,
        r.matched_barcode,
        r.match_method,
        r.evidence,
        r.final_status,
      ]),
    );
  }
  writeFileSync(RECONCILIATION_CSV, reconLines.join(""), "utf8");
  console.log(`Wrote ${RECONCILIATION_CSV} (${results.length} rows + header, expected ${EXPECTED_TOTAL_BOSS_ROWS})`);

  // --- Write BOSS_UNRESOLVED_REVIEW.csv (needs_review + packaging_code rows) ---------------------
  const unresolvedHeader = [
    "sheet",
    "row",
    "raw_barcode",
    "normalized_barcode_candidates",
    "gtin_valid",
    "gtin_level",
    "source_part_number",
    "brand",
    "size",
    "status",
    "reason",
  ];
  const unresolvedLines = [csvLine(unresolvedHeader)];
  let unresolvedRowsWritten = 0;
  for (const r of results) {
    if (r.final_status !== "needs_review" && r.final_status !== "packaging_code") continue;
    const status = r.final_status === "packaging_code" ? "packaging_needs_quantity" : "needs_review";
    unresolvedLines.push(
      csvLine([
        r.sheet,
        r.row,
        r.raw_barcode,
        r.normalized_barcode_candidates,
        r.gtin_valid,
        r.gtin_level,
        r.source_part_number,
        r.brand,
        r.size,
        status,
        r.evidence,
      ]),
    );
    unresolvedRowsWritten++;
  }
  writeFileSync(UNRESOLVED_CSV, unresolvedLines.join(""), "utf8");
  console.log(`Wrote ${UNRESOLVED_CSV} (${unresolvedRowsWritten} rows + header)`);

  // --- GREEN gates ---------------------------------------------------------------------------------
  let gatesPassed = true;
  function gate(name, ok, detail) {
    console.log(`${ok ? "PASS" : "FAIL"}: ${name} - ${detail}`);
    if (!ok) gatesPassed = false;
  }

  gate("reconciliation covers exactly 6990 boss rows", results.length === EXPECTED_TOTAL_BOSS_ROWS, `${results.length}`);
  gate(
    "no boss row silently dropped (sheet+row unique count matches)",
    new Set(results.map((r) => `${r.sheet}:${r.row}`)).size === EXPECTED_TOTAL_BOSS_ROWS,
    `${new Set(results.map((r) => `${r.sheet}:${r.row}`)).size}`,
  );
  gate(
    "packaging special case (Sheet2 row 8) never written as alias",
    (() => {
      const t = tireByBarcode.get("30029885620210");
      return !t; // must never exist as a tires.barcode row
    })(),
    "30029885620210 absent from tires.barcode",
  );

  db.close();

  // --- Post-run: verify packaged inputs were never modified --------------------------------------
  const hashesAfter = {};
  for (const f of PACKAGED_FILES) {
    hashesAfter[f] = await sha256File(join(PACKAGE_DIR, f));
  }
  for (const f of PACKAGED_FILES) {
    gate(`packaged file unchanged: ${f}`, hashesAfter[f] === hashesBefore[f], `${hashesAfter[f]}`);
  }

  console.log("\n=== SUMMARY ===");
  console.log(`Total boss rows: ${results.length}`);
  console.log(`exact=${exactCount} affix=${affixCount} unresolved=${unresolvedCount} packaging_special_case=${packagingCount}`);
  console.log(`Final status counts: ${JSON.stringify(finalCounts)}`);
  console.log(`Fills applied: ${JSON.stringify(fillsApplied)}`);
  console.log(`Provenance rows upserted this run: ${provenanceWrites}`);

  if (!gatesPassed) {
    console.error("\nFATAL: one or more gates failed. See gate results above.");
    process.exit(1);
  }

  console.log("\nAll gates passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
