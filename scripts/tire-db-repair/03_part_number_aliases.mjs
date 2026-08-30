#!/usr/bin/env node
// Task A4: part-number alias table (populate `tire_product_part_number_aliases`) + conflict CSV.
//
// Consumes: the repaired working DB from A2/A3 (backups/claude-tire-db-handoff-2026-07-28/
// repair-2026-07-28/REPAIRED_TIRE_DATABASE.db). Needs boss part numbers present (A3 output) and the
// UID-repaired tire_part_numbers table (A2 output).
//
// Produces: populated tire_product_part_number_aliases (EXISTING schema, unchanged - see Step 1
// note below), plus a section 2 appended to PART_NUMBER_CONFLICTS.csv reclassifying the 1095
// part_number_value_conflict green events + 39 part_number_uid_conflict events from
// process_merge_audit into: confirmed canonical / confirmed alias / safe affix alias / true conflict.
//
// Usage: node scripts/tire-db-repair/03_part_number_aliases.mjs [dbPath]
//   dbPath - optional; defaults to the working-copy path (00_setup_and_red_proof.mjs convention).
//   When a custom dbPath is given (fixture/test runs), PART_NUMBER_CONFLICTS.csv is written next to
//   THAT db and the packaged-input hash guard is skipped (it protects only the real working-DB flow;
//   a fixture run must never touch the real repair-2026-07-28 outputs).

import { createHash } from "node:crypto";
import { createReadStream, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const PACKAGE_DIR = join(REPO_ROOT, "backups", "claude-tire-db-handoff-2026-07-28");
const OUTPUT_DIR = join(PACKAGE_DIR, "repair-2026-07-28");

const WORKING_DB_DEFAULT = join(OUTPUT_DIR, "REPAIRED_TIRE_DATABASE.db");

// Same four packaged inputs A1/A2 verified. This script never touches them, but re-verifies their
// hashes are unchanged as a courtesy gate (global constraint: never modify the four packaged files).
const EXPECTED_HASHES = {
  "01_PROCESS_MERGED_pre_canonical.db": "ACE184054C8D23C128EA6642D751BA4EA1D76C4043720BA97EEE6C92C816C227",
  "02_ENRICHMENT_STAGE_2_rich.db": "1AF5153AF0933E1832B4CC92B0270850D99CE382ED242C534FC16E3855783725",
  "03_BOSS_SOURCE_BARCODES.xlsx": "AA0AA341B674AF3898E02B8BAA0F2F6587DF18110C677ACFC86845F731FA2404",
  "04_ENRICHMENT_AUDIT.xlsx": "6A07D18FF6B673C23699058C60E45F0B131E76E88E2ED3B97E1D317B7CCBF065",
};

const dbPathArg = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : null;
const workingDbPath = dbPathArg ?? WORKING_DB_DEFAULT;
// A custom dbPath (fixture/test run) writes its conflicts CSV NEXT TO that db, never into the real
// repair output folder. For the default working DB this resolves to the same path as before.
const isDefaultWorkingDb = dbPathArg === null;
const CONFLICTS_CSV = join(dirname(workingDbPath), "PART_NUMBER_CONFLICTS.csv");

function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex").toUpperCase()));
    stream.on("error", reject);
  });
}

// Mirrors src/products/catalog/tirePartNumber.ts exactly (this script has zero project imports by
// design - it only touches a disposable SQLite copy, same convention as 02_boss_reconciliation.mjs).
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
/** True when the two raw part-number strings reduce to the same key once a distributor affix
 *  (leading/trailing letters around a numeric core) is stripped from either or both sides. */
function isAffixRelated(a, b) {
  const baseA = basePartNumberKey(a);
  const baseB = basePartNumberKey(b);
  if (baseA === baseB) return true;
  const coreA = tirePartNumberCore(a) ?? baseA;
  const coreB = tirePartNumberCore(b) ?? baseB;
  return coreA === coreB;
}

