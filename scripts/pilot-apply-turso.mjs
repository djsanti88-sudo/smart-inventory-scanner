#!/usr/bin/env node
// scripts/pilot-apply-turso.mjs — Owner-authorized Point S pilot: additive-only Turso sync (2026-07-15).
//
// Diffs the current (already-applied) local corpus JSON against the live Turso `tires` table and
// applies ONLY:
//   1. INSERT of barcodes present locally but ABSENT from Turso (the pilot's new rows).
//   2. UPDATE of manufacturer_part_number for barcodes that exist in BOTH, where the Turso row's
//      manufacturer_part_number is currently NULL/blank (the pilot's PN-fills) — guarded by a
//      WHERE clause so a non-blank Turso value is NEVER touched. No other column is ever updated.
// This never deletes anything and never updates any column other than manufacturer_part_number on
// existing rows. Batched. Read-only mode first (--dry-run / default), live writes only with --apply.
//
// Usage:
//   node scripts/pilot-apply-turso.mjs                 read-only: counts + probes only, no writes
//   node scripts/pilot-apply-turso.mjs --apply          perform the additive INSERT + guarded UPDATE

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CORPUS_JSON_PATH = join(ROOT, "src", "server", "tire-knowledge", "tireKnowledge.generated.json");
const ENV_LOCAL_PATH = join(ROOT, ".env.local");

const APPLY = process.argv.includes("--apply");
const BATCH_SIZE = 500;

// Column order must match scripts/import-tires-turso.mjs / scripts/dt-harvest/lib/tursoUpsert.mjs.
const TIRES_COLUMNS = [
  "barcode", "canonical_product_uid", "brand", "brand_normalized",
  "model", "model_normalized", "size", "raw_size_text",
  "load_index", "speed_rating", "load_range", "type", "season",
  "manufacturer_part_number", "barcode_type", "confidence",
  "current_status", "usable_for", "field_completeness_score",
  "missing_fields", "source_count",
];

function normPartKey(pn) {
  return (pn ?? "").toString().replace(/[ -]/g, "").trim().toUpperCase().replace(/\s/g, "");
}

