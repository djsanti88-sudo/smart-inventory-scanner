import "server-only";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getKnowledgeDb } from "@/server/knowledgeDb";
import { getTursoClient as getRetailTursoClient, type TursoClient } from "@/server/retail-knowledge/retailKnowledgeIndex";
import { lookupCandidates } from "@/services/upc/gtin";

// SERVER-ONLY tire knowledge index reader. Uses SQLite for microsecond lookups with ~5MB memory.
// The `server-only` import makes this a BUILD ERROR if imported from a client component.
// EXACT lookups only. No fuzzy/near-match — near-match auto-count is forbidden.
//
// The JSON source files stay in git for regeneration but are NOT loaded at runtime.
// Run `npm run build:knowledge-db` to generate the SQLite DB from the JSON indexes.

export interface TireKnowledgeRow {
  canonical_product_uid: string;
  brand: string; brand_normalized: string;
  model: string; model_normalized: string;
  size: string; raw_size_text: string;
  load_index: string; speed_rating: string; load_range: string;
  type: string; season: string;
  manufacturer_part_number: string;
  barcode: string; barcode_type: string;
  confidence: string; current_status: string; usable_for: string;
  field_completeness_score: string; missing_fields: string;
  source_count: number;
}

export interface TireKnowledgeMeta extends Record<string, unknown> { schema_version?: string; generated_at?: string; trusted_rows_ingested?: number; barcode_index_count?: number; harvester_snapshot_used?: boolean; }

const META_PATH = join(process.cwd(), "src", "server", "tire-knowledge", "tireKnowledge.generated.meta.json");

let _metaPromise: Promise<TireKnowledgeMeta | null> | null = null;

/** Safe scanner-key normalization: trim, drop control chars, strip space/dash separators. */
function normBarcodeKey(code: string): string {
  return (code ?? "").toString().replace(/[ -]/g, "").trim().replace(/[ -]/g, "");
}
function normPartKey(pn: string): string {
  return (pn ?? "").toString().replace(/[ -]/g, "").trim().toUpperCase().replace(/\s/g, "");
}

const TIRE_JSON_PATH = join(process.cwd(), "src", "server", "tire-knowledge", "tireKnowledge.generated.json");

interface TireJsonIndex {
  barcodeIndex: Record<string, TireKnowledgeRow>;
  partNumberIndex: Record<string, string>;
}
let _jsonIndex: TireJsonIndex | null | "missing" = null;
let _uidToRow: Map<string, TireKnowledgeRow> | null = null;

/** Load the committed tire JSON into memory once (cached for the process lifetime). Used when the
 *  SQLite knowledge DB is unavailable (the normal case on Vercel, where the .db file is not bundled). */
function getJsonIndex(): TireJsonIndex | null {
  if (_jsonIndex === "missing") return null;
  if (_jsonIndex) return _jsonIndex;
  try {
    const parsed = JSON.parse(readFileSync(TIRE_JSON_PATH, "utf8")) as TireJsonIndex;
    _jsonIndex = { barcodeIndex: parsed.barcodeIndex ?? {}, partNumberIndex: parsed.partNumberIndex ?? {} };
    _uidToRow = new Map();
    for (const row of Object.values(_jsonIndex.barcodeIndex)) _uidToRow.set(row.canonical_product_uid, row);
    return _jsonIndex;
  } catch (e) {
    console.warn("[tire-knowledge] in-memory JSON index load failed:", (e as Error).message);
    _jsonIndex = "missing";
    return null;
  }
}

// SQLite prepared statements (created lazily, cached for process lifetime)
let _stmtBarcode: ReturnType<import("better-sqlite3").Database["prepare"]> | null = null;
let _stmtPartNumber: ReturnType<import("better-sqlite3").Database["prepare"]> | null = null;
let _stmtAllPartNumber: ReturnType<import("better-sqlite3").Database["prepare"]> | null = null;
let _stmtBySize: ReturnType<import("better-sqlite3").Database["prepare"]> | null = null;

