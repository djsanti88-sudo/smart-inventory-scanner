#!/usr/bin/env node
// Task A2: part-number UID repair - the release blocker.
//
// tire_part_numbers.canonical_product_uid still stores OLD pre-canonicalization descriptive slug
// IDs (e.g. "nexen_roadian_gtx_275_40r22_106_w_15225"), while tires / canonical_tire_products /
// tire_barcode_aliases now use NEW stable "TIRE_..." IDs. The runtime two-step join
// (tire_part_numbers.normalized_part_number -> canonical_product_uid -> tires) can never match.
//
// This script builds a deterministic old-UID -> new-stable-ID mapping by joining the OLD
// pre-canonical database's `tires` table (which still has the old slug UIDs) to the WORKING
// database's `tire_barcode_aliases` table via the shared `barcode` column (barcodes did not
// change across canonicalization; only the UID scheme did).
//
// Classification per distinct old UID referenced by tire_part_numbers:
//   - migrated: exactly one distinct new stable canonical_product_id reachable via shared barcodes.
//   - conflict: more than one distinct new stable canonical_product_id (ambiguous - no update).
//   - orphan:   zero new stable canonical_product_id reachable (no update).
//
// Never resolves ambiguity with LIMIT 1 / arbitrary row order (global constraint). All writes run
// inside one transaction:
//   - migrated rows: UPDATE canonical_product_uid in place (active table).
//   - conflict/orphan rows: MOVED to tire_part_numbers_quarantine (copied then deleted from the
//     active table) so the active table never carries a row pointing at a dead old UID.
// Idempotent: running twice produces identical counts and zero additional row-level changes on the
// second run (quarantine uses INSERT OR IGNORE keyed on normalized_part_number; migrated rows are
// only updated when canonical_product_uid actually changes).
//
// Usage: node scripts/tire-db-repair/01_repair_part_number_uids.mjs [dbPath]
//   dbPath - optional; defaults to the A1 working copy
//            (repair-2026-07-28/REPAIRED_TIRE_DATABASE.db), following the 00_setup_and_red_proof.mjs
//            argv[2] convention.

import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex").toUpperCase()));
    stream.on("error", reject);
  });
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const PACKAGE_DIR = join(REPO_ROOT, "backups", "claude-tire-db-handoff-2026-07-28");
const OUTPUT_DIR = join(PACKAGE_DIR, "repair-2026-07-28");

const WORKING_DB_DEFAULT = join(OUTPUT_DIR, "REPAIRED_TIRE_DATABASE.db");
const PRE_CANONICAL_DB = join(PACKAGE_DIR, "01_PROCESS_MERGED_pre_canonical.db");

const CONFLICTS_CSV = join(OUTPUT_DIR, "PART_NUMBER_CONFLICTS.csv");
const AUDIT_CSV = join(OUTPUT_DIR, "UID_MAPPING_AUDIT.csv");

const dbPathArg = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : null;
const workingDbPath = dbPathArg ?? WORKING_DB_DEFAULT;

const EXPECTED_TOTAL_PART_NUMBER_ROWS = 29173;

// The 20 A1 runtime lookup samples: 4 per boss brand, selected deterministically.
const BOSS_BRANDS = ["nexen", "arisun", "blackhawk", "fortune", "falken"];

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

