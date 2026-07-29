// UPC-A alias pass: for every EAN-13 alias starting with '0' whose 12-digit UPC-A
// twin is absent, add the twin pointing at the SAME product. Deterministic, idempotent.
// EAN-13 with leading 0 and its UPC-A form are the same GTIN; check digit is identical.
import { createRequire } from 'node:module';
const require = createRequire('C:/Users/djsan/inventory/package.json');
const Database = require('better-sqlite3');

const dbPath = process.argv[2] ?? 'backups/claude-tire-db-handoff-2026-07-28/repair-2026-07-28/REPAIRED_TIRE_DATABASE.db';
const db = new Database(dbPath);
db.pragma('busy_timeout = 30000');

const candidates = db.prepare(`
  SELECT a.barcode, a.canonical_product_id, a.source_table
  FROM tire_barcode_aliases a
  WHERE length(a.barcode) = 13 AND substr(a.barcode, 1, 1) = '0'
    AND NOT EXISTS (SELECT 1 FROM tire_barcode_aliases b WHERE b.barcode = substr(a.barcode, 2))
`).all();

// Safety: refuse any twin that would collide with an existing different-product alias
// (the NOT EXISTS above already guarantees absence, but keep the guard explicit).
const insAlias = db.prepare(`
  INSERT OR IGNORE INTO tire_barcode_aliases (barcode, barcode_type, canonical_product_id, source_table, alias_confidence)
  VALUES (?, 'upc', ?, 'upc_twin_of_ean13', 100)
`);
const insAudit = db.prepare(`
  INSERT INTO remaining_blank_fill_audit (action, trust_color, confidence_score, canonical_product_uid, barcode, previous_value, new_value, candidate_count, candidate_values, reason)
  VALUES ('add_upc_twin_alias', 'green', 100, ?, ?, '', ?, 1, ?, 'UPC-A form of leading-zero EAN-13; same GTIN, same check digit, same product')
`);
const insProv = db.prepare(`
  INSERT OR IGNORE INTO provenance (product_id, barcode, source_name, source_ref, sheet, row, batch_id, imported_at, evidence_level, license_note, content_hash)
  VALUES (?, ?, 'deterministic_backfill', 'upc_twin_of_ean13#' || ?, NULL, NULL, 'upc-twin-2026-07-28', datetime('now'), 'derived_relationship', NULL, NULL)
`);

// DB invariant (validator gate): every alias row has a tires row with the same
// barcode. Existing twins are modeled as duplicated tires rows, so clone the
// EAN-13's tire row under the UPC-A barcode (same product identity).
const insTire = db.prepare(`
  INSERT OR IGNORE INTO tires (barcode, canonical_product_uid, brand, brand_normalized, model, model_normalized, size, raw_size_text,
    load_index, speed_rating, load_range, type, season, manufacturer_part_number, barcode_type, confidence, current_status,
    usable_for, field_completeness_score, missing_fields, source_count, model_display)
  SELECT ?, t.canonical_product_uid, t.brand, t.brand_normalized, t.model, t.model_normalized, t.size, t.raw_size_text,
    t.load_index, t.speed_rating, t.load_range, t.type, t.season, t.manufacturer_part_number, 'upc', t.confidence, t.current_status,
    t.usable_for, t.field_completeness_score, t.missing_fields, 0, t.model_display
  FROM tires t WHERE t.barcode = ?
`);

let added = 0;
const tx = db.transaction(() => {
  for (const c of candidates) {
    const upc = c.barcode.slice(1);
    const r = insAlias.run(upc, c.canonical_product_id);
    if (r.changes === 1) {
      insTire.run(upc, c.barcode);
      insAudit.run(c.canonical_product_id, upc, upc, c.barcode);
      insProv.run(c.canonical_product_id, upc, c.barcode);
      added++;
    }
  }
  // repair pass for aliases added by an earlier partial run (idempotent)
  const orphanTwins = db.prepare(`
    SELECT a.barcode FROM tire_barcode_aliases a
    WHERE a.source_table = 'upc_twin_of_ean13'
      AND NOT EXISTS (SELECT 1 FROM tires t WHERE t.barcode = a.barcode)
  `).all();
  for (const o of orphanTwins) insTire.run(o.barcode, '0' + o.barcode);
});
tx();
// derive source_count for the new tire rows from provenance (matches A5/A6 convention)
db.prepare(`
  UPDATE tires SET source_count = (
    SELECT count(DISTINCT source_name || '|' || COALESCE(source_ref,'')) FROM provenance p WHERE p.barcode = tires.barcode
  ) WHERE barcode_type = 'upc' AND barcode IN (SELECT barcode FROM tire_barcode_aliases WHERE source_table = 'upc_twin_of_ean13')
`).run();

console.log(`candidates=${candidates.length} added=${added}`);
const remaining = db.prepare(`
  SELECT count(*) c FROM tire_barcode_aliases a
  WHERE length(a.barcode) = 13 AND substr(a.barcode, 1, 1) = '0'
    AND NOT EXISTS (SELECT 1 FROM tire_barcode_aliases b WHERE b.barcode = substr(a.barcode, 2))
`).get().c;
console.log(`remaining_missing_twins=${remaining} (expect 0)`);
if (remaining !== 0) process.exit(1);