function csvEscape(value) {
  const s = (value ?? "").toString();
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function main() {
  // --- Step 0: hash guard on the four packaged inputs (never modify them) -------------------
  if (isDefaultWorkingDb) {
    const hashResults = [];
    let anyMismatch = false;
    for (const [file, expected] of Object.entries(EXPECTED_HASHES)) {
      const filePath = join(PACKAGE_DIR, file);
      if (!existsSync(filePath)) {
        hashResults.push(`${file}: MISSING`);
        anyMismatch = true;
        continue;
      }
      const actual = await sha256File(filePath);
      const match = actual === expected;
      if (!match) anyMismatch = true;
      hashResults.push(`${file}: ${actual} ${match ? "OK" : "MISMATCH (expected " + expected + ")"}`);
    }
    console.log("Packaged-file hash guard:");
    for (const line of hashResults) console.log(" ", line);
    if (anyMismatch) {
      console.error("\nFATAL: packaged file hash mismatch. Aborting before any write.");
      process.exit(1);
    }
  } else {
    console.log("Custom dbPath given (fixture/test run): packaged-file hash guard skipped; CSV written next to the db.");
  }

  if (!existsSync(workingDbPath)) {
    console.error(`FATAL: working DB not found at ${workingDbPath}. Run 00/01/02 first.`);
    process.exit(1);
  }

  const db = new Database(workingDbPath);
  db.pragma("busy_timeout = 30000"); // another script may write to this DB concurrently tonight

  // --- Step 1: use the EXISTING tire_product_part_number_aliases schema exactly --------------
  // Columns (verified via PRAGMA table_info, adversarial schema inspection): canonical_product_id
  // TEXT NOT NULL, normalized_part_number TEXT NOT NULL, display_part_number TEXT NOT NULL, source
  // TEXT NOT NULL, trust_color TEXT NOT NULL, confidence_score INTEGER NOT NULL, is_unambiguous
  // INTEGER NOT NULL. PK is (canonical_product_id, normalized_part_number). No ALTER needed - every
  // value this script needs maps onto an existing column. Mapping used below:
  //   canonical_product_id  = the tires.canonical_product_uid (stable TIRE_... id) the alias resolves to
  //   normalized_part_number = normPartKey(variant) (tireKnowledgeIndex.ts normPartKey semantics)
  //   display_part_number    = the raw variant as seen in the source data (boss value or corpus's
  //                            own stored manufacturer_part_number, whichever is NOT already the
  //                            canonical corpus value for that product)
  //   source                 = evidence origin string (e.g. "boss_source:process_merge_audit",
  //                            "corpus:tires.manufacturer_part_number")
  //   trust_color            = 'green' for corroborated (barcode-tied) aliases
  //   confidence_score       = 100 (barcode-corroborated; matches process_merge_audit's own
  //                            confidence_score for these rows) or lower for weaker corroboration
  //   is_unambiguous         = 1 only when normalized_part_number maps to exactly one
  //                            canonical_product_id across the whole alias table; 0 otherwise

  const schema = db.prepare("PRAGMA table_info(tire_product_part_number_aliases)").all();
  const expectedCols = [
    "canonical_product_id",
    "normalized_part_number",
    "display_part_number",
    "source",
    "trust_color",
    "confidence_score",
    "is_unambiguous",
  ];
  const actualCols = schema.map((c) => c.name);
  for (const col of expectedCols) {
    if (!actualCols.includes(col)) {
      console.error(`FATAL: expected column '${col}' missing from tire_product_part_number_aliases. Actual columns: ${actualCols.join(", ")}`);
      db.close();
      process.exit(1);
    }
  }
  console.log("Schema guard OK: tire_product_part_number_aliases has all expected columns, no ALTER needed.");

  // --- Step 2 + 3: generate aliases from process_merge_audit + reclassify conflicts ----------
  //
  // process_merge_audit action buckets relevant here (verified via PRAGMA + sampling before writing
  // any SQL, per doctrine "inspect before act"):
  //   - part_number_value_conflict (1095 rows, all trust_color=green): boss supplied a DIFFERENT
  //     raw part-number string for a barcode/product `tires` already has a manufacturer_part_number
  //     for. previous_value = the value tires.manufacturer_part_number still holds (verified: 0/1095
  //     sampled had a missing tires row for that barcode; the corpus's own value was never
  //     overwritten - "canonical MPN never overwritten by a distributor variant" per the brief).
  //     new_value = the boss/distributor variant. Both values refer to the SAME product (same
  //     barcode -> same canonical_product_uid), so this is never an identity conflict by itself -
  //     it is an alias-generation opportunity. Reclassified into:
  //       * "confirmed canonical" - new_value normalizes to the exact same key as the corpus's own
  //         manufacturer_part_number (a formatting no-op, e.g. case/whitespace only). No alias row
  //         needed (would duplicate the canonical key); recorded in the CSV as informational.
  //       * "safe affix alias" - new_value and previous_value reduce to the same core once a
  //         distributor affix is stripped (tirePartNumberCore literal affix, e.g. BH1600974 vs
  //         1600974). Written to tire_product_part_number_aliases.
  //       * "confirmed alias" - same product (barcode-corroborated) but the two values do NOT match
  //         the strict affix-letters-around-digits shape (e.g. HH11 vs BH5546797, or a distributor's
  //         own distinct part-numbering scheme like F62130926 vs corpus 50000590). Still
  //         barcode-corroborated to exactly one product, so still safe to write as an alias, just a
  //         weaker "confirmed_alias" reason than the regex-provable affix case.
  //   - part_number_uid_conflict (39 rows) + its paired update_part_number_uid (39 rows, applied
  //     upstream by the boss-reconciliation/canonicalization pass): previous_value and new_value here
  //     are TWO DIFFERENT canonical_product_uid values for the SAME part_number key (verified via
  //     sampling: e.g. part_number "203850" resolved to both a nitto product and a delinte product
  //     across different source rows). This is a genuine identity ambiguity for that part_number -
  //     classified "true conflict" and NEVER written as an alias (ambiguous alias = no match, per
  //     the runtime wiring gate below). Recorded in PART_NUMBER_CONFLICTS.csv section 2 for human
  //     review, never resolved by picking one side.

  const valueConflictRows = db.prepare("SELECT * FROM process_merge_audit WHERE action = 'part_number_value_conflict'").all();
  const uidConflictRows = db.prepare("SELECT * FROM process_merge_audit WHERE action = 'part_number_uid_conflict'").all();

  const tiresByBarcodeStmt = db.prepare("SELECT canonical_product_uid, manufacturer_part_number FROM tires WHERE barcode = ?");

  // Section-2 CSV rows (built up as we classify).
  const section2Rows = [];
  // Candidate alias rows keyed by (canonical_product_id, normalized_part_number) to dedupe before
  // computing is_unambiguous (needs the full candidate set first).
  const aliasCandidates = new Map(); // key -> { canonical_product_id, normalized_part_number, display_part_number, source, trust_color, confidence_score }

  function addAliasCandidate(canonicalProductId, displayValue, source, confidenceScore) {
    const normalized = basePartNumberKey(displayValue);
    if (!normalized || !canonicalProductId) return;
    const key = `${canonicalProductId}${normalized}`;
    if (aliasCandidates.has(key)) return; // first source wins; still counted once
    aliasCandidates.set(key, {
      canonical_product_id: canonicalProductId,
      normalized_part_number: normalized,
      display_part_number: displayValue,
      source,
      trust_color: "green",
      confidence_score: confidenceScore,
    });
  }

  let countConfirmedCanonical = 0;
  let countSafeAffixAlias = 0;
  let countConfirmedAlias = 0;
  let countTrueConflictFromValue = 0; // defensive: should be 0 given the barcode-corroboration proof above

  for (const r of valueConflictRows) {
    const tireRow = tiresByBarcodeStmt.get(r.barcode);
    if (!tireRow || !tireRow.canonical_product_uid) {
      // No corroborating tires row for this barcode (should not happen per the pre-write proof, but
      // never guess): true conflict, goes to review, never written as an alias.
      countTrueConflictFromValue++;
      section2Rows.push({
        event_type: "part_number_value_conflict",
        part_number: r.part_number,
        barcode: r.barcode,
        previous_value: r.previous_value,
        new_value: r.new_value,
        canonical_product_uid: r.canonical_product_uid ?? "",
        classification: "true conflict",
        reason: "no corroborating tires row for this barcode",
      });
      continue;
    }

    const canonicalProductId = tireRow.canonical_product_uid;
    const canonicalMpnNormalized = basePartNumberKey(tireRow.manufacturer_part_number);
    const newValueNormalized = basePartNumberKey(r.new_value);

    if (newValueNormalized && newValueNormalized === canonicalMpnNormalized) {
      // Formatting no-op: the boss value normalizes to the exact same key the corpus already uses
      // as canonical. Nothing to alias (would duplicate the canonical key itself).
      countConfirmedCanonical++;
      section2Rows.push({
        event_type: "part_number_value_conflict",
        part_number: r.part_number,
        barcode: r.barcode,
        previous_value: r.previous_value,
        new_value: r.new_value,
        canonical_product_uid: canonicalProductId,
        classification: "confirmed canonical",
        reason: "new_value normalizes to the same key as the corpus's own manufacturer_part_number",
      });
      continue;
    }

    const affixRelated = isAffixRelated(r.previous_value, r.new_value);
    if (affixRelated) {
      countSafeAffixAlias++;
      addAliasCandidate(canonicalProductId, r.new_value, "boss_source:process_merge_audit:part_number_value_conflict", r.confidence_score ?? 100);
      section2Rows.push({
        event_type: "part_number_value_conflict",
        part_number: r.part_number,
        barcode: r.barcode,
        previous_value: r.previous_value,
        new_value: r.new_value,
        canonical_product_uid: canonicalProductId,
        classification: "safe affix alias",
        reason: "distributor affix strips to the same numeric core as the corpus's canonical part number",
      });
    } else {
      countConfirmedAlias++;
      addAliasCandidate(canonicalProductId, r.new_value, "boss_source:process_merge_audit:part_number_value_conflict", r.confidence_score ?? 100);
      section2Rows.push({
        event_type: "part_number_value_conflict",
        part_number: r.part_number,
        barcode: r.barcode,
        previous_value: r.previous_value,
        new_value: r.new_value,
        canonical_product_uid: canonicalProductId,
        classification: "confirmed alias",
        reason: "barcode-corroborated to exactly one product; not a simple affix but the boss variant is a genuine alias for the same tire",
      });
    }
  }

  // UID conflicts: one part_number pointed at two different products across source rows. These are
  // ALWAYS true conflicts for that part_number - never written as an alias, never resolved by
  // picking new_value over previous_value (that would silently hide the other product's legitimate
  // claim). Both candidate products are recorded so a human can adjudicate.
  let countTrueConflictFromUid = 0;
  for (const r of uidConflictRows) {
    countTrueConflictFromUid++;
    section2Rows.push({
      event_type: "part_number_uid_conflict",
      part_number: r.part_number,
      barcode: r.barcode,
      previous_value: r.previous_value,
      new_value: r.new_value,
      canonical_product_uid: `${r.previous_value}|${r.new_value}`,
      classification: "true conflict",
      reason: "same part_number resolved to two different canonical_product_uid values across source rows",
    });
  }

  // --- is_unambiguous: compute across the FULL candidate set (existing table rows + new candidates) ---
  const existingAliasRows = db.prepare("SELECT canonical_product_id, normalized_part_number FROM tire_product_part_number_aliases").all();
  const productsByNormalizedKey = new Map(); // normalized_part_number -> Set(canonical_product_id)
  function trackKey(normalizedKey, productId) {
    if (!productsByNormalizedKey.has(normalizedKey)) productsByNormalizedKey.set(normalizedKey, new Set());
    productsByNormalizedKey.get(normalizedKey).add(productId);
  }
  for (const row of existingAliasRows) trackKey(row.normalized_part_number, row.canonical_product_id);
  for (const candidate of aliasCandidates.values()) trackKey(candidate.normalized_part_number, candidate.canonical_product_id);
  // Also fold in tire_part_numbers (the authoritative canonical mapping) so a new alias that
  // collides with an EXISTING canonical part-number-to-different-product mapping is correctly
  // flagged ambiguous rather than falsely marked unambiguous.
  const canonicalPartNumberRows = db.prepare("SELECT normalized_part_number, canonical_product_uid FROM tire_part_numbers").all();
  for (const row of canonicalPartNumberRows) trackKey(row.normalized_part_number, row.canonical_product_uid);

  // --- Gate (Step 4, part 1): no duplicate alias_normalized -> different product WITHOUT a conflict
  // record. Any normalized key we are about to write that maps to >1 distinct canonical_product_id
  // is EXCLUDED from the write set and instead recorded as a true conflict in the CSV, never
  // guessed. ---
  const ambiguousKeys = new Set();
  for (const [key, ids] of productsByNormalizedKey.entries()) {
    if (ids.size > 1) ambiguousKeys.add(key);
  }

  const rowsToInsert = [];
  let countDemotedAmbiguous = 0;
  for (const candidate of aliasCandidates.values()) {
    if (ambiguousKeys.has(candidate.normalized_part_number)) {
      countDemotedAmbiguous++;
      section2Rows.push({
        event_type: "alias_candidate",
        part_number: candidate.display_part_number,
        barcode: "",
        previous_value: "",
        new_value: candidate.display_part_number,
        canonical_product_uid: candidate.canonical_product_id,
        classification: "true conflict",
        reason: `normalized key ${candidate.normalized_part_number} maps to more than one canonical product; demoted from alias to conflict (ambiguous alias = no match)`,
      });
      continue;
    }
    rowsToInsert.push({ ...candidate, is_unambiguous: 1 });
  }

  // --- Step 4: gate - every alias joins a live product -----------------------------------------
  const tireExistsStmt = db.prepare("SELECT 1 FROM tires WHERE canonical_product_uid = ? LIMIT 1");
  let countOrphanProduct = 0;
  const finalRowsToInsert = [];
  for (const row of rowsToInsert) {
    if (!tireExistsStmt.get(row.canonical_product_id)) {
      countOrphanProduct++;
      continue; // never write an alias to a dead product id
    }
    finalRowsToInsert.push(row);
  }

  // --- Write (single short transaction; another script may write to this DB concurrently tonight) ---
  const upsert = db.prepare(`
    INSERT INTO tire_product_part_number_aliases
      (canonical_product_id, normalized_part_number, display_part_number, source, trust_color, confidence_score, is_unambiguous)
    VALUES (@canonical_product_id, @normalized_part_number, @display_part_number, @source, @trust_color, @confidence_score, @is_unambiguous)
    ON CONFLICT(canonical_product_id, normalized_part_number) DO UPDATE SET
      display_part_number = excluded.display_part_number,
      source = excluded.source,
      trust_color = excluded.trust_color,
      confidence_score = excluded.confidence_score,
      is_unambiguous = excluded.is_unambiguous
  `);

  const runInsert = db.transaction((rows) => {
    for (const row of rows) upsert.run(row);
  });
  runInsert(finalRowsToInsert);

  // --- Gate (Step 4, part 2): re-verify from a fresh read after the write -----------------------
  const postCount = db.prepare("SELECT count(*) c FROM tire_product_part_number_aliases").get().c;
  const dupCheck = db
    .prepare(
      `SELECT normalized_part_number, count(DISTINCT canonical_product_id) c
       FROM tire_product_part_number_aliases GROUP BY normalized_part_number HAVING c > 1`,
    )
    .all();
  const orphanCheck = db
    .prepare(
      `SELECT a.canonical_product_id FROM tire_product_part_number_aliases a
       LEFT JOIN tires t ON t.canonical_product_uid = a.canonical_product_id
       WHERE t.canonical_product_uid IS NULL`,
    )
    .all();

  db.close();

  // --- Rewrite PART_NUMBER_CONFLICTS.csv section 2 (idempotent) ---------------------------------
  // Section 2 fully describes THIS run's cumulative reclassification (not incremental deltas),
  // same "cumulative, never clobbered by a no-op re-run" discipline A2 applied to its own CSVs.
  // A naive append would duplicate section 2's content on every re-run (self-caught during this
  // task's own idempotency check) - instead, any PRIOR section 2 (everything from the marker line
  // onward) is stripped from the existing file before the fresh section 2 is written, so section 1
  // (A2's UID conflict rows, owned by 01_repair_part_number_uids.mjs) is always preserved untouched
  // and section 2 never grows across runs.
  const SECTION2_MARKER = "# Section 2: part_number_value_conflict + part_number_uid_conflict reclassification (Task A4)";
  let section1Content = "";
  if (existsSync(CONFLICTS_CSV)) {
    const existing = readFileSync(CONFLICTS_CSV, "utf8");
    const markerIndex = existing.indexOf(SECTION2_MARKER);
    section1Content = markerIndex >= 0 ? existing.slice(0, markerIndex).replace(/\n+$/, "") : existing.replace(/\n+$/, "");
  }

  const section2Header = [SECTION2_MARKER, "event_type,part_number,barcode,previous_value,new_value,canonical_product_uid,classification,reason"].join("\n");
  const section2Body = section2Rows
    .map((r) =>
      [
        r.event_type,
        r.part_number,
        r.barcode,
        r.previous_value,
        r.new_value,
        r.canonical_product_uid,
        r.classification,
        r.reason,
      ]
        .map(csvEscape)
        .join(","),
    )
    .join("\n");

  writeFileSync(CONFLICTS_CSV, `${section1Content}\n\n${section2Header}\n${section2Body}\n`, "utf8");
  console.log(`\nWrote section 2 to ${CONFLICTS_CSV} (${section2Rows.length} rows, replacing any prior section 2).`);

  // --- Summary + gates -----------------------------------------------------------------------
  console.log("\n=== Classification summary (part_number_value_conflict, 1095 events) ===");
  console.log("confirmed canonical:", countConfirmedCanonical);
  console.log("safe affix alias:", countSafeAffixAlias);
  console.log("confirmed alias:", countConfirmedAlias);
  console.log("true conflict (no corroborating tires row):", countTrueConflictFromValue);
  console.log("\n=== Classification summary (part_number_uid_conflict, 39 events) ===");
  console.log("true conflict:", countTrueConflictFromUid);
  console.log("\n=== Alias write summary ===");
  console.log("candidate alias rows (deduped by product+key):", aliasCandidates.size);
  console.log("demoted to conflict (ambiguous across candidates+existing data):", countDemotedAmbiguous);
  console.log("skipped (no live product to join):", countOrphanProduct);
  console.log("rows written (insert or upsert-refresh):", finalRowsToInsert.length);
  console.log("tire_product_part_number_aliases row count after write:", postCount);

  let anyGateFail = false;
  if (dupCheck.length > 0) {
    anyGateFail = true;
    console.error("FAIL: duplicate normalized_part_number pointing at different products found post-write:", dupCheck);
  } else {
    console.log("PASS: no duplicate normalized_part_number -> different product without a conflict record.");
  }
  if (orphanCheck.length > 0) {
    anyGateFail = true;
    console.error("FAIL: alias rows exist whose canonical_product_id does not join a live tires row:", orphanCheck.length);
  } else {
    console.log("PASS: every alias row joins a live product.");
  }

  // Re-verify packaged hashes unchanged as a final courtesy check (default working-DB runs only).
  if (isDefaultWorkingDb) {
    let postHashMismatch = false;
    for (const [file, expected] of Object.entries(EXPECTED_HASHES)) {
      const actual = await sha256File(join(PACKAGE_DIR, file));
      if (actual !== expected) postHashMismatch = true;
    }
    if (postHashMismatch) {
      anyGateFail = true;
      console.error("FAIL: a packaged file's hash changed during this run.");
    } else {
      console.log("PASS: packaged files unchanged (hash re-verified).");
    }
  }

  if (anyGateFail) {
    console.error("\nOne or more gates FAILED.");
    process.exit(1);
  }
  console.log("\nAll gates passed.");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
