#!/usr/bin/env node
// Twin completion, BOTH directions, with primary-form designation.
//
// Generalizes scripts/tire-db-repair/08_upc_alias_pass.mjs (which only did UPC-A twins for
// leading-zero EAN-13). This script materializes twins in BOTH directions so every tire carries
// both barcode forms where they exist:
//
//   Direction A (UPC-A twin of leading-zero EAN-13): for every 13-digit alias starting with '0'
//     whose 12-digit UPC-A twin (drop the leading zero) is absent, add the UPC-A twin.
//   Direction B (EAN-13 twin of 12-digit UPC-A): for every 12-digit alias whose 0-prefixed
//     EAN-13 twin is absent, add the EAN-13 twin.
//
// A leading-zero EAN-13 and its 12-digit UPC-A form are the SAME GTIN (identical check digit),
// so the twin points at the SAME product. Deterministic, idempotent.
//
// TWIN POLICY (owner): 12-digit UPC-A is the PRIMARY barcode form. This script sets
// tire_barcode_aliases.is_primary_form = 1 on every 12-digit UPC-A alias and 0 on its EAN-13
// twin. The column is added if missing (additive, DEFAULT 0 - does not affect any validator gate,
// which only checks the alias<->tire relationship and row-count baselines).
//
// DB invariant enforced by scripts/tire-db-repair/05_validate.mjs: every alias row has a tires
// row with the same barcode (gate "no tire missing its barcode alias") AND every tires row has an
// alias (gate "no barcode alias missing its tire row"). So each new twin alias also gets a cloned
// tires row under the twin barcode (same product identity), exactly like 08_upc_alias_pass.mjs.
//
// Barcodes are TEXT always. No git, no live Turso, no network, no paid work.
//
// Usage: node twin_complete.mjs <dbPath> [--dry-run]

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const require = createRequire(path.join(REPO_ROOT, "package.json"));
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

// --- required-table guard: fail with a clear, honest message instead of a raw SQLite stack ----
const REQUIRED_TABLES = ["tires", "tire_barcode_aliases", "provenance", "remaining_blank_fill_audit"];
const existingTables = new Set(
  db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
);
const missingTables = REQUIRED_TABLES.filter((t) => !existingTables.has(t));
if (missingTables.length > 0) {
  console.error(
    `twin_complete: ${dbPath} is missing required table(s): ${missingTables.join(", ")}. ` +
      "This does not look like a tire-corpus working copy (offline copy or turso_snapshot.mjs output expected)."
  );
  db.close();
  process.exit(1);
}

// --- additive primary-form designation column (idempotent) -----------------------------------
const aliasCols = db.prepare("PRAGMA table_info(tire_barcode_aliases)").all().map((c) => c.name);
if (!aliasCols.includes("is_primary_form")) {
  db.prepare("ALTER TABLE tire_barcode_aliases ADD COLUMN is_primary_form INTEGER DEFAULT 0").run();
}

// --- prepared statements ---------------------------------------------------------------------
// source_table markers distinguish the two twin directions for later audit/idempotency.
const insAlias = db.prepare(`
  INSERT OR IGNORE INTO tire_barcode_aliases
    (barcode, barcode_type, canonical_product_id, source_table, alias_confidence, is_primary_form)
  VALUES (?, ?, ?, ?, 100, ?)
`);
const insAudit = db.prepare(`
  INSERT INTO remaining_blank_fill_audit
    (action, trust_color, confidence_score, canonical_product_uid, barcode, previous_value,
     new_value, candidate_count, candidate_values, reason)
  VALUES (?, 'green', 100, ?, ?, '', ?, 1, ?, ?)
`);
const insProv = db.prepare(`
  INSERT OR IGNORE INTO provenance
    (product_id, barcode, source_name, source_ref, sheet, row, batch_id, imported_at,
     evidence_level, license_note, content_hash)
  VALUES (?, ?, 'deterministic_backfill', ?, NULL, NULL, 'twin-complete', datetime('now'),
          'derived_relationship', NULL, NULL)
`);
// Clone the source tire row under the twin barcode (satisfies the alias<->tire validator gate).
const insTire = db.prepare(`
  INSERT OR IGNORE INTO tires (barcode, canonical_product_uid, brand, brand_normalized, model,
    model_normalized, size, raw_size_text, load_index, speed_rating, load_range, type, season,
    manufacturer_part_number, barcode_type, confidence, current_status, usable_for,
    field_completeness_score, missing_fields, source_count, model_display)
  SELECT ?, t.canonical_product_uid, t.brand, t.brand_normalized, t.model, t.model_normalized,
    t.size, t.raw_size_text, t.load_index, t.speed_rating, t.load_range, t.type, t.season,
    t.manufacturer_part_number, ?, t.confidence, t.current_status, t.usable_for,
    t.field_completeness_score, t.missing_fields, 0, t.model_display
  FROM tires t WHERE t.barcode = ?
`);
const markPrimary = db.prepare(
  "UPDATE tire_barcode_aliases SET is_primary_form = ? WHERE barcode = ?"
);