function getStmtBarcode() {
  if (_stmtBarcode) return _stmtBarcode;
  const db = getKnowledgeDb();
  if (!db) return null;
  try {
    _stmtBarcode = db.prepare("SELECT * FROM tires WHERE barcode = ?");
    return _stmtBarcode;
  } catch { return null; }
}

function getStmtPartNumber() {
  if (_stmtPartNumber) return _stmtPartNumber;
  const db = getKnowledgeDb();
  if (!db) return null;
  try {
    _stmtPartNumber = db.prepare("SELECT * FROM tires WHERE manufacturer_part_number = ? LIMIT 1");
    return _stmtPartNumber;
  } catch { return null; }
}

function getStmtAllPartNumber() {
  if (_stmtAllPartNumber) return _stmtAllPartNumber;
  const db = getKnowledgeDb();
  if (!db) return null;
  try {
    // Deliberately NO LIMIT: the reconcile matcher must see EVERY row a part number maps to
    // (a non-unique index treated as unique would silently hide a brand collision).
    _stmtAllPartNumber = db.prepare("SELECT * FROM tires WHERE manufacturer_part_number = ?");
    return _stmtAllPartNumber;
  } catch { return null; }
}

function getStmtBySize() {
  if (_stmtBySize) return _stmtBySize;
  const db = getKnowledgeDb();
  if (!db) return null;
  try {
    // Canonical compare: stored size stripped of spaces + uppercased, matched against a
    // tireSizeToken-style token (already space-free and uppercase).
    _stmtBySize = db.prepare("SELECT * FROM tires WHERE UPPER(REPLACE(size, ' ', '')) = ?");
    return _stmtBySize;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Turso remote DB (production on Vercel, where the SQLite file is not bundled).
// Reuses the SAME connection-caching + env-detection helper as retail-knowledge so there is only
// one Turso-connection pattern in the codebase.
// ---------------------------------------------------------------------------

let _tursoClient: TursoClient | null = null;
let _tursoClientPromise: Promise<TursoClient | null> | null = null;

async function getTireTursoClient(): Promise<TursoClient | null> {
  if (_tursoClient) return _tursoClient;
  if (!_tursoClientPromise) _tursoClientPromise = getRetailTursoClient();
  const client = await _tursoClientPromise;
  if (client) _tursoClient = client;
  return client;
}

/** Map a raw Turso row (plain object) to the typed TireKnowledgeRow shape, coercing source_count. */
function rowFromTurso(row: Record<string, unknown>): TireKnowledgeRow {
  return {
    canonical_product_uid: (row.canonical_product_uid as string) ?? "",
    brand: (row.brand as string) ?? "",
    brand_normalized: (row.brand_normalized as string) ?? "",
    model: (row.model as string) ?? "",
    model_normalized: (row.model_normalized as string) ?? "",
    size: (row.size as string) ?? "",
    raw_size_text: (row.raw_size_text as string) ?? "",
    load_index: (row.load_index as string) ?? "",
    speed_rating: (row.speed_rating as string) ?? "",
    load_range: (row.load_range as string) ?? "",
    type: (row.type as string) ?? "",
    season: (row.season as string) ?? "",
    manufacturer_part_number: (row.manufacturer_part_number as string) ?? "",
    barcode: (row.barcode as string) ?? "",
    barcode_type: (row.barcode_type as string) ?? "",
    confidence: (row.confidence as string) ?? "",
    current_status: (row.current_status as string) ?? "",
    usable_for: (row.usable_for as string) ?? "",
    field_completeness_score: (row.field_completeness_score as string) ?? "",
    missing_fields: (row.missing_fields as string) ?? "",
    source_count: Number(row.source_count ?? 0),
  };
}

/** Turso barcode lookup. Fail-safe: any error (missing creds, network) returns null, never throws. */
async function lookupBarcodeTurso(key: string): Promise<TireKnowledgeRow | null> {
  try {
    const client = await getTireTursoClient();
    if (!client) return null;
    const result = await client.execute({ sql: "SELECT * FROM tires WHERE barcode = ?", args: [key] });
    if (result.rows.length === 0) return null;
    return rowFromTurso(result.rows[0]);
  } catch (e) {
    console.warn("[tire-knowledge] Turso barcode lookup failed:", (e as Error).message);
    return null;
  }
}

/** Turso part-number lookup: two-step (normalized_part_number -> canonical_product_uid -> tires row).
 *  Fail-safe: any error returns null, never throws. */
async function lookupPartNumberTurso(key: string): Promise<TireKnowledgeRow | null> {
  try {
    const client = await getTireTursoClient();
    if (!client) return null;
    const partResult = await client.execute({
      sql: "SELECT canonical_product_uid FROM tire_part_numbers WHERE normalized_part_number = ?",
      args: [key],
    });
    if (partResult.rows.length === 0) return null;
    const uid = partResult.rows[0].canonical_product_uid as string;
    if (!uid) return null;
    const tireResult = await client.execute({
      sql: "SELECT * FROM tires WHERE canonical_product_uid = ? LIMIT 1",
      args: [uid],
    });
    if (tireResult.rows.length === 0) return null;
    return rowFromTurso(tireResult.rows[0]);
  } catch (e) {
    console.warn("[tire-knowledge] Turso part-number lookup failed:", (e as Error).message);
    return null;
  }
}

/** EXACT trusted barcode lookup. Order: local SQLite (fast, dev) -> Turso (Vercel) -> in-memory JSON
 *  (last-ditch dev fallback; the file is .vercelignored so it never exists on Vercel). Never near-matches. */
export async function lookupByExactBarcode(code: string): Promise<TireKnowledgeRow | null> {
  const key = normBarcodeKey(code);
  if (!key) return null;
  const candidates = lookupCandidates(key);
  const stmt = getStmtBarcode();
  if (stmt) {
    for (const c of candidates) {
      const row = (stmt.get(c) as TireKnowledgeRow | undefined) ?? null;
      if (row) return row;
    }
    return null;
  }
  for (const c of candidates) {
    const tursoRow = await lookupBarcodeTurso(c);
    if (tursoRow) return tursoRow;
  }
  const idx = getJsonIndex();
  if (!idx) return null;
  for (const c of candidates) {
    const row = idx.barcodeIndex[c] ?? null;
    if (row) return row;
  }
  return null;
}

/** EXACT trusted manufacturer-part-number lookup. Same SQLite -> Turso -> JSON order as barcode lookup. */
export async function lookupByExactPartNumber(partNumber: string): Promise<TireKnowledgeRow | null> {
  const key = normPartKey(partNumber);
  if (!key) return null;
  const stmt = getStmtPartNumber();
  if (stmt) return (stmt.get(key) as TireKnowledgeRow | undefined) ?? null;
  const tursoRow = await lookupPartNumberTurso(key);
  if (tursoRow) return tursoRow;
  const idx = getJsonIndex();
  if (!idx) return null;
  const uid = idx.partNumberIndex[key];
  return uid && _uidToRow ? (_uidToRow.get(uid) ?? null) : null;
}

/** Turso: ALL rows for a normalized part number via a single join. Fail-safe: errors return []. */
async function lookupAllPartNumberTurso(key: string): Promise<TireKnowledgeRow[]> {
  try {
    const client = await getTireTursoClient();
    if (!client) return [];
    const result = await client.execute({
      sql: "SELECT t.* FROM tires t JOIN tire_part_numbers p ON p.canonical_product_uid = t.canonical_product_uid WHERE p.normalized_part_number = ?",
      args: [key],
    });
    return result.rows.map((r) => rowFromTurso(r as Record<string, unknown>));
  } catch (e) {
    console.warn("[tire-knowledge] Turso all-part-number lookup failed:", (e as Error).message);
    return [];
  }
}

/** Turso: all rows whose canonical size equals the token. Fail-safe: errors return []. */
async function candidatesBySizeTurso(token: string): Promise<TireKnowledgeRow[]> {
  try {
    const client = await getTireTursoClient();
    if (!client) return [];
    const result = await client.execute({
      sql: "SELECT * FROM tires WHERE UPPER(REPLACE(size, ' ', '')) = ?",
      args: [token],
    });
    return result.rows.map((r) => rowFromTurso(r as Record<string, unknown>));
  } catch (e) {
    console.warn("[tire-knowledge] Turso size lookup failed:", (e as Error).message);
    return [];
  }
}

/** Canonical size key for the in-memory JSON fallback: spaces stripped, uppercased. */
function canonicalSizeKey(size: string): string {
  return (size ?? "").replace(/\s+/g, "").toUpperCase();
}

/**
 * Reconcile helper (Task 7): ALL corpus rows for an ALREADY-NORMALIZED part-number key.
 * Contract (carry-forward review note): the caller (identityMatcher via the route's MatcherDeps)
 * normalized the PN with normPartKey semantics BEFORE calling this - this function performs a
 * DIRECT keyed lookup with NO re-normalization, and returns EVERY matching row, never LIMIT 1.
 * The JSON fallback's partNumberIndex is single-valued today (Record<key, uid>), so that path
 * returns at most one row - the array shape keeps the contract honest for multi-hit backends.
 * Same backend order as the other lookups: SQLite -> Turso -> in-memory JSON. Never throws.
 */
export async function lookupAllByPartNumber(normalizedPn: string): Promise<TireKnowledgeRow[]> {
  const key = (normalizedPn ?? "").toString();
  if (!key) return [];
  const stmt = getStmtAllPartNumber();
  if (stmt) {
    try { return stmt.all(key) as TireKnowledgeRow[]; } catch { return []; }
  }
  const tursoRows = await lookupAllPartNumberTurso(key);
  if (tursoRows.length > 0) return tursoRows;
  const idx = getJsonIndex();
  if (!idx) return [];
  const uid = idx.partNumberIndex[key];
  const row = uid && _uidToRow ? _uidToRow.get(uid) : undefined;
  return row ? [row] : [];
}

/**
 * Reconcile helper (Task 7): every corpus row whose canonical size (spaces stripped, uppercased)
 * equals `sizeToken` (a tireSizeToken-style token, e.g. "265/70R17"). Feeds the identity-match
 * rung of the reconcile matcher, which re-checks brand/family and size on every candidate itself,
 * so over-returning across brands here is safe. Same backend order; never throws.
 */
export async function candidatesBySizeToken(sizeToken: string): Promise<TireKnowledgeRow[]> {
  const token = canonicalSizeKey(sizeToken);
  if (!token) return [];
  const stmt = getStmtBySize();
  if (stmt) {
    try { return stmt.all(token) as TireKnowledgeRow[]; } catch { return []; }
  }
  const tursoRows = await candidatesBySizeTurso(token);
  if (tursoRows.length > 0) return tursoRows;
  const idx = getJsonIndex();
  if (!idx || !_uidToRow) return [];
  const out: TireKnowledgeRow[] = [];
  for (const row of _uidToRow.values()) {
    if (canonicalSizeKey(row.size) === token) out.push(row);
  }
  return out;
}

/** Read the generated metadata (counts/version) — for platformOwner diagnostics only. Fail-closed. */
export async function getTireKnowledgeMeta(): Promise<TireKnowledgeMeta | null> {
  if (!_metaPromise) _metaPromise = readFile(META_PATH, "utf8").then((r) => JSON.parse(r) as TireKnowledgeMeta).catch(() => null);
  return _metaPromise;
}

/** Test-only: reset caches so a regenerated index is re-read. */
export function __resetTireKnowledgeCacheForTests(): void {
  _metaPromise = null;
  _stmtBarcode = null;
  _stmtPartNumber = null;
  _stmtAllPartNumber = null;
  _stmtBySize = null;
  _jsonIndex = null;
  _uidToRow = null;
  _tursoClient = null;
  _tursoClientPromise = null;
}