function readTursoCreds() {
  if (!existsSync(ENV_LOCAL_PATH)) return null;
  const env = {};
  for (const line of readFileSync(ENV_LOCAL_PATH, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  if (!env.TURSO_DATABASE_URL) return null;
  return { url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN };
}

function rowToTursoValues(barcodeKey, row) {
  return TIRES_COLUMNS.map((col) => {
    if (col === "barcode") return barcodeKey;
    if (col === "source_count") return Number(row?.source_count ?? 0);
    const v = row?.[col];
    return v === undefined || v === null ? "" : String(v);
  });
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  console.log(`[pilot-turso] Mode: ${APPLY ? "LIVE APPLY" : "READ-ONLY (default; pass --apply to write)"}`);

  const creds = readTursoCreds();
  if (!creds) {
    console.error("[pilot-turso] NO TURSO_DATABASE_URL in .env.local. Aborting.");
    process.exit(1);
  }
  console.log("[pilot-turso] Turso host:", creds.url.replace(/^libsql:\/\//, "").split(".")[0], "(rest hidden)");

  const corpus = JSON.parse(readFileSync(CORPUS_JSON_PATH, "utf8"));
  const barcodeIndex = corpus.barcodeIndex;
  const localKeys = Object.keys(barcodeIndex);

  const { createClient } = await import("@libsql/client");
  const db = createClient({ url: creds.url, authToken: creds.authToken });

  // --- BEFORE counts ---
  const beforeTires = await db.execute("SELECT count(*) AS n FROM tires");
  const beforePn = await db.execute("SELECT count(*) AS n FROM tire_part_numbers");
  console.log(`\n[pilot-turso] BEFORE: tires=${beforeTires.rows[0].n} tire_part_numbers=${beforePn.rows[0].n}`);
  console.log(`[pilot-turso] Local corpus barcodeIndex entries: ${localKeys.length}`);

  // --- Diff: find which local barcodes are absent from Turso, and which existing Turso rows
  // have a blank manufacturer_part_number where the local corpus now has a value.
  //
  // SCOPE GUARD: the local corpus has MANY more blank-PN-filled rows than this pilot run touched
  // (28586 rows already carry a PN pre-pilot, from unrelated earlier backfill rounds that never
  // synced to Turso — a pre-existing drift, confirmed by comparing tireKnowledge.generated.json's
  // pre-apply backup against Turso's tire_part_numbers count). This task is scoped to the Point S
  // pilot ONLY, so the PN-fill candidate set here is restricted to rows this run itself stamped
  // `part_number_source === "point_s_pilot"` — never the broader pre-existing gap. New rows are
  // scoped the same way: only barcodes stamped `source === "point_s_pilot"` are eligible for
  // INSERT (an "absent from Turso" local row from an unrelated source is out of scope here too). ---
  console.log("\n[pilot-turso] Diffing local corpus against Turso (batched lookups, scoped to point_s_pilot rows only)...");
  const pilotKeys = localKeys.filter((key) => {
    const row = barcodeIndex[key];
    return row.source === "point_s_pilot" || row.part_number_source === "point_s_pilot";
  });
  console.log(`[pilot-turso] point_s_pilot-attributable rows in local corpus: ${pilotKeys.length}`);

  const toInsert = [];
  const toUpdatePn = []; // { barcode, pn }

  for (const batch of chunk(pilotKeys, BATCH_SIZE)) {
    const placeholders = batch.map(() => "?").join(",");
    const existing = await db.execute({
      sql: `SELECT barcode, manufacturer_part_number FROM tires WHERE barcode IN (${placeholders})`,
      args: batch,
    });
    const existingMap = new Map(existing.rows.map((r) => [r.barcode, r.manufacturer_part_number]));

    for (const key of batch) {
      const localRow = barcodeIndex[key];
      if (!existingMap.has(key)) {
        if (localRow.source === "point_s_pilot") toInsert.push([key, localRow]);
        continue;
      }
      const tursoPn = (existingMap.get(key) || "").toString().trim();
      const localPn = (localRow.manufacturer_part_number || "").toString().trim();
      if (!tursoPn && localPn && localRow.part_number_source === "point_s_pilot") {
        toUpdatePn.push({ barcode: key, pn: localPn, uid: localRow.canonical_product_uid || "" });
      }
    }
  }

  console.log(`[pilot-turso] To INSERT (new rows, absent from Turso): ${toInsert.length}`);
  console.log(`[pilot-turso] To UPDATE (blank PN in Turso, filled locally): ${toUpdatePn.length}`);

  // --- Sample probes (read-only, always run) ---
  console.log("\n[pilot-turso] Sample probes:");
  for (const [key] of toInsert.slice(0, 3)) {
    console.log(`  NEW  ${key}  (expected ABSENT from Turso before apply)`);
  }
  for (const u of toUpdatePn.slice(0, 2)) {
    console.log(`  FILL ${u.barcode}  Turso PN currently blank -> will become "${u.pn}"`);
  }

  if (!APPLY) {
    console.log("\n[pilot-turso] READ-ONLY mode: no writes performed. Re-run with --apply to write.");
    await db.close?.();
    return;
  }

  // --- Apply: INSERT new rows ---
  if (toInsert.length) {
    const placeholders = `(${TIRES_COLUMNS.map(() => "?").join(", ")})`;
    const insertSql = `INSERT INTO tires (${TIRES_COLUMNS.join(", ")}) VALUES ${placeholders}`;
    console.log(`\n[pilot-turso] Inserting ${toInsert.length} new tires row(s)...`);
    for (const batch of chunk(toInsert, BATCH_SIZE)) {
      const statements = batch.map(([key, row]) => ({ sql: insertSql, args: rowToTursoValues(key, row) }));
      await db.batch(statements, "write");
    }

    // tire_part_numbers for the new rows
    const pnInsertSql = `INSERT OR REPLACE INTO tire_part_numbers (normalized_part_number, canonical_product_uid) VALUES (?, ?)`;
    const pnStatements = toInsert
      .filter(([, row]) => row.manufacturer_part_number)
      .map(([, row]) => {
        const pk = normPartKey(row.manufacturer_part_number);
        return pk ? { sql: pnInsertSql, args: [pk, row.canonical_product_uid || ""] } : null;
      })
      .filter(Boolean);
    if (pnStatements.length) {
      console.log(`[pilot-turso] Inserting ${pnStatements.length} tire_part_numbers row(s) for new tires...`);
      for (const batch of chunk(pnStatements, BATCH_SIZE)) {
        await db.batch(batch, "write");
      }
    }
  }

  // --- Apply: guarded UPDATE for PN-fills. WHERE clause enforces "only if currently null/blank". ---
  if (toUpdatePn.length) {
    console.log(`\n[pilot-turso] Updating ${toUpdatePn.length} tires.manufacturer_part_number (blank -> filled, guarded)...`);
    const updateSql = `UPDATE tires SET manufacturer_part_number = ? WHERE barcode = ? AND (manufacturer_part_number IS NULL OR manufacturer_part_number = '')`;
    for (const batch of chunk(toUpdatePn, BATCH_SIZE)) {
      const statements = batch.map((u) => ({ sql: updateSql, args: [u.pn, u.barcode] }));
      await db.batch(statements, "write");
    }

    const pnInsertSql = `INSERT OR REPLACE INTO tire_part_numbers (normalized_part_number, canonical_product_uid) VALUES (?, ?)`;
    const pnStatements = toUpdatePn
      .map((u) => {
        const pk = normPartKey(u.pn);
        return pk ? { sql: pnInsertSql, args: [pk, u.uid] } : null;
      })
      .filter(Boolean);
    if (pnStatements.length) {
      console.log(`[pilot-turso] Inserting ${pnStatements.length} tire_part_numbers row(s) for PN-fills...`);
      for (const batch of chunk(pnStatements, BATCH_SIZE)) {
        await db.batch(batch, "write");
      }
    }
  }

  // --- AFTER counts + re-probe ---
  const afterTires = await db.execute("SELECT count(*) AS n FROM tires");
  const afterPn = await db.execute("SELECT count(*) AS n FROM tire_part_numbers");
  console.log(`\n[pilot-turso] AFTER: tires=${afterTires.rows[0].n} tire_part_numbers=${afterPn.rows[0].n}`);
  console.log(`[pilot-turso] Delta: tires ${beforeTires.rows[0].n} -> ${afterTires.rows[0].n} (+${Number(afterTires.rows[0].n) - Number(beforeTires.rows[0].n)})`);
  console.log(`[pilot-turso] Delta: tire_part_numbers ${beforePn.rows[0].n} -> ${afterPn.rows[0].n} (+${Number(afterPn.rows[0].n) - Number(beforePn.rows[0].n)})`);

  console.log("\n[pilot-turso] Re-probing sample barcodes after apply:");
  for (const [key] of toInsert.slice(0, 3)) {
    const r = await db.execute({ sql: "SELECT barcode, brand, manufacturer_part_number FROM tires WHERE barcode = ?", args: [key] });
    console.log(`  ${key} -> ${r.rows.length ? JSON.stringify(r.rows[0]) : "STILL ABSENT (unexpected!)"}`);
  }
  for (const u of toUpdatePn.slice(0, 2)) {
    const r = await db.execute({ sql: "SELECT barcode, brand, manufacturer_part_number FROM tires WHERE barcode = ?", args: [u.barcode] });
    console.log(`  ${u.barcode} -> ${r.rows.length ? JSON.stringify(r.rows[0]) : "MISSING (unexpected!)"}`);
  }

  await db.close?.();
  console.log("\n[pilot-turso] Done.");
}

main().catch((e) => {
  console.error("[pilot-turso] ERROR:", e?.stack || e?.message || e);
  process.exit(1);
});
