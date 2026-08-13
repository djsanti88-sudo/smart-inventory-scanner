#!/usr/bin/env node
// build-knowledge-db.mjs — Converts tire + retail JSON indexes into a single SQLite database.
// The DB provides microsecond barcode lookups with ~5MB of runtime memory (vs ~1GB for JSON).
//
// Usage:  node scripts/build-knowledge-db.mjs
// Output: src/server/knowledge.generated.db
//
// Source files (committed to git):
//   src/server/tire-knowledge/tireKnowledge.generated.json   (53MB, 76K tires)
//   src/server/retail-knowledge/retailKnowledge.generated.json (247MB, 4M+ retail products, Git LFS)
//
// If the retail JSON is a Git LFS pointer (Vercel without LFS enabled), the retail table is
// skipped gracefully — tire lookups still work. Enable Git LFS on Vercel for retail coverage.

import { readFileSync, existsSync, unlinkSync, statSync, createReadStream, createWriteStream, renameSync } from "node:fs";
import { join } from "node:path";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import Database from "better-sqlite3";

const ROOT = process.cwd();
const TIRE_JSON = join(ROOT, "src", "server", "tire-knowledge", "tireKnowledge.generated.json");
const RETAIL_JSON = join(ROOT, "src", "server", "retail-knowledge", "retailKnowledge.generated.json");
const DB_PATH = join(ROOT, "src", "server", "knowledge.generated.db");
const GZ_PATH = DB_PATH + ".gz";
// Build into throwaway paths and swap them into place only after the output-sanity guard
// (DT-1, below) passes -- the prior committed DB must never be unlinked before the
// replacement is known sane.
const TMP_DB_PATH = DB_PATH + ".tmp";
const TMP_GZ_PATH = GZ_PATH + ".tmp";
const BATCH_SIZE = 50_000;
// Output-sanity guard (DT-1, 2026-08-13, ported from build-tire-knowledge.mjs's F1 fix,
// 2026-08-12): refuse a rebuild whose tire or retail row count is less than this fraction
// of the existing DB's row count. --force overrides, for a deliberate corpus replacement.
const MIN_RETAINED_FRACTION = 0.9;
const FORCE = process.argv.includes("--force");

function elapsed(start) {
  return ((performance.now() - start) / 1000).toFixed(1) + "s";
}

/** Row counts of the DB already on disk, or {tires:null, retail:null} when there is none. */
function priorRowCounts(path) {
  if (!existsSync(path)) return { tires: null, retail: null };
  let db;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    const count = (table) => {
      try { return db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c; } catch { return null; }
    };
    return { tires: count("tires"), retail: count("retail") };
  } catch {
    // Unreadable/corrupt prior DB: treat as absent rather than blocking a rebuild.
    return { tires: null, retail: null };
  } finally {
    db?.close();
  }
}

/** Detect Git LFS pointer files (~130 bytes, starts with "version https://git-lfs"). */
function isLfsPointer(path) {
  try {
    const size = statSync(path).size;
    if (size > 500) return false; // real files are much larger
    const content = readFileSync(path, "utf8");
    return content.startsWith("version https://git-lfs");
  } catch { return false; }
}

