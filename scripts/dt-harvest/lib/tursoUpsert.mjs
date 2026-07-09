// scripts/dt-harvest/lib/tursoUpsert.mjs
// Pure helpers + a thin Turso-write wrapper so apply.mjs can additively upsert newly-harvested
// tire rows into the Turso `tires` (+ `tire_part_numbers`) tables, mirroring the schema and
// key-derivation scripts/import-tires-turso.mjs already established for the one-time bulk import.
// This module intentionally reuses that exact column list / normalization / INSERT OR REPLACE
// batch pattern rather than diverging (see import-tires-turso.mjs's header comment for why the
// stored key must equal what the runtime lookup computes from a scanned code).
//
// Scope: ONLY the tires / tire_part_numbers tables. Never touches retail / decode_cache /
// goupc_* / decode_archive.

/** Column order for the Turso `tires` table — must match import-tires-turso.mjs's TIRES_COLUMNS. */
export const TIRES_COLUMNS = [
  "barcode", "canonical_product_uid", "brand", "brand_normalized",
  "model", "model_normalized", "size", "raw_size_text",
  "load_index", "speed_rating", "load_range", "type", "season",
  "manufacturer_part_number", "barcode_type", "confidence",
  "current_status", "usable_for", "field_completeness_score",
  "missing_fields", "source_count",
];

export const CREATE_TIRES_TABLE = `CREATE TABLE IF NOT EXISTS tires (
  barcode TEXT PRIMARY KEY,
  canonical_product_uid TEXT,
  brand TEXT,
  brand_normalized TEXT,
  model TEXT,
  model_normalized TEXT,
  size TEXT,
  raw_size_text TEXT,
  load_index TEXT,
  speed_rating TEXT,
  load_range TEXT,
  type TEXT,
  season TEXT,
  manufacturer_part_number TEXT,
  barcode_type TEXT,
  confidence TEXT,
  current_status TEXT,
  usable_for TEXT,
  field_completeness_score TEXT,
  missing_fields TEXT,
  source_count INTEGER
)`;

export const CREATE_MPN_INDEX = `CREATE INDEX IF NOT EXISTS idx_tires_manufacturer_part_number ON tires (manufacturer_part_number)`;

// New (this task): supports the part-number two-step lookup path (tire_part_numbers ->
// canonical_product_uid -> tires row) — index the join column.
export const CREATE_UID_INDEX = `CREATE INDEX IF NOT EXISTS idx_tires_uid ON tires (canonical_product_uid)`;

export const CREATE_PART_NUMBERS_TABLE = `CREATE TABLE IF NOT EXISTS tire_part_numbers (
  normalized_part_number TEXT PRIMARY KEY,
  canonical_product_uid TEXT
)`;

/** Same normalization tireKnowledgeIndex.ts's normPartKey() and import-tires-turso.mjs use. */
export function normPartKey(pn) {
  return (pn ?? "").toString().replace(/[ -]/g, "").trim().toUpperCase().replace(/\s/g, "");
}

/**
 * Map one corpus row (the tireKnowledge.generated.json barcodeIndex[barcode] shape apply.mjs
 * already builds/merges) to a Turso `tires` INSERT OR REPLACE args array, in TIRES_COLUMNS order.
 * `barcodeKey` is the already-normalized JSON key (same value used as the SQLite `barcode` column
 * and as the JS object's map key) — passed separately because the row itself may carry a slightly
 * different `barcode` field in edge cases; the stored key must be the one the runtime looks up by.
 *
 * @param {string} barcodeKey
 * @param {object} row
 * @returns {(string|number)[]}
 */
export function rowToTursoValues(barcodeKey, row) {
  return TIRES_COLUMNS.map((col) => {
    if (col === "barcode") return barcodeKey;
    if (col === "source_count") return Number(row?.source_count ?? 0);
    const v = row?.[col];
    return v === undefined || v === null ? "" : String(v);
  });
}

/**
 * Build the batch of libsql statements to upsert a Map<barcodeKey, row> of newly-added tire rows
 * into `tires`, plus one statement per row that has a manufacturer_part_number into
 * `tire_part_numbers` (normPartKey(mpn) -> canonical_product_uid). Pure — does not execute
 * anything; callers pass the result straight to a libsql client's db.batch(...).
 *
 * @param {Map<string, object>} newlyAdded
 * @returns {{ tireStatements: {sql:string, args:(string|number)[]}[], partNumberStatements: {sql:string, args:string[]}[] }}
 */
export function buildUpsertStatements(newlyAdded) {
  const tiresPlaceholders = `(${TIRES_COLUMNS.map(() => "?").join(", ")})`;
  const tiresInsertSql = `INSERT OR REPLACE INTO tires (${TIRES_COLUMNS.join(", ")}) VALUES ${tiresPlaceholders}`;
  const pnInsertSql = `INSERT OR REPLACE INTO tire_part_numbers (normalized_part_number, canonical_product_uid) VALUES (?, ?)`;

  const tireStatements = [];
  const partNumberStatements = [];

  for (const [barcodeKey, row] of newlyAdded.entries()) {
    tireStatements.push({ sql: tiresInsertSql, args: rowToTursoValues(barcodeKey, row) });

    const mpn = row?.manufacturer_part_number;
    if (mpn) {
      const pk = normPartKey(mpn);
      if (pk) partNumberStatements.push({ sql: pnInsertSql, args: [pk, row.canonical_product_uid ?? ""] });
    }
  }

  return { tireStatements, partNumberStatements };
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Additive Turso upsert of newly-harvested tire rows. Gated by the caller on TURSO_DATABASE_URL
 * being set and --no-turso not being passed. Any error here is caught by the caller and logged as
 * a warning — this must never fail the local corpus apply.
 *
 * @param {object} opts
 * @param {Map<string, object>} opts.newlyAdded barcodeKey -> corpus row (this run's additions only)
 * @param {{url: string, authToken?: string}} opts.creds
 * @param {number} [opts.batchSize]
 * @returns {Promise<{ tiresWritten: number, partNumbersWritten: number }>}
 */
export async function upsertNewTiresToTurso({ newlyAdded, creds, batchSize = 500 }) {
  if (!newlyAdded || newlyAdded.size === 0) {
    return { tiresWritten: 0, partNumbersWritten: 0 };
  }

  const { createClient } = await import("@libsql/client");
  const db = createClient({ url: creds.url, authToken: creds.authToken });

  try {
    await db.execute(CREATE_TIRES_TABLE);
    await db.execute(CREATE_MPN_INDEX);
    await db.execute(CREATE_UID_INDEX);
    await db.execute(CREATE_PART_NUMBERS_TABLE);

    const { tireStatements, partNumberStatements } = buildUpsertStatements(newlyAdded);

    for (const batch of chunk(tireStatements, batchSize)) {
      await db.batch(batch, "write");
    }
    for (const batch of chunk(partNumberStatements, batchSize)) {
      await db.batch(batch, "write");
    }

    return { tiresWritten: tireStatements.length, partNumbersWritten: partNumberStatements.length };
  } finally {
    await db.close?.();
  }
}

/** Minimal .env.local parser (no dep), mirroring import-tires-turso.mjs / turso-inspect.mjs. */
export function readTursoCredsFromEnvFile(readFileSyncFn, path) {
  const env = {};
  let text;
  try {
    text = readFileSyncFn(path, "utf8");
  } catch {
    return null;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  if (!env.TURSO_DATABASE_URL) return null;
  return { url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN };
}
