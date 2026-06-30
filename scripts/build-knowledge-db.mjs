#!/usr/bin/env node
// build-knowledge-db.mjs — Converts tire + retail JSON indexes into a single SQLite database.
// The DB provides microsecond barcode lookups with ~5MB of runtime memory (vs ~1GB for JSON).
//
// Usage:  node scripts/build-knowledge-db.mjs
// Output: src/server/knowledge.generated.db
//
// Source files (committed to git):
//   src/server/tire-knowledge/tireKnowledge.generated.json   (53MB, 76K tires)
//   src/server/retail-knowledge/retailKnowledge.generated.json (247MB, 4M+ retail products)

import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

const ROOT = process.cwd();
const TIRE_JSON = join(ROOT, "src", "server", "tire-knowledge", "tireKnowledge.generated.json");
const RETAIL_JSON = join(ROOT, "src", "server", "retail-knowledge", "retailKnowledge.generated.json");
const DB_PATH = join(ROOT, "src", "server", "knowledge.generated.db");
const BATCH_SIZE = 50_000;

function elapsed(start) {
  return ((performance.now() - start) / 1000).toFixed(1) + "s";
}

// ---------------------------------------------------------------------------
// 1. Initialize DB
// ---------------------------------------------------------------------------
console.log("[knowledge-db] Building SQLite knowledge database...");
const t0 = performance.now();

// Remove old DB if it exists (clean rebuild)
if (existsSync(DB_PATH)) unlinkSync(DB_PATH);

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = OFF");    // safe: we're building, not serving
db.pragma("page_size = 8192");     // larger pages = fewer seeks for reads
db.pragma("cache_size = -64000");  // 64MB cache during build

// ---------------------------------------------------------------------------
// 2. Tire index
// ---------------------------------------------------------------------------
if (existsSync(TIRE_JSON)) {
  const t1 = performance.now();
  console.log("[knowledge-db] Reading tire JSON...");
  const tireData = JSON.parse(readFileSync(TIRE_JSON, "utf8"));

  db.exec(`
    CREATE TABLE tires (
      barcode TEXT NOT NULL,
      canonical_product_uid TEXT NOT NULL,
      brand TEXT NOT NULL DEFAULT '',
      brand_normalized TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      model_normalized TEXT NOT NULL DEFAULT '',
      size TEXT NOT NULL DEFAULT '',
      raw_size_text TEXT NOT NULL DEFAULT '',
      load_index TEXT NOT NULL DEFAULT '',
      speed_rating TEXT NOT NULL DEFAULT '',
      load_range TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT '',
      season TEXT NOT NULL DEFAULT '',
      manufacturer_part_number TEXT NOT NULL DEFAULT '',
      barcode_type TEXT NOT NULL DEFAULT '',
      confidence TEXT NOT NULL DEFAULT '',
      current_status TEXT NOT NULL DEFAULT '',
      usable_for TEXT NOT NULL DEFAULT '',
      field_completeness_score TEXT NOT NULL DEFAULT '',
      missing_fields TEXT NOT NULL DEFAULT '',
      source_count INTEGER NOT NULL DEFAULT 0
    )
  `);

  const insertTire = db.prepare(`
    INSERT INTO tires (
      barcode, canonical_product_uid, brand, brand_normalized,
      model, model_normalized, size, raw_size_text,
      load_index, speed_rating, load_range, type, season,
      manufacturer_part_number, barcode_type, confidence,
      current_status, usable_for, field_completeness_score,
      missing_fields, source_count
    ) VALUES (
      @barcode, @canonical_product_uid, @brand, @brand_normalized,
      @model, @model_normalized, @size, @raw_size_text,
      @load_index, @speed_rating, @load_range, @type, @season,
      @manufacturer_part_number, @barcode_type, @confidence,
      @current_status, @usable_for, @field_completeness_score,
      @missing_fields, @source_count
    )
  `);

  // Normalize barcode key the same way the runtime does: strip spaces/dashes
  function normBarcode(code) {
    return (code ?? "").toString().replace(/[ -]/g, "").trim();
  }

  const barcodeEntries = Object.entries(tireData.barcodeIndex || {});
  console.log(`[knowledge-db] Inserting ${barcodeEntries.length} tire rows...`);

  const insertTireBatch = db.transaction((batch) => {
    for (const [rawKey, row] of batch) {
      const key = normBarcode(rawKey);
      if (!key) continue;
      insertTire.run({
        barcode: key,
        canonical_product_uid: row.canonical_product_uid || "",
        brand: row.brand || "",
        brand_normalized: row.brand_normalized || "",
        model: row.model || "",
        model_normalized: row.model_normalized || "",
        size: row.size || "",
        raw_size_text: row.raw_size_text || "",
        load_index: row.load_index || "",
        speed_rating: row.speed_rating || "",
        load_range: row.load_range || "",
        type: row.type || "",
        season: row.season || "",
        manufacturer_part_number: row.manufacturer_part_number || "",
        barcode_type: row.barcode_type || "",
        confidence: row.confidence || "",
        current_status: row.current_status || "",
        usable_for: row.usable_for || "",
        field_completeness_score: row.field_completeness_score || "",
        missing_fields: row.missing_fields || "",
        source_count: row.source_count ?? 0,
      });
    }
  });

  for (let i = 0; i < barcodeEntries.length; i += BATCH_SIZE) {
    insertTireBatch(barcodeEntries.slice(i, i + BATCH_SIZE));
  }

  // Create indexes AFTER inserts (much faster)
  console.log("[knowledge-db] Creating tire indexes...");
  db.exec("CREATE UNIQUE INDEX idx_tire_barcode ON tires(barcode)");
  db.exec("CREATE INDEX idx_tire_part_number ON tires(manufacturer_part_number)");
  db.exec("CREATE INDEX idx_tire_uid ON tires(canonical_product_uid)");

  console.log(`[knowledge-db] Tire: ${barcodeEntries.length} rows in ${elapsed(t1)}`);
} else {
  console.warn("[knowledge-db] Tire JSON not found, skipping tire table");
}

