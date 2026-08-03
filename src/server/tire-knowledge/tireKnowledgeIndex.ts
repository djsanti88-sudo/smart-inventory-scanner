import "server-only";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getKnowledgeDb } from "@/server/knowledgeDb";
import { getTursoClient as getRetailTursoClient, type TursoClient } from "@/server/retail-knowledge/retailKnowledgeIndex";
import { lookupCandidates } from "@/services/upc/gtin";
import { tirePartNumberVariants } from "@/services/catalog/tirePartNumber";
import { isTrustedLocalDemoTireRow, isValidLocalDemoGtin } from "@/server/tire-knowledge/localDemoTrust.mjs";
import { findBossShopCodeRedirect, matchesBossShopCodeRedirectTarget } from "@/server/tire-knowledge/bossExactEvidenceLedger";

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
  model_display?: string;
  size: string; raw_size_text: string;
  load_index: string; speed_rating: string; load_range: string;
  type: string; season: string;
  manufacturer_part_number: string;
  barcode: string; barcode_type: string;
  confidence: string; current_status: string; usable_for: string;
  field_completeness_score: string; missing_fields: string;
  source_count: number;
  /** Ephemeral marker set only after the local UPC/EAN twin identity gate passes. */
  localDemoTwinSelected?: boolean;
  /** Ephemeral marker for a tenant-gated frozen Boss shop-code redirect. */
  bossShopCodeAliasSelected?: string;
}

export interface TireKnowledgeLookupOptions { authenticatedBusinessId?: string | null; }