// --- candidate queries -----------------------------------------------------------------------
// `NOT GLOB '*[^0-9]*'` guards every twin candidate to digits-only: `length()` alone cannot tell
// a real 12/13-digit GTIN from an alphanumeric vendor code or corrupted value of the same
// character length, and twin math (substr/concat) on a non-numeric string mints a garbage
// "twin" barcode (found under adversarial testing 2026-07-28: a 12-char alphanumeric string was
// silently treated as a UPC-A and prefixed with '0' into a bogus 13-char alias). Barcodes are
// TEXT always, but twin completion only ever applies to genuine numeric GTIN/UPC/EAN forms.
// Direction A: UPC-A twin (drop leading zero of a 13-digit EAN starting with '0').
const dirA = db.prepare(`
  SELECT a.barcode, a.canonical_product_id
  FROM tire_barcode_aliases a
  WHERE length(a.barcode) = 13 AND substr(a.barcode, 1, 1) = '0' AND a.barcode NOT GLOB '*[^0-9]*'
    AND NOT EXISTS (SELECT 1 FROM tire_barcode_aliases b WHERE b.barcode = substr(a.barcode, 2))
`).all();
// Direction B: EAN-13 twin (prefix '0' to a 12-digit UPC-A).
const dirB = db.prepare(`
  SELECT a.barcode, a.canonical_product_id
  FROM tire_barcode_aliases a
  WHERE length(a.barcode) = 12 AND a.barcode NOT GLOB '*[^0-9]*'
    AND NOT EXISTS (SELECT 1 FROM tire_barcode_aliases b WHERE b.barcode = '0' || a.barcode)
`).all();

let addedA = 0;
let addedB = 0;

if (!DRY_RUN) {
  const tx = db.transaction(() => {
    // Direction A: add 12-digit UPC-A twin (PRIMARY form = 1), source EAN gets 0.
    for (const c of dirA) {
      const upc = c.barcode.slice(1);
      const r = insAlias.run(upc, "upc", c.canonical_product_id, "upc_twin_of_ean13", 1);
      if (r.changes === 1) {
        insTire.run(upc, "upc", c.barcode);
        insAudit.run(
          "add_upc_twin_alias", c.canonical_product_id, upc, upc, c.barcode,
          "UPC-A form of leading-zero EAN-13; same GTIN, same check digit, same product; primary form"
        );
        insProv.run(c.canonical_product_id, upc, "upc_twin_of_ean13#" + c.barcode);
        markPrimary.run(1, upc); // ensure primary designation even if alias pre-existed via IGNORE
        markPrimary.run(0, c.barcode);
        addedA++;
      }
    }
    // Direction B: add 13-digit EAN twin (0-prefixed, NON-primary = 0); the 12-digit UPC is primary.
    for (const c of dirB) {
      const ean = "0" + c.barcode;
      const r = insAlias.run(ean, "ean", c.canonical_product_id, "ean13_twin_of_upc", 0);
      if (r.changes === 1) {
        insTire.run(ean, "ean", c.barcode);
        insAudit.run(
          "add_ean13_twin_alias", c.canonical_product_id, ean, ean, c.barcode,
          "EAN-13 (0-prefixed) form of 12-digit UPC-A; same GTIN, same check digit, same product; UPC is primary form"
        );
        insProv.run(c.canonical_product_id, ean, "ean13_twin_of_upc#" + c.barcode);
        markPrimary.run(1, c.barcode); // the 12-digit UPC is the primary form
        markPrimary.run(0, ean);
        addedB++;
      }
    }

    // Repair pass for twin aliases from an earlier partial run missing their tire row (idempotent).
    const orphanUpc = db.prepare(`
      SELECT a.barcode FROM tire_barcode_aliases a
      WHERE a.source_table = 'upc_twin_of_ean13'
        AND NOT EXISTS (SELECT 1 FROM tires t WHERE t.barcode = a.barcode)
    `).all();
    for (const o of orphanUpc) insTire.run(o.barcode, "upc", "0" + o.barcode);
    const orphanEan = db.prepare(`
      SELECT a.barcode FROM tire_barcode_aliases a
      WHERE a.source_table = 'ean13_twin_of_upc'
        AND NOT EXISTS (SELECT 1 FROM tires t WHERE t.barcode = a.barcode)
    `).all();
    for (const o of orphanEan) insTire.run(o.barcode, "ean", o.barcode.slice(1));
  });
  tx();

  // Derive source_count for new twin tire rows from provenance (matches A5/A6/08 convention).
  db.prepare(`
    UPDATE tires SET source_count = (
      SELECT count(DISTINCT source_name || '|' || COALESCE(source_ref,''))
      FROM provenance p WHERE p.barcode = tires.barcode
    ) WHERE barcode IN (
      SELECT barcode FROM tire_barcode_aliases
      WHERE source_table IN ('upc_twin_of_ean13', 'ean13_twin_of_upc')
    )
  `).run();
}

console.log(
  JSON.stringify({
    dryRun: DRY_RUN,
    candidatesUpcTwin: dirA.length,
    candidatesEanTwin: dirB.length,
    addedUpcTwin: addedA,
    addedEanTwin: addedB,
  })
);

// Idempotency / completeness check: after a real run, zero missing twins in either direction.
const remainingA = db.prepare(`
  SELECT count(*) c FROM tire_barcode_aliases a
  WHERE length(a.barcode) = 13 AND substr(a.barcode, 1, 1) = '0' AND a.barcode NOT GLOB '*[^0-9]*'
    AND NOT EXISTS (SELECT 1 FROM tire_barcode_aliases b WHERE b.barcode = substr(a.barcode, 2))
`).get().c;
const remainingB = db.prepare(`
  SELECT count(*) c FROM tire_barcode_aliases a
  WHERE length(a.barcode) = 12 AND a.barcode NOT GLOB '*[^0-9]*'
    AND NOT EXISTS (SELECT 1 FROM tire_barcode_aliases b WHERE b.barcode = '0' || a.barcode)
`).get().c;
console.log(`remaining_missing_upc_twins=${remainingA} remaining_missing_ean_twins=${remainingB} (expect 0/0 after a real run)`);
db.close();
if (!DRY_RUN && (remainingA !== 0 || remainingB !== 0)) process.exit(1);
