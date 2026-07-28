#!/usr/bin/env node
// LEAN TWIN MODEL (owner design, 2026-07-28): one row per tire, no duplicate twin rows. Each row
// carries BOTH barcode forms as columns: barcode_upc (12-digit UPC-A, PRIMARY/display code when it
// exists) and barcode_ean13 (13-digit form), derived deterministically from the row's own `barcode`
// PK. This REPLACES the earlier row-materialization twin approach (twin_complete.mjs), which the
// owner rejected because it doubled the tires table (82,673 -> 131,440 rows). The `barcode` PK
// column is never touched.
//
// Derivation (deriveTwinColumns, exported for unit tests):
//   13-digit starting with '0'  -> barcode_ean13 = itself; barcode_upc = itself with leading '0' dropped
//   12-digit                    -> barcode_upc = itself; barcode_ean13 = '0' + itself
//   13-digit NOT starting with '0' (e.g. 69x China codes) -> barcode_ean13 = itself; barcode_upc = NULL
//     (a UPC-A form does not exist for these; NEVER fabricate one)
//   8/14-digit or any non-12/13-digit or non-numeric shape -> both NULL (no valid GTIN mirror exists)
//
// ~2,793 rows in this DB already have BOTH a 12-digit row and its 0-prefixed 13-digit row present
// as SEPARATE rows (pre-existing twin pairs from the earlier row-materialization pass or prior
// ingestion). Each of those rows gets its OWN columns filled per the rule above (each row mirrors
// its own barcode). Deduplicating those pre-existing twin-pair ROWS is explicitly OUT OF SCOPE for
// this script.
//
// Idempotent: safe to re-run; ALTER TABLE guarded by a PRAGMA check; UPDATE re-derives the same
// values from `barcode` every time (no read-modify-write drift possible).
//
// Usage: node 11_twin_columns.mjs [dbPath] [--dry-run]

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const require = createRequire(path.join(REPO_ROOT, "package.json"));

/**
 * Pure derivation function: given a barcode string, returns { barcode_upc, barcode_ean13 }.
 * NEVER fabricates a UPC-A form for a 13-digit code that does not start with '0' (e.g. 69x codes).
 * Returns nulls for any shape that is not a clean 12- or 13-digit all-numeric GTIN.
 * @param {string} barcode
 * @returns {{ barcode_upc: string | null, barcode_ean13: string | null }}
 */
export function deriveTwinColumns(barcode) {
  if (typeof barcode !== "string" || !/^[0-9]+$/.test(barcode)) {
    return { barcode_upc: null, barcode_ean13: null };
  }
  if (barcode.length === 13) {
    if (barcode.startsWith("0")) {
      return { barcode_upc: barcode.slice(1), barcode_ean13: barcode };
    }
    // 69x-style (or any other non-zero-leading 13-digit) code: no fabricated UPC-A form.
    return { barcode_upc: null, barcode_ean13: barcode };
  }
  if (barcode.length === 12) {
    return { barcode_upc: barcode, barcode_ean13: "0" + barcode };
  }
  // 8/14-digit or any other length: no valid 12/13-digit mirror exists.
  return { barcode_upc: null, barcode_ean13: null };
}

// --- CLI entrypoint guard: only run the DB mutation when invoked directly, not on import --------
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runMain();
}