/** Server-only exact allowlist; empty/anonymous values never enable a redirect. */
export function isBossShopCodeAliasBusinessAllowed(businessId: string | null | undefined): boolean {
  if (!businessId?.trim()) return false;
  return (process.env.BOSS_SHOP_CODE_ALIAS_BUSINESS_IDS ?? "").split(",").map((value) => value.trim()).filter(Boolean).includes(businessId);
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
  /** Normalized MPNs owned by more than one canonical product. These are terminal misses. */
  ambiguousPartNumberKeys?: string[];
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
    _jsonIndex = {
      barcodeIndex: parsed.barcodeIndex ?? {},
      partNumberIndex: parsed.partNumberIndex ?? {},
      ambiguousPartNumberKeys: Array.isArray(parsed.ambiguousPartNumberKeys)
        ? parsed.ambiguousPartNumberKeys
        : undefined,
    };
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
let _stmtPartNumberAlias: ReturnType<import("better-sqlite3").Database["prepare"]> | null = null;
let _stmtByUid: ReturnType<import("better-sqlite3").Database["prepare"]> | null = null;

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
    // RC2 (pilot PN recall): normalized-column compare, mirroring getStmtAllPartNumber (commit
    // 19bf8b0). The caller always passes an already-normPartKey'd key (spaces + hyphens stripped,
    // uppercased), but the stored column is RAW - without this a hyphenated/spaced PN silently
    // misses on SQLite while Turso/JSON (both normalized) hit.
    _stmtPartNumber = db.prepare(
      "SELECT * FROM tires WHERE UPPER(REPLACE(REPLACE(manufacturer_part_number, ' ', ''), '-', '')) = ?",
    );
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
    // Normalized compare (review I-1): the caller always passes an already-normPartKey'd key
    // (spaces + hyphens stripped, uppercased), but the stored column is RAW. Mirror the
    // getStmtBySize normalization style so a hyphenated/spaced PN (e.g. "TBAT-I0041295") still
    // matches; without this, SQLite silently missed while Turso/JSON (both normalized) hit.
    _stmtAllPartNumber = db.prepare(
      "SELECT * FROM tires WHERE UPPER(REPLACE(REPLACE(manufacturer_part_number, ' ', ''), '-', '')) = ?",
    );
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

/** Task A4: part-number ALIAS fallback (tire_product_part_number_aliases), tried only after the
 *  canonical tire_part_numbers lookup misses. Deliberately NO LIMIT and no is_unambiguous filter in
 *  the SQL itself: the caller must see every distinct canonical_product_id a normalized key maps to
 *  so ambiguity is decided in application code, never by SQL row order (LIMIT 1 would silently pick
 *  a side). is_unambiguous is stored per-row at population time (03_part_number_aliases.mjs), but is
 *  re-derived live here from the actual DISTINCT count so a stale flag can never cause a false match. */
function getStmtPartNumberAlias() {
  if (_stmtPartNumberAlias) return _stmtPartNumberAlias;
  const db = getKnowledgeDb();
  if (!db) return null;
  try {
    _stmtPartNumberAlias = db.prepare(
      "SELECT DISTINCT canonical_product_id FROM tire_product_part_number_aliases WHERE normalized_part_number = ?",
    );
    return _stmtPartNumberAlias;
  } catch { return null; }
}

/** Resolve a canonical_product_uid directly to its tires row. Backs the alias-table fallback above. */
function getStmtByUid() {
  if (_stmtByUid) return _stmtByUid;
  const db = getKnowledgeDb();
  if (!db) return null;
  try {
    _stmtByUid = db.prepare("SELECT * FROM tires WHERE canonical_product_uid = ? LIMIT 1");
    return _stmtByUid;
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
    model_display: typeof row.model_display === "string" ? row.model_display : undefined,
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

type TursoBarcodeLookup =
  | { state: "unavailable" | "miss" | "error"; row: null }
  | { state: "hit"; row: TireKnowledgeRow };

/** Turso barcode lookup distinguishes an unavailable client from a query error for alias safety. */
async function lookupBarcodeTursoResult(key: string): Promise<TursoBarcodeLookup> {
  try {
    const client = await getTireTursoClient();
    if (!client) return { state: "unavailable", row: null };
    const result = await client.execute({ sql: "SELECT * FROM tires WHERE barcode = ?", args: [key] });
    if (result.rows.length === 0) return { state: "miss", row: null };
    return { state: "hit", row: rowFromTurso(result.rows[0]) };
  } catch (e) {
    console.warn("[tire-knowledge] Turso barcode lookup failed:", (e as Error).message);
    return { state: "error", row: null };
  }
}

/** Redirect-specific Turso lookup distinguishes unavailable (JSON may be used) from an error (terminal miss). */
async function lookupBossRedirectTurso(key: string): Promise<{ available: boolean; row: TireKnowledgeRow | null }> {
  try {
    const client = await getTireTursoClient();
    if (!client) return { available: false, row: null };
    const result = await client.execute({ sql: "SELECT * FROM tires WHERE barcode = ?", args: [key] });
    return { available: true, row: result.rows.length ? rowFromTurso(result.rows[0]) : null };
  } catch (e) {
    console.warn("[tire-knowledge] Turso Boss shop-code redirect lookup failed:", (e as Error).message);
    return { available: true, row: null };
  }
}

/** Turso part-number lookup: two-step (normalized_part_number -> canonical_product_uid -> tires row).
 *  A normalized MPN with multiple distinct canonical products is terminally ambiguous. */
async function lookupPartNumberTurso(key: string): Promise<{ row: TireKnowledgeRow | null; ambiguous: boolean }> {
  try {
    const client = await getTireTursoClient();
    if (!client) return { row: null, ambiguous: false };
    const partResult = await client.execute({
      sql: "SELECT DISTINCT canonical_product_uid FROM tire_part_numbers WHERE normalized_part_number = ?",
      args: [key],
    });
    if (partResult.rows.length === 0) return { row: null, ambiguous: false };
    if (partResult.rows.length !== 1) return { row: null, ambiguous: true };
    const uid = partResult.rows[0].canonical_product_uid as string;
    if (!uid) return { row: null, ambiguous: false };
    const tireResult = await client.execute({
      sql: "SELECT * FROM tires WHERE canonical_product_uid = ? LIMIT 1",
      args: [uid],
    });
    if (tireResult.rows.length === 0) return { row: null, ambiguous: false };
    return { row: rowFromTurso(tireResult.rows[0]), ambiguous: false };
  } catch (e) {
    console.warn("[tire-knowledge] Turso part-number lookup failed:", (e as Error).message);
    return { row: null, ambiguous: false };
  }
}

/** EXACT trusted barcode lookup. Order: local SQLite (fast, dev) -> Turso (Vercel) -> in-memory JSON
 *  (last-ditch dev fallback; the file is .vercelignored so it never exists on Vercel). Never near-matches. */
export async function lookupByExactBarcode(code: string, options?: TireKnowledgeLookupOptions): Promise<TireKnowledgeRow | null> {
  const key = normBarcodeKey(code);
  if (!key) return null;
  const approvedBossRedirect = findBossShopCodeRedirect(key);
  const bossRedirectAllowed = approvedBossRedirect
    ? isBossShopCodeAliasBusinessAllowed(options?.authenticatedBusinessId)
    : false;
  if (approvedBossRedirect && !bossRedirectAllowed) {
    console.warn("[tire-knowledge] Boss shop-code redirect disabled for request", {
      allowlistConfigured: Boolean((process.env.BOSS_SHOP_CODE_ALIAS_BUSINESS_IDS ?? "").trim()),
      authenticatedBusinessIdPresent: Boolean(options?.authenticatedBusinessId?.trim()),
    });
  }
  const candidates = lookupCandidates(key);
  const stmt = getStmtBarcode();
  if (stmt) {
    for (const c of candidates) {
      const row = (stmt.get(c) as TireKnowledgeRow | undefined) ?? null;
      if (row) return row;
    }
    const redirect = bossRedirectAllowed ? approvedBossRedirect : undefined;
    if (redirect) {
      const row = (stmt.get(redirect.canonicalBarcode) as TireKnowledgeRow | undefined) ?? null;
      if (row && matchesBossShopCodeRedirectTarget(redirect, row)) return { ...row, bossShopCodeAliasSelected: key };
    }
    return null;
  }
  let ordinaryTursoQueryErrored = false;
  for (const c of candidates) {
    const tursoResult = await lookupBarcodeTursoResult(c);
    if (tursoResult.state === "hit") return tursoResult.row;
    if (tursoResult.state === "error") ordinaryTursoQueryErrored = true;
  }
  const redirect = bossRedirectAllowed ? approvedBossRedirect : undefined;
  // An ordinary candidate query error is not an ordinary miss.  Do not make a second canonical
  // redirect query after uncertain evidence; ordinary lookup still retains its JSON fallback below.
  if (redirect && !ordinaryTursoQueryErrored) {
    const redirectResult = await lookupBossRedirectTurso(redirect.canonicalBarcode);
    if (redirectResult.available && !redirectResult.row) return null;
    const row = redirectResult.row;
    if (row && matchesBossShopCodeRedirectTarget(redirect, row)) return { ...row, bossShopCodeAliasSelected: key };
  }
  const idx = getJsonIndex();
  if (!idx) return null;
  for (const c of candidates) {
    const row = idx.barcodeIndex[c] ?? null;
    if (row) return row;
  }
  // A JSON ordinary exact hit above remains valid ordinary behavior.  But once every ordinary
  // candidate missed, an earlier Turso error makes a redirect unsafe: never query/read its
  // canonical target from JSON after an uncertain ordinary probe.
  if (redirect && ordinaryTursoQueryErrored) return null;
  if (redirect) {
    const row = idx.barcodeIndex[redirect.canonicalBarcode] ?? null;
    if (row && matchesBossShopCodeRedirectTarget(redirect, row)) return { ...row, bossShopCodeAliasSelected: key };
  }
  return null;
}

/** Local-demo exact lookup: SQLite only.  Never falls back to Turso or generated JSON. */
export async function lookupByExactBarcodeLocal(code: string): Promise<TireKnowledgeRow | null> {
  const key = normBarcodeKey(code);
  if (!key) return null;
  const stmt = getStmtBarcode();
  if (!stmt) throw new Error("Local SQLite tire database is unavailable.");
  const candidates = lookupCandidates(key);
  const rows = candidates.map((candidate) => (stmt.get(candidate) as TireKnowledgeRow | undefined) ?? null);
  const raw = rows[0];
  // A scanner may send the UPC form while the corpus stores only the independently trusted
  // zero-padded EAN (or vice versa). Preserve the established candidate fallback, but never
  // mint the narrower twin exception without a raw identity row to compare.
  if (!raw) return rows.slice(1).find((row): row is TireKnowledgeRow => Boolean(row && isTrustedLocalDemoTireRow(row))) ?? null;
  // Preserve existing raw-first behavior whenever the raw row independently clears ordinary trust.
  if (isTrustedLocalDemoTireRow(raw)) return raw;
  for (const companion of rows.slice(1)) {
    if (companion && isSafeLocalDemoTwin(raw, companion)) {
      return { ...companion, localDemoTwinSelected: true };
    }
  }
  return raw;
}

function isUpcType(value: string): boolean { return value === "upc" || value === "upc_a"; }
function isEanType(value: string): boolean { return value === "ean" || value === "ean_13"; }
function trimmed(value: string | undefined): string { return String(value ?? "").trim(); }

/** Narrow local-only exception: exact UPC-A/EAN-13 twins, never generic trust promotion. */
function isSafeLocalDemoTwin(raw: TireKnowledgeRow, companion: TireKnowledgeRow): boolean {
  const rawCode = trimmed(raw.barcode);
  const companionCode = trimmed(companion.barcode);
  if (!isValidLocalDemoGtin(rawCode) || !isValidLocalDemoGtin(companionCode)) return false;
  if (!((rawCode.length === 12 && companionCode.length === 13) || (rawCode.length === 13 && companionCode.length === 12))) return false;
  if (rawCode.replace(/^0+/, "") !== companionCode.replace(/^0+/, "")) return false;
  if (!((isUpcType(trimmed(raw.barcode_type)) && isEanType(trimmed(companion.barcode_type))) || (isEanType(trimmed(raw.barcode_type)) && isUpcType(trimmed(companion.barcode_type))))) return false;
  if (!trimmed(raw.canonical_product_uid) || raw.canonical_product_uid !== companion.canonical_product_uid) return false;
  const rawMpn = trimmed(raw.manufacturer_part_number);
  const companionMpn = trimmed(companion.manufacturer_part_number);
  if (!rawMpn || !companionMpn) return false;
  if (!tirePartNumberVariants(rawMpn).some((variant) => tirePartNumberVariants(companionMpn).includes(variant))) return false;
  return trimmed(companion.confidence) === "process_verified_green"
    && trimmed(companion.current_status) === "active_retail"
    && trimmed(companion.usable_for) === "auto_count_candidate"
    && Boolean(trimmed(companion.brand))
    && Boolean(trimmed(companion.model_display) || trimmed(companion.model))
    && Boolean(trimmed(companion.size));
}

/**
 * EXACT trusted manufacturer-part-number lookup. Same SQLite -> Turso -> JSON order as barcode
 * lookup, but tries an ORDERED candidate key list per backend before moving to the next backend:
 * [normPartKey(raw), ...affix-core variants that differ from it]. Shop part numbers carry
 * distributor affixes the corpus never stores (KH2265992 vs corpus "2265992"; F-28074576 vs
 * "28074576"). tirePartNumberVariants() (src/services/catalog/tirePartNumber.ts) already knows how
 * to strip a leading/trailing distributor affix down to the numeric core - it is reused here so the
 * scan-path lookup benefits from the exact same primitive the reconcile matcher already trusts.
 *
 * SAFETY: each candidate must resolve to exactly one distinct canonical product. A collision is a
 * terminal null (Needs Review), never a first-row guess or a fallback to a lower-trust variant.
 */
export async function lookupByExactPartNumber(partNumber: string): Promise<TireKnowledgeRow | null> {
  const primary = normPartKey(partNumber);
  if (!primary) return null;
  // tirePartNumberVariants operates on the raw string (it does its own normalization internally);
  // its first element is the same normPartKey-equivalent base, so de-dupe against `primary` and
  // keep only variants that genuinely differ (the affix-core key).
  const variants = tirePartNumberVariants(partNumber).filter((v) => v && v !== primary);
  const candidates = [primary, ...variants];

  const stmt = getStmtPartNumber();
  if (stmt) {
    for (const key of candidates) {
      const result = lookupCanonicalPartNumberSqlite(stmt, key);
      if (result.ambiguous) return null;
      if (result.row) return result.row;
    }
    // Task A4: tire_part_numbers/tires miss on every candidate key -> fall back to the
    // distributor/boss part-number ALIAS table before giving up on this backend.
    for (const key of candidates) {
      const row = lookupPartNumberAliasSqlite(key);
      if (row) return row;
    }
    return null;
  }

  for (const key of candidates) {
    const result = await lookupPartNumberTurso(key);
    if (result.ambiguous) return null;
    if (result.row) return result.row;
  }
  // Task A4: same alias fallback on the Turso path, tried only after every candidate key has
  // missed the canonical tire_part_numbers two-step lookup above.
  for (const key of candidates) {
    const aliasRow = await lookupPartNumberAliasTurso(key);
    if (aliasRow) return aliasRow;
  }

  const idx = getJsonIndex();
  if (!idx) return null;
  // A legacy single-valued index cannot prove that its chosen UID is the only owner. Until the
  // generator has emitted explicit collision metadata, JSON part-number resolution fails closed.
  if (!idx.ambiguousPartNumberKeys) return null;
  for (const key of candidates) {
    if (idx.ambiguousPartNumberKeys?.includes(key)) return null;
    const uid = idx.partNumberIndex[key];
    const row = uid && _uidToRow ? (_uidToRow.get(uid) ?? null) : null;
    if (row) return row;
  }
  return null;
}

/** SQLite canonical MPN lookup with the same distinct-product ambiguity contract as Turso. */
function lookupCanonicalPartNumberSqlite(
  stmt: { all: (key: string) => unknown[] },
  key: string,
): { row: TireKnowledgeRow | null; ambiguous: boolean } {
  try {
    const rows = stmt.all(key) as TireKnowledgeRow[];
    const products = new Set(rows.map((row) => row.canonical_product_uid).filter(Boolean));
    if (products.size !== 1) return { row: null, ambiguous: products.size > 1 };
    return { row: rows.find((row) => row.canonical_product_uid === [...products][0]) ?? null, ambiguous: false };
  } catch {
    return { row: null, ambiguous: false };
  }
}

/** Task A4: SQLite part-number ALIAS fallback (tire_product_part_number_aliases), tried only after
 *  the canonical tires/tire_part_numbers lookup misses. Ambiguous alias (the normalized key maps to
 *  more than one distinct canonical_product_id) returns null - never guesses by picking a row. */
function lookupPartNumberAliasSqlite(key: string): TireKnowledgeRow | null {
  const aliasStmt = getStmtPartNumberAlias();
  const uidStmt = getStmtByUid();
  if (!aliasStmt || !uidStmt) return null;
  try {
    const aliasRows = aliasStmt.all(key) as Array<{ canonical_product_id: string }>;
    if (aliasRows.length !== 1) return null; // 0 = no alias; >1 = ambiguous, never guess
    const uid = aliasRows[0].canonical_product_id;
    if (!uid) return null;
    return (uidStmt.get(uid) as TireKnowledgeRow | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Task A4: Turso part-number ALIAS fallback. Same ambiguity contract as getStmtPartNumberAlias:
 *  fetch every DISTINCT canonical_product_id the normalized key maps to, resolve to a tires row
 *  only when exactly one distinct product is present. Fail-safe: any error returns null, never throws. */
async function lookupPartNumberAliasTurso(key: string): Promise<TireKnowledgeRow | null> {
  try {
    const client = await getTireTursoClient();
    if (!client) return null;
    const aliasResult = await client.execute({
      sql: "SELECT DISTINCT canonical_product_id FROM tire_product_part_number_aliases WHERE normalized_part_number = ?",
      args: [key],
    });
    if (aliasResult.rows.length !== 1) return null; // 0 = no alias; >1 = ambiguous, never guess
    const uid = aliasResult.rows[0].canonical_product_id as string;
    if (!uid) return null;
    const tireResult = await client.execute({
      sql: "SELECT * FROM tires WHERE canonical_product_uid = ? LIMIT 1",
      args: [uid],
    });
    if (tireResult.rows.length === 0) return null;
    return rowFromTurso(tireResult.rows[0]);
  } catch (e) {
    console.warn("[tire-knowledge] Turso part-number ALIAS lookup failed:", (e as Error).message);
    return null;
  }
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
  if (!idx?.ambiguousPartNumberKeys) return [];
  if (idx.ambiguousPartNumberKeys.includes(key)) return [];
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
  _stmtPartNumberAlias = null;
  _stmtByUid = null;
  _jsonIndex = null;
  _uidToRow = null;
  _tursoClient = null;
  _tursoClientPromise = null;
}