// ---------------------------------------------------------------------------
// 3. Retail index
// ---------------------------------------------------------------------------
if (existsSync(RETAIL_JSON)) {
  const t2 = performance.now();
  console.log("[knowledge-db] Reading retail JSON (this may take a moment for 247MB)...");
  const retailData = JSON.parse(readFileSync(RETAIL_JSON, "utf8"));
  const retailIndex = retailData.index || {};
  const retailEntries = Object.entries(retailIndex);

  console.log(`[knowledge-db] Parsed ${retailEntries.length} retail entries in ${elapsed(t2)}`);

  db.exec(`
    CREATE TABLE retail (
      barcode TEXT NOT NULL,
      product_name TEXT NOT NULL DEFAULT '',
      brand TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT ''
    )
  `);

  const insertRetail = db.prepare(
    "INSERT INTO retail (barcode, product_name, brand, category) VALUES (?, ?, ?, ?)"
  );

  const insertRetailBatch = db.transaction((batch) => {
    for (const [barcode, entry] of batch) {
      if (!barcode) continue;
      insertRetail.run(
        barcode,
        entry[0] || "",
        entry[1] || "",
        entry[2] || "",
      );
    }
  });

  console.log(`[knowledge-db] Inserting ${retailEntries.length} retail rows...`);
  const t3 = performance.now();
  for (let i = 0; i < retailEntries.length; i += BATCH_SIZE) {
    insertRetailBatch(retailEntries.slice(i, i + BATCH_SIZE));
    if ((i + BATCH_SIZE) % 500_000 === 0 || i + BATCH_SIZE >= retailEntries.length) {
      const pct = Math.min(100, Math.round(((i + BATCH_SIZE) / retailEntries.length) * 100));
      console.log(`[knowledge-db]   ${pct}% (${Math.min(i + BATCH_SIZE, retailEntries.length)}/${retailEntries.length}) in ${elapsed(t3)}`);
    }
  }

  // Create index AFTER inserts
  console.log("[knowledge-db] Creating retail barcode index...");
  db.exec("CREATE INDEX idx_retail_barcode ON retail(barcode)");

  console.log(`[knowledge-db] Retail: ${retailEntries.length} rows in ${elapsed(t2)}`);

  // Free the parsed JSON from memory
  // (retailData and retailIndex will be GC'd after this scope)
} else {
  console.warn("[knowledge-db] Retail JSON not found, skipping retail table");
}

// ---------------------------------------------------------------------------
// 4. Finalize
// ---------------------------------------------------------------------------
console.log("[knowledge-db] Running ANALYZE...");
db.exec("ANALYZE");

// Switch from WAL to DELETE journal for the read-only production file
db.pragma("journal_mode = DELETE");

// VACUUM to reclaim space and compact the file
console.log("[knowledge-db] Running VACUUM...");
db.exec("VACUUM");

db.close();

const stat = readFileSync(DB_PATH);
console.log(`[knowledge-db] Done in ${elapsed(t0)}. DB size: ${(stat.length / 1024 / 1024).toFixed(1)} MB`);
console.log(`[knowledge-db] Output: ${DB_PATH}`);