function runMain() {
  const Database = require("better-sqlite3");
  const dbPathArg = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : null;
  const DRY_RUN = process.argv.includes("--dry-run");
  const dbPath =
    dbPathArg ??
    path.join(
      REPO_ROOT,
      "backups/claude-tire-db-handoff-2026-07-28/repair-2026-07-28/REPAIRED_TIRE_DATABASE.db"
    );

  const db = new Database(dbPath);
  db.pragma("busy_timeout = 30000");

  const REQUIRED_TABLES = ["tires", "remaining_blank_fill_audit"];
  const existingTables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
  );
  const missingTables = REQUIRED_TABLES.filter((t) => !existingTables.has(t));
  if (missingTables.length > 0) {
    console.error(
      `11_twin_columns: ${dbPath} is missing required table(s): ${missingTables.join(", ")}.`
    );
    db.close();
    process.exit(1);
  }

  // --- idempotent additive columns (pragma check first) ------------------------------------------
  const tireCols = db.prepare("PRAGMA table_info(tires)").all().map((c) => c.name);
  if (!tireCols.includes("barcode_upc")) {
    db.prepare("ALTER TABLE tires ADD COLUMN barcode_upc TEXT").run();
  }
  if (!tireCols.includes("barcode_ean13")) {
    db.prepare("ALTER TABLE tires ADD COLUMN barcode_ean13 TEXT").run();
  }

  const rows = db.prepare("SELECT barcode FROM tires").all();

  let bothForms = 0;
  let upcOnly = 0; // upc present, ean derivable but... (not reachable: ean is always derivable when upc is) - see note below
  let eanOnlyNoUpcPossible = 0;
  let neither = 0;

  const updateStmt = db.prepare(
    "UPDATE tires SET barcode_upc = ?, barcode_ean13 = ? WHERE barcode = ?"
  );

  const tx = db.transaction(() => {
    for (const row of rows) {
      const { barcode_upc, barcode_ean13 } = deriveTwinColumns(row.barcode);
      if (!DRY_RUN) {
        updateStmt.run(barcode_upc, barcode_ean13, row.barcode);
      }
      if (barcode_upc && barcode_ean13) bothForms++;
      else if (barcode_ean13 && !barcode_upc) eanOnlyNoUpcPossible++;
      else if (barcode_upc && !barcode_ean13) upcOnly++; // structurally unreachable per derivation rules above
      else neither++;
    }
  });
  if (!DRY_RUN) {
    tx();
  } else {
    // still compute the counts without writing
    for (const row of rows) {
      const { barcode_upc, barcode_ean13 } = deriveTwinColumns(row.barcode);
      if (barcode_upc && barcode_ean13) bothForms++;
      else if (barcode_ean13 && !barcode_upc) eanOnlyNoUpcPossible++;
      else if (barcode_upc && !barcode_ean13) upcOnly++;
      else neither++;
    }
  }

  const summary = {
    dryRun: DRY_RUN,
    totalRows: rows.length,
    bothForms,
    upcOnly,
    eanOnlyNoUpcPossible,
    neither,
  };

  if (!DRY_RUN) {
    // One summary audit row per direction (NOT one row per tire - 82k rows would be noise).
    // Provenance is NOT needed: values are derived purely from the row's own barcode column.
    const insAudit = db.prepare(`
      INSERT INTO remaining_blank_fill_audit
        (action, trust_color, confidence_score, canonical_product_uid, barcode, previous_value,
         new_value, candidate_count, candidate_values, reason)
      VALUES (?, 'green', 100, NULL, NULL, '', ?, ?, ?, ?)
    `);
    const already = db
      .prepare("SELECT count(*) c FROM remaining_blank_fill_audit WHERE action = 'twin_columns_backfill'")
      .get().c;
    if (already === 0) {
      insAudit.run(
        "twin_columns_backfill",
        `bothForms=${bothForms}`,
        bothForms,
        "barcode_upc+barcode_ean13",
        "12-digit UPC-A row or leading-zero 13-digit EAN row: both columns derived and filled"
      );
      insAudit.run(
        "twin_columns_backfill",
        `eanOnlyNoUpcPossible=${eanOnlyNoUpcPossible}`,
        eanOnlyNoUpcPossible,
        "barcode_ean13 only",
        "13-digit code not starting with 0 (e.g. 69x China codes): no UPC-A form exists, never fabricated"
      );
      insAudit.run(
        "twin_columns_backfill",
        `neither=${neither}`,
        neither,
        "NULL/NULL",
        "8/14-digit or non-GTIN shape: no valid 12/13-digit mirror exists"
      );
    }
  }

  console.log(JSON.stringify(summary, null, 2));
  db.close();
}
