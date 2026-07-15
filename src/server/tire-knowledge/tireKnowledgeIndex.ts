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
  _jsonIndex = null;
  _uidToRow = null;
  _tursoClient = null;
  _tursoClientPromise = null;
}
