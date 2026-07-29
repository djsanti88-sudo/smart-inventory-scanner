#!/usr/bin/env node
// db-blank-filler glue script: apply_pn_picks.
//
// Reads a human-completed PN_CONFLICT_PICK_SHEET.csv (columns: part_number_key, old_uid, candidate,
// brand, model, size, load_speed, barcode, "PICK (mark X)") and, for every part_number_key where
// EXACTLY ONE row is marked with an "X" in the PICK column, moves that key from
// tire_part_numbers_quarantine into the active tire_part_numbers table, pointed at the picked
// candidate's canonical_product_uid. Writes an audit row (stage2_enrichment_audit,
// action='owner_pick_conflict_resolution', trust_color='green') and a provenance row
// (source_name='owner_decision') for each applied pick.
//
// Rules (owner order, 2026-07-28):
//   - part_number_key with ZERO X marks: skip, warn (nothing to apply, still ambiguous).
//   - part_number_key with TWO OR MORE X marks: skip, warn (ambiguous pick, human must fix the sheet).
//   - Only rows with exactly one X are applied.
//   - Idempotent: re-running with the same sheet against an already-applied DB is a safe no-op (the
//     key is no longer in quarantine, so it is skipped with an "already applied" note, not re-applied
//     or duplicated).
//   - Never touches rows for keys not present in tire_part_numbers_quarantine (already resolved by
//     another path, or never quarantined) - reported, not silently ignored.
//   - Never writes to live Turso; operates on the local working DB path given via --db.
//
// Usage:
//   node .claude/skills/db-blank-filler/scripts/apply_pn_picks.mjs --db <path> --csv <path> [--dry-run]
//
// Exit codes: 0 success (including a run with only warnings), 1 fatal (bad args, missing DB/CSV,
// missing required tables).

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const require = createRequire(path.join(REPO_ROOT, "package.json"));

function argVal(argv, name, fallback = null) {
  const i = argv.indexOf(name);
  const next = i !== -1 ? argv[i + 1] : undefined;
  if (next && !next.startsWith("--")) return next;
  return fallback;
}
function hasFlag(argv, name) {
  return argv.includes(name);
}

// --- Minimal, dependency-free CSV parser (handles quoted fields with embedded commas/quotes). ---
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      pushField();
    } else if (c === "\n") {
      pushRow();
    } else if (c === "\r") {
      // swallow; \r\n handled via the following \n
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) pushRow();
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

/**
 * Parse the pick sheet into per-key groups, with each row carrying its X-mark status.
 * Returns { header, rowsByKey: Map<key, Array<{...fields, picked: boolean}>> }
 */
export function loadPickSheet(csvText) {
  const rows = parseCsv(csvText);
  if (rows.length === 0) return { header: [], rowsByKey: new Map() };
  const header = rows[0].map((h) => h.trim());
  const idx = {
    part_number_key: header.indexOf("part_number_key"),
    old_uid: header.indexOf("old_uid"),
    candidate: header.indexOf("candidate"),
    brand: header.indexOf("brand"),
    model: header.indexOf("model"),
    size: header.indexOf("size"),
    load_speed: header.indexOf("load_speed"),
    barcode: header.indexOf("barcode"),
    pick: header.findIndex((h) => h.toUpperCase().startsWith("PICK")),
  };
  for (const [name, i] of Object.entries(idx)) {
    if (i === -1) throw new Error(`apply_pn_picks: pick sheet missing required column "${name}"`);
  }
  const rowsByKey = new Map();
  for (let r = 1; r < rows.length; r++) {
    const cols = rows[r];
    if (cols.every((c) => c.trim() === "")) continue; // blank line
    const key = (cols[idx.part_number_key] ?? "").trim();
    if (!key) continue;
    const entry = {
      part_number_key: key,
      old_uid: (cols[idx.old_uid] ?? "").trim(),
      candidate: (cols[idx.candidate] ?? "").trim(),
      brand: (cols[idx.brand] ?? "").trim(),
      model: (cols[idx.model] ?? "").trim(),
      size: (cols[idx.size] ?? "").trim(),
      load_speed: (cols[idx.load_speed] ?? "").trim(),
      barcode: (cols[idx.barcode] ?? "").trim(),
      picked: (cols[idx.pick] ?? "").trim().toUpperCase() === "X",
    };
    if (!rowsByKey.has(key)) rowsByKey.set(key, []);
    rowsByKey.get(key).push(entry);
  }
  return { header, rowsByKey };
}

/**
 * Validate each key's pick group: exactly one X required to apply. Returns a plan:
 *   { applicable: [{key, candidate}], skippedZero: [key], skippedMultiple: [key] }
 */
export function planPicks(rowsByKey) {
  const applicable = [];
  const skippedZero = [];
  const skippedMultiple = [];
  for (const [key, rows] of rowsByKey) {
    const picked = rows.filter((r) => r.picked);
    if (picked.length === 0) {
      skippedZero.push(key);
    } else if (picked.length > 1) {
      skippedMultiple.push(key);
    } else {
      applicable.push({ key, candidate: picked[0].candidate, row: picked[0] });
    }
  }
  return { applicable, skippedZero, skippedMultiple };
}

/**
 * Apply the resolved picks against an open better-sqlite3 Database handle. Idempotent: a key no
 * longer present in tire_part_numbers_quarantine is treated as already-applied (or never-quarantined)
 * and skipped with a note, never re-applied or duplicated.
 *
 * Returns a summary: { applied: [...], alreadyApplied: [...], notQuarantined: [...] }
 */