/** Safely read and parse a JSON file. Returns null if missing, LFS pointer, or invalid. */
function safeReadJson(path, label) {
  if (!existsSync(path)) {
    console.warn(`[knowledge-db] ${label} not found, skipping`);
    return null;
  }
  if (isLfsPointer(path)) {
    console.warn(`[knowledge-db] ${label} is a Git LFS pointer (not the real file). Enable Git LFS on your build server. Skipping.`);
    return null;
  }
  try {
    console.log(`[knowledge-db] Reading ${label}...`);
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    console.warn(`[knowledge-db] ${label} failed to parse: ${e.message}. Skipping.`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 1. Initialize DB
// ---------------------------------------------------------------------------
console.log("[knowledge-db] Building SQLite knowledge database...");
const t0 = performance.now();

// Clean up any stale tmp files left by a prior crashed/interrupted run. The COMMITTED
// DB_PATH/GZ_PATH are never touched here -- only the throwaway tmp paths.
for (const p of [TMP_DB_PATH, TMP_GZ_PATH]) { if (existsSync(p)) unlinkSync(p); }

const db = new Database(TMP_DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = OFF");
db.pragma("page_size = 8192");
db.pragma("cache_size = -64000");

// Row counts actually inserted into the new (tmp) DB, tracked for the output-sanity guard.
let newTireCount = 0;
let newRetailCount = 0;

// ---------------------------------------------------------------------------
// 2. Tire index
// ---------------------------------------------------------------------------
const tireData = safeReadJson(TIRE_JSON, "Tire JSON");
if (tireData) {
  const t1 = performance.now();

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

  console.log("[knowledge-db] Creating tire indexes...");
  db.exec("CREATE UNIQUE INDEX idx_tire_barcode ON tires(barcode)");
  db.exec("CREATE INDEX idx_tire_part_number ON tires(manufacturer_part_number)");
  db.exec("CREATE INDEX idx_tire_uid ON tires(canonical_product_uid)");

  console.log(`[knowledge-db] Tire: ${barcodeEntries.length} rows in ${elapsed(t1)}`);
  newTireCount = barcodeEntries.length;
}

// ---------------------------------------------------------------------------
// 3. Retail index
// ---------------------------------------------------------------------------
// Retail is always built when the source JSON exists (the DB is gzipped for the bundle).
const retailData = safeReadJson(RETAIL_JSON, "Retail JSON (247MB, may need Git LFS)");
if (retailData) {
  const t2 = performance.now();
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
      insertRetail.run(barcode, entry[0] || "", entry[1] || "", entry[2] || "");
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

  console.log("[knowledge-db] Creating retail barcode index...");
  db.exec("CREATE INDEX idx_retail_barcode ON retail(barcode)");

  console.log(`[knowledge-db] Retail: ${retailEntries.length} rows in ${elapsed(t2)}`);
  newRetailCount = retailEntries.length;
}

// ---------------------------------------------------------------------------
// 4. Finalize
// ---------------------------------------------------------------------------
console.log("[knowledge-db] Running ANALYZE...");
db.exec("ANALYZE");
db.pragma("journal_mode = DELETE");
console.log("[knowledge-db] Running VACUUM...");
db.exec("VACUUM");
db.close();

// OUTPUT-SANITY GUARD (DT-1, 2026-08-13). Everything above validated the INPUT JSON files
// (LFS-pointer detection, parse errors); nothing validated the RESULT before it replaced
// the committed runtime DB. A truncated or stale tireKnowledge.generated.json /
// retailKnowledge.generated.json would build cleanly and this script would previously
// unlinkSync the real DB_PATH up front, then atomically overwrite it with a near-empty
// database while reporting success -- destroying the runtime DB every decode rung depends
// on, worse than the sibling tire generator's pre-fix bug because it deletes before it
// validates. Building into TMP_DB_PATH (never DB_PATH) until this guard passes means the
// prior committed DB is untouched on refusal. Refuse to shrink.
const prior = priorRowCounts(DB_PATH);
const shrunkTires = prior.tires !== null && newTireCount < prior.tires * MIN_RETAINED_FRACTION;
const shrunkRetail = prior.retail !== null && newRetailCount < prior.retail * MIN_RETAINED_FRACTION;
if ((shrunkTires || shrunkRetail) && !FORCE) {
  for (const p of [TMP_DB_PATH, TMP_GZ_PATH]) { if (existsSync(p)) unlinkSync(p); }
  console.error(
    `[knowledge-db] FAIL-CLOSED: refusing to shrink the runtime DB: ` +
    `tires existing=${prior.tires ?? "n/a"} rebuild=${newTireCount}, ` +
    `retail existing=${prior.retail ?? "n/a"} rebuild=${newRetailCount} ` +
    `(below ${Math.round(MIN_RETAINED_FRACTION * 100)}% of existing on at least one table). ` +
    `This usually means tireKnowledge.generated.json or retailKnowledge.generated.json is truncated, ` +
    `missing, or an LFS pointer. Pass --force only if you intend to replace the corpus. ` +
    `The prior ${DB_PATH} was left untouched.`,
  );
  process.exit(1);
}

const dbSize = statSync(TMP_DB_PATH).size;
console.log(`[knowledge-db] DB size: ${(dbSize / 1024 / 1024).toFixed(1)} MB`);

// Gzip the DB for the Vercel function bundle (342MB -> ~125MB compressed).
// At runtime, the function decompresses to /tmp on the first cold start.
console.log("[knowledge-db] Compressing DB with gzip...");
await pipeline(createReadStream(TMP_DB_PATH), createGzip({ level: 6 }), createWriteStream(TMP_GZ_PATH));
const gzSize = statSync(TMP_GZ_PATH).size;
console.log(`[knowledge-db] Compressed: ${(gzSize / 1024 / 1024).toFixed(1)} MB (${Math.round((1 - gzSize / dbSize) * 100)}% reduction)`);

// Swap into place only now that the guard above has proven the replacement sane.
renameSync(TMP_DB_PATH, DB_PATH);
renameSync(TMP_GZ_PATH, GZ_PATH);

console.log(`[knowledge-db] Done in ${elapsed(t0)}.`);
console.log(`[knowledge-db] Output: ${DB_PATH} (${(dbSize / 1024 / 1024).toFixed(0)} MB) + ${GZ_PATH} (${(gzSize / 1024 / 1024).toFixed(0)} MB)`);
if (!tireData && !retailData) {
  console.warn("[knowledge-db] WARNING: No source data loaded. The DB is empty.");
}
