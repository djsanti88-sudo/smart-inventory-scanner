import "server-only";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getKnowledgeDb } from "@/server/knowledgeDb";

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

/** EXACT trusted barcode lookup. Returns the corpus row or null. Never near-matches. */
export async function lookupByExactBarcode(code: string): Promise<TireKnowledgeRow | null> {
  const key = normBarcodeKey(code);
  if (!key) return null;
  const stmt = getStmtBarcode();
  if (stmt) return (stmt.get(key) as TireKnowledgeRow | undefined) ?? null;
  const idx = getJsonIndex();
  return idx ? (idx.barcodeIndex[key] ?? null) : null;
}

/** EXACT trusted manufacturer-part-number lookup. Returns the corpus row or null. */
export async function lookupByExactPartNumber(partNumber: string): Promise<TireKnowledgeRow | null> {
  const key = normPartKey(partNumber);
  if (!key) return null;
  const stmt = getStmtPartNumber();
  if (stmt) return (stmt.get(key) as TireKnowledgeRow | undefined) ?? null;
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
}