export function applyPicks(db, applicable, { dryRun = false, nowIso = new Date().toISOString() } = {}) {
  const applied = [];
  const alreadyApplied = [];
  const notQuarantined = [];

  const getQuarantineRow = db.prepare(
    `SELECT * FROM tire_part_numbers_quarantine WHERE normalized_part_number = ?`
  );
  const getActiveRow = db.prepare(
    `SELECT * FROM tire_part_numbers WHERE normalized_part_number = ?`
  );
  const deleteQuarantineRow = db.prepare(
    `DELETE FROM tire_part_numbers_quarantine WHERE normalized_part_number = ?`
  );
  const insertActiveRow = db.prepare(
    `INSERT OR REPLACE INTO tire_part_numbers (normalized_part_number, canonical_product_uid) VALUES (?, ?)`
  );
  const insertAudit = db.prepare(
    `INSERT INTO stage2_enrichment_audit
       (action, trust_color, confidence_score, barcode, canonical_product_id, part_number, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertProvenance = db.prepare(
    `INSERT OR IGNORE INTO provenance
       (product_id, barcode, source_name, source_ref, sheet, row, batch_id, imported_at, evidence_level, license_note, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (const { key, candidate, row } of applicable) {
    const quarantineRow = getQuarantineRow.get(key);
    if (!quarantineRow) {
      const activeRow = getActiveRow.get(key);
      if (activeRow && activeRow.canonical_product_uid === candidate) {
        alreadyApplied.push({ key, candidate });
      } else {
        notQuarantined.push({ key, candidate });
      }
      continue;
    }
    if (dryRun) {
      applied.push({ key, candidate, dryRun: true });
      continue;
    }
    const txn = db.transaction(() => {
      deleteQuarantineRow.run(key);
      insertActiveRow.run(key, candidate);
      insertAudit.run(
        "owner_pick_conflict_resolution",
        "green",
        100,
        row.barcode || null,
        candidate,
        key,
        `Owner-picked conflict resolution: part_number_key ${key} moved from quarantine to active, pointed at ${candidate} (was quarantined under old_uid ${row.old_uid || "unknown"}). Source: PN_CONFLICT_PICK_SHEET.csv.`,
        nowIso
      );
      insertProvenance.run(
        candidate,
        row.barcode || "",
        "owner_decision",
        key,
        "PN_CONFLICT_PICK_SHEET",
        key,
        "owner_pick_conflict_resolution",
        nowIso,
        "owner_verified",
        "",
        ""
      );
    });
    txn();
    applied.push({ key, candidate });
  }

  return { applied, alreadyApplied, notQuarantined };
}

async function main() {
  const argv = process.argv.slice(2);
  const dbPath = argVal(argv, "--db");
  const csvPath = argVal(argv, "--csv");
  const dryRun = hasFlag(argv, "--dry-run");

  if (!dbPath) {
    console.error("apply_pn_picks: --db <path> is REQUIRED (never defaults to the packaged deliverable).");
    process.exit(1);
  }
  if (!csvPath) {
    console.error("apply_pn_picks: --csv <path> is REQUIRED (defaults to none; pass the pick sheet explicitly).");
    process.exit(1);
  }
  if (!existsSync(dbPath)) {
    console.error(`apply_pn_picks: working DB not found at ${dbPath}`);
    process.exit(1);
  }
  if (!existsSync(csvPath)) {
    console.error(`apply_pn_picks: pick sheet CSV not found at ${csvPath}`);
    process.exit(1);
  }

  const Database = require("better-sqlite3");
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 30000");

  const requiredTables = ["tire_part_numbers", "tire_part_numbers_quarantine", "stage2_enrichment_audit", "provenance"];
  const existingTables = new Set(
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => r.name)
  );
  const missing = requiredTables.filter((t) => !existingTables.has(t));
  if (missing.length > 0) {
    console.error(`apply_pn_picks: DB missing required table(s): ${missing.join(", ")}`);
    db.close();
    process.exit(1);
  }

  const csvText = readFileSync(csvPath, "utf8");
  const { rowsByKey } = loadPickSheet(csvText);
  const plan = planPicks(rowsByKey);

  for (const key of plan.skippedZero) {
    console.warn(`WARN: part_number_key ${key} has ZERO picks marked - skipped (still ambiguous).`);
  }
  for (const key of plan.skippedMultiple) {
    console.warn(`WARN: part_number_key ${key} has MULTIPLE picks marked - skipped (ambiguous, fix the sheet).`);
  }

  const result = applyPicks(db, plan.applicable, { dryRun });
  for (const { key, candidate } of result.notQuarantined) {
    console.warn(`WARN: part_number_key ${key} (pick ${candidate}) is not in tire_part_numbers_quarantine and does not match an already-applied active row - skipped.`);
  }

  db.close();

  const summary = {
    dbPath,
    csvPath,
    dryRun,
    totalKeysInSheet: rowsByKey.size,
    skippedZeroPicks: plan.skippedZero.length,
    skippedMultiplePicks: plan.skippedMultiple.length,
    applied: result.applied.length,
    alreadyApplied: result.alreadyApplied.length,
    notQuarantined: result.notQuarantined.length,
  };
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error("FATAL:", e);
    process.exit(1);
  });
}