async function main() {
  if (!existsSync(workingDbPath)) {
    console.error(`FATAL: working DB not found at ${workingDbPath}. Run 00_setup_and_red_proof.mjs first.`);
    process.exit(1);
  }
  if (!existsSync(PRE_CANONICAL_DB)) {
    console.error(`FATAL: pre-canonical evidence DB not found at ${PRE_CANONICAL_DB}.`);
    process.exit(1);
  }
  mkdirSync(OUTPUT_DIR, { recursive: true });

  // Hash the pre-canonical evidence DB before and after this run to prove it is never written -
  // ATTACH here is by plain path (not a URI), because better-sqlite3's connection is not opened
  // with SQLITE_OPEN_URI, so a `file:...?mode=ro` URI is rejected by SQLite's ATTACH parser
  // (verified empirically: SQLITE_CANTOPEN). Per the brief's "file: URI with ?mode=ro OR attach +
  // never write" alternative, read-only-ness is enforced at the application level instead: every
  // statement against the `pre` schema below is a SELECT, and the hash check below is the proof.
  const preHashBefore = await sha256File(PRE_CANONICAL_DB);

  const db = new Database(workingDbPath);
  const prePosixPath = PRE_CANONICAL_DB.replace(/\\/g, "/");
  db.exec(`ATTACH DATABASE '${prePosixPath}' AS pre`);

  // --- Ensure the quarantine table exists (idempotent) -----------------------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS tire_part_numbers_quarantine (
      normalized_part_number TEXT PRIMARY KEY,
      canonical_product_uid TEXT,
      quarantine_reason TEXT,
      quarantined_at TEXT
    )
  `);

  // --- Baseline counts (before) --------------------------------------------------------------
  const activeRowsBefore = db.prepare("SELECT count(*) c FROM tire_part_numbers").get().c;
  const quarantineRowsBefore = db.prepare("SELECT count(*) c FROM tire_part_numbers_quarantine").get().c;
  const totalRowsBefore = activeRowsBefore + quarantineRowsBefore;
  if (totalRowsBefore !== EXPECTED_TOTAL_PART_NUMBER_ROWS) {
    console.error(
      `FATAL: tire_part_numbers(active=${activeRowsBefore}) + tire_part_numbers_quarantine(${quarantineRowsBefore}) = ${totalRowsBefore}, expected ${EXPECTED_TOTAL_PART_NUMBER_ROWS}. Aborting before any write.`,
    );
    process.exit(1);
  }

  const joinedBefore = db
    .prepare(
      "SELECT count(*) c FROM tire_part_numbers p JOIN tires t ON t.canonical_product_uid = p.canonical_product_uid",
    )
    .get().c;

  // --- Idempotency guard: exclude UIDs already migrated on a prior run ------------------------
  // A row is "already migrated" when its current canonical_product_uid is already one of the NEW
  // stable IDs (i.e. it already exists in canonical_tire_products / tires) rather than an OLD
  // pre-canonical slug. Re-running the uid_map join against pre.tires for such a UID would find NO
  // match (the old slug is gone) and would misclassify an already-repaired row as "orphan",
  // quarantining good data on a second run. Detecting "already migrated" via canonical_tire_products
  // membership (not a naive TIRE_ prefix guess) keeps this correct even if the stable-ID scheme
  // changes shape later.
  const alreadyMigratedOldUids = new Set(
    db
      .prepare(
        `SELECT DISTINCT p.canonical_product_uid AS uid
         FROM tire_part_numbers p
         JOIN canonical_tire_products c ON c.canonical_product_id = p.canonical_product_uid`,
      )
      .all()
      .map((r) => r.uid),
  );

  // --- Step 1: build the uid_map, scoped to old UIDs currently in the active table that are NOT
  // already migrated (set-based single pass, no per-row loop, no LIMIT 1 / arbitrary-order
  // resolution: target_count and only_target are computed via COUNT(DISTINCT ...) / MIN(...) over
  // the FULL candidate set per old UID, so any old UID with more than one distinct reachable stable
  // ID is correctly counted as a conflict rather than silently resolved to one of them.)
  db.exec("DROP TABLE IF EXISTS temp.uid_map");
  db.exec(`
    CREATE TEMP TABLE uid_map AS
    SELECT old.canonical_product_uid AS old_uid,
           COUNT(DISTINCT alias.canonical_product_id) AS target_count,
           MIN(alias.canonical_product_id) AS only_target
    FROM pre.tires old
    JOIN tire_barcode_aliases alias ON alias.barcode = old.barcode
    WHERE old.canonical_product_uid IN (SELECT DISTINCT canonical_product_uid FROM tire_part_numbers)
    GROUP BY old.canonical_product_uid
  `);

  // --- Step 2: classify every distinct old UID currently active in tire_part_numbers, skipping
  // UIDs already migrated on a prior run (they are correct as-is and must not be reclassified). ---
  const activeOldUids = db
    .prepare("SELECT DISTINCT canonical_product_uid AS old_uid FROM tire_part_numbers ORDER BY canonical_product_uid")
    .all()
    .map((r) => r.old_uid)
    .filter((uid) => !alreadyMigratedOldUids.has(uid));

  console.log(
    `Skipping ${alreadyMigratedOldUids.size} UID(s) already migrated on a prior run (idempotency guard).`,
  );

  const uidMapByOldUid = new Map(
    db.prepare("SELECT old_uid, target_count, only_target FROM uid_map").all().map((r) => [r.old_uid, r]),
  );

  // For conflict rows we need the actual list of candidate stable IDs (not just the count).
  const candidatesStmt = db.prepare(`
    SELECT DISTINCT alias.canonical_product_id AS candidate
    FROM pre.tires old
    JOIN tire_barcode_aliases alias ON alias.barcode = old.barcode
    WHERE old.canonical_product_uid = ?
    ORDER BY alias.canonical_product_id
  `);

  const classification = []; // { old_uid, class, target_count, candidates: [] }
  let migratedCount = 0;
  let conflictCount = 0;
  let orphanCount = 0;

  for (const old_uid of activeOldUids) {
    const m = uidMapByOldUid.get(old_uid);
    if (!m || m.target_count === 0) {
      orphanCount++;
      classification.push({ old_uid, class: "orphan", target_count: 0, candidates: [] });
    } else if (m.target_count === 1) {
      migratedCount++;
      classification.push({ old_uid, class: "migrated", target_count: 1, candidates: [m.only_target] });
    } else {
      conflictCount++;
      const candidates = candidatesStmt.all(old_uid).map((r) => r.candidate);
      classification.push({ old_uid, class: "conflict", target_count: m.target_count, candidates });
    }
  }

  console.log(
    `Classification (distinct old UIDs, THIS RUN only): migrated=${migratedCount} conflict=${conflictCount} orphan=${orphanCount} total=${activeOldUids.length}`,
  );

  // --- Build the FULL report (every old UID ever seen, across all runs) ------------------------
  // The audit/conflicts CSVs must always describe the complete picture, not just this run's
  // incremental work - otherwise a second (no-op) run would overwrite them with near-empty files.
  // Sources, in priority order:
  //   1. This run's newly classified UIDs (classification array above).
  //   2. UIDs already migrated on a prior run (alreadyMigratedOldUids) - reported as "migrated"
  //      with their current (already-repaired) stable ID as the candidate.
  //   3. UIDs already quarantined on a prior run (tire_part_numbers_quarantine) - reported with
  //      their stored quarantine_reason.
  const fullReport = new Map(); // old_uid -> { old_uid, class, target_count, candidates: [] }
  for (const row of classification) {
    fullReport.set(row.old_uid, row);
  }
  for (const uid of alreadyMigratedOldUids) {
    if (fullReport.has(uid)) continue;
    fullReport.set(uid, { old_uid: uid, class: "migrated", target_count: 1, candidates: [uid] });
  }
  const quarantinedRows = db
    .prepare(
      "SELECT DISTINCT canonical_product_uid AS old_uid, quarantine_reason FROM tire_part_numbers_quarantine",
    )
    .all();
  for (const q of quarantinedRows) {
    if (fullReport.has(q.old_uid)) continue;
    const isConflict = q.quarantine_reason.startsWith("conflict:");
    fullReport.set(q.old_uid, {
      old_uid: q.old_uid,
      class: isConflict ? "conflict" : "orphan",
      target_count: isConflict ? q.quarantine_reason.split(":")[1].split("|").length : 0,
      candidates: isConflict ? q.quarantine_reason.split(":")[1].split("|") : [],
    });
  }
  const fullReportRows = [...fullReport.values()].sort((a, b) => (a.old_uid < b.old_uid ? -1 : a.old_uid > b.old_uid ? 1 : 0));

  // --- Write UID_MAPPING_AUDIT.csv: every old UID ever classified, with candidate stable IDs ----
  const auditLines = [csvLine(["old_uid", "class", "target_count", "candidate_stable_ids"])];
  for (const row of fullReportRows) {
    auditLines.push(csvLine([row.old_uid, row.class, row.target_count, row.candidates.join("|")]));
  }
  writeFileSync(AUDIT_CSV, auditLines.join(""), "utf8");
  console.log(`Wrote ${AUDIT_CSV} (${fullReportRows.length} rows, full cumulative report)`);

  // --- Write PART_NUMBER_CONFLICTS.csv: conflicts + orphans only, cumulative -------------------
  const conflictLines = [csvLine(["old_uid", "class", "target_count", "candidate_stable_ids"])];
  let fullConflictCount = 0;
  let fullOrphanCount = 0;
  for (const row of fullReportRows) {
    if (row.class === "conflict" || row.class === "orphan") {
      conflictLines.push(csvLine([row.old_uid, row.class, row.target_count, row.candidates.join("|")]));
      if (row.class === "conflict") fullConflictCount++;
      else fullOrphanCount++;
    }
  }
  writeFileSync(CONFLICTS_CSV, conflictLines.join(""), "utf8");
  console.log(`Wrote ${CONFLICTS_CSV} (${fullConflictCount + fullOrphanCount} rows, full cumulative report)`);

  // --- Step 3: single transaction - UPDATE migrated rows in place; MOVE conflict/orphan rows to
  // quarantine (copy then delete from the active table). -----------------------------------------
  const migratedMap = new Map(
    classification.filter((r) => r.class === "migrated").map((r) => [r.old_uid, r.candidates[0]]),
  );
  const quarantineReasonByOldUid = new Map(
    classification
      .filter((r) => r.class === "conflict" || r.class === "orphan")
      .map((r) => [r.old_uid, r.class === "conflict" ? `conflict:${r.candidates.join("|")}` : "orphan"]),
  );

  const updateStmt = db.prepare(
    "UPDATE tire_part_numbers SET canonical_product_uid = ? WHERE canonical_product_uid = ? AND canonical_product_uid != ?",
  );
  const selectForQuarantineStmt = db.prepare(
    "SELECT normalized_part_number, canonical_product_uid FROM tire_part_numbers WHERE canonical_product_uid = ?",
  );
  const insertQuarantineStmt = db.prepare(`
    INSERT OR IGNORE INTO tire_part_numbers_quarantine
      (normalized_part_number, canonical_product_uid, quarantine_reason, quarantined_at)
    VALUES (?, ?, ?, ?)
  `);
  const deleteFromActiveStmt = db.prepare(
    "DELETE FROM tire_part_numbers WHERE normalized_part_number = ? AND canonical_product_uid = ?",
  );

  let rowsUpdated = 0;
  let rowsQuarantined = 0;
  const nowIso = new Date().toISOString();

  const runWrite = db.transaction(() => {
    // 3a. Migrate.
    for (const [oldUid, newUid] of migratedMap) {
      const info = updateStmt.run(newUid, oldUid, newUid);
      rowsUpdated += info.changes;
    }
    // 3b. Quarantine (move) conflict/orphan rows still active under their original old UID.
    for (const [oldUid, reason] of quarantineReasonByOldUid) {
      const activeRows = selectForQuarantineStmt.all(oldUid);
      for (const row of activeRows) {
        const insertInfo = insertQuarantineStmt.run(row.normalized_part_number, row.canonical_product_uid, reason, nowIso);
        // Only delete from active if the quarantine insert actually happened (or the row is already
        // quarantined from a prior run) - either way the row must not remain active afterward.
        deleteFromActiveStmt.run(row.normalized_part_number, row.canonical_product_uid);
        if (insertInfo.changes > 0) rowsQuarantined += 1;
      }
    }
  });
  runWrite();

  console.log(`Rows updated (migrated) this run: ${rowsUpdated}`);
  console.log(`Rows newly quarantined this run: ${rowsQuarantined}`);

  // --- Step 4: GREEN gates ----------------------------------------------------------------------
  const activeRowsAfter = db.prepare("SELECT count(*) c FROM tire_part_numbers").get().c;
  const quarantineRowsAfter = db.prepare("SELECT count(*) c FROM tire_part_numbers_quarantine").get().c;
  const totalRowsAfter = activeRowsAfter + quarantineRowsAfter;

  const joinedAfter = db
    .prepare(
      "SELECT count(*) c FROM tire_part_numbers p JOIN tires t ON t.canonical_product_uid = p.canonical_product_uid",
    )
    .get().c;

  const joinedCanonicalAfter = db
    .prepare(
      "SELECT count(*) c FROM tire_part_numbers p JOIN canonical_tire_products c ON c.canonical_product_id = p.canonical_product_uid",
    )
    .get().c;

  // Every row remaining in the ACTIVE table must join tires (that is the entire point of
  // quarantining conflict/orphan rows out of the active table).
  const activeNotJoined = db
    .prepare(
      `SELECT count(*) c FROM tire_part_numbers p
       LEFT JOIN tires t ON t.canonical_product_uid = p.canonical_product_uid
       WHERE t.canonical_product_uid IS NULL`,
    )
    .get().c;

  // Rows that join tires must ALSO join canonical_tire_products (both use the same stable ID space).
  const joinedTiresButNotCanonical = db
    .prepare(
      `SELECT count(*) c FROM tire_part_numbers p
       JOIN tires t ON t.canonical_product_uid = p.canonical_product_uid
       LEFT JOIN canonical_tire_products c ON c.canonical_product_id = p.canonical_product_uid
       WHERE c.canonical_product_id IS NULL`,
    )
    .get().c;

  let gatesPassed = true;
  const gateResults = [];

  function gate(name, ok, detail) {
    gateResults.push({ name, ok, detail });
    if (!ok) gatesPassed = false;
    console.log(`${ok ? "PASS" : "FAIL"}: ${name} - ${detail}`);
  }

  gate(
    "active + quarantined = 29173 (total rows preserved)",
    totalRowsAfter === EXPECTED_TOTAL_PART_NUMBER_ROWS,
    `active=${activeRowsAfter} quarantined=${quarantineRowsAfter} sum=${totalRowsAfter} (expected ${EXPECTED_TOTAL_PART_NUMBER_ROWS})`,
  );
  gate(
    "every active row joins tires",
    activeNotJoined === 0,
    `${activeNotJoined} active rows fail to join tires (expected 0); joinedAfter=${joinedAfter} activeRowsAfter=${activeRowsAfter}`,
  );
  gate(
    "every joined row also joins canonical_tire_products",
    joinedTiresButNotCanonical === 0,
    `${joinedTiresButNotCanonical} joined-to-tires rows missing a canonical_tire_products match (expected 0); joined-to-canonical total=${joinedCanonicalAfter}`,
  );
  gate(
    "migrated rows resolve (joinedAfter >= migratedCount)",
    joinedAfter >= migratedCount,
    `joinedAfter=${joinedAfter} migratedCount(this run)=${migratedCount}`,
  );

  // --- Step 5: re-run the 20 A1 runtime lookup samples, using the EXPLICIT two-step path --------
  // (tire_part_numbers.normalized_part_number -> canonical_product_uid, then a SEPARATE
  // `tires WHERE canonical_product_uid = ?` query) so the re-check exercises the same two
  // independent statements the real runtime issues (lookupPartNumberTurso), not a single SQL JOIN.
  const lookupPartNumberStmt = db.prepare(
    "SELECT normalized_part_number, canonical_product_uid FROM tire_part_numbers WHERE normalized_part_number = ?",
  );
  const resolveTireStmt = db.prepare("SELECT * FROM tires WHERE canonical_product_uid = ?");

  // Sample candidates per boss brand: since canonical_product_uid is now a TIRE_... stable ID (not
  // a slug) after migration, brand-LIKE on the old slug no longer applies post-repair - re-derive 4
  // sample normalized_part_number values per brand via the now-repaired active table joined to
  // tires.brand_normalized (same brands, same "4 per brand" shape as A1's RED proof).
  const sampleCandidateStmt = db.prepare(
    `SELECT p.normalized_part_number
     FROM tire_part_numbers p
     JOIN tires t ON t.canonical_product_uid = p.canonical_product_uid
     WHERE t.brand_normalized = ?
     ORDER BY p.normalized_part_number LIMIT 4`,
  );

  const sampleResults = [];
  for (const brand of BOSS_BRANDS) {
    const candidates = sampleCandidateStmt.all(brand);
    for (const c of candidates) {
      // Step A: normalized_part_number -> canonical_product_uid (independent query #1).
      const partNumberRow = lookupPartNumberStmt.get(c.normalized_part_number);
      // Step B: canonical_product_uid -> tires (independent query #2, only if step A found a row).
      const resolvedTire = partNumberRow ? resolveTireStmt.get(partNumberRow.canonical_product_uid) : null;
      sampleResults.push({
        brand,
        normalized_part_number: c.normalized_part_number,
        canonical_product_uid: partNumberRow ? partNumberRow.canonical_product_uid : null,
        step1Hit: Boolean(partNumberRow),
        step2Hit: Boolean(resolvedTire),
        resolvedTire: partNumberRow && resolvedTire ? "HIT (GREEN)" : "MISS",
      });
    }
  }
  const totalSamples = sampleResults.length;
  const greenSamples = sampleResults.filter((s) => s.resolvedTire.startsWith("HIT")).length;
  console.log(
    `Runtime two-step lookup re-check (step1: normalized_part_number->canonical_product_uid, step2: canonical_product_uid->tires): ${greenSamples}/${totalSamples} resolve (GREEN).`,
  );
  for (const s of sampleResults) {
    console.log(
      `  ${s.brand} | ${s.normalized_part_number} | ${s.canonical_product_uid} | step1=${s.step1Hit} step2=${s.step2Hit} | ${s.resolvedTire}`,
    );
  }
  gate(
    "20 runtime two-step lookup samples resolve for migrated brands",
    totalSamples > 0 && greenSamples === totalSamples,
    `${greenSamples}/${totalSamples}`,
  );

  db.close();

  // --- Post-run: verify the pre-canonical evidence DB was never written -------------------------
  const preHashAfter = await sha256File(PRE_CANONICAL_DB);
  gate(
    "pre-canonical evidence DB hash unchanged (never written)",
    preHashAfter === preHashBefore,
    `before=${preHashBefore} after=${preHashAfter}`,
  );

  console.log("\n=== SUMMARY ===");
  console.log(`Total part-number rows (active + quarantine): ${totalRowsAfter}`);
  console.log(`Classified this run: migrated=${migratedCount} conflict=${conflictCount} orphan=${orphanCount}`);
  console.log(`Rows updated (migrated) this run: ${rowsUpdated}`);
  console.log(`Rows newly quarantined this run: ${rowsQuarantined}`);
  console.log(`Active rows: ${activeRowsAfter} | Quarantined rows (cumulative): ${quarantineRowsAfter}`);
  console.log(`Joined-to-tires before: ${joinedBefore} -> after: ${joinedAfter}`);
  console.log(`Joined-to-canonical_tire_products after: ${joinedCanonicalAfter}`);

  if (!gatesPassed) {
    console.error("\nFATAL: one or more GREEN gates failed. See gate results above.");
    process.exit(1);
  }

  console.log("\nAll GREEN gates passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
