// Retail product knowledge index: 4M+ products from Open Food Facts.
// Barcode -> productName, brand, category. SERVER-SIDE ONLY.
//
// Two lookup paths (tried in order):
//   1. Local SQLite (if knowledge.generated.db exists — local dev with build:knowledge-db)
//   2. Turso remote DB (if TURSO_DATABASE_URL + TURSO_AUTH_TOKEN are set — production on Vercel)
// Both return the same RetailLookupResult shape. If neither is available, returns null.

import { getKnowledgeDb } from "@/server/knowledgeDb";
import { isGarbledCorpusRow } from "@/services/catalog/corpusGarbage";

/** Generate zero-padded barcode variants (UPC-12, EAN-13, GTIN-14) for lookup normalization. */
function barcodeVariants(code: string): string[] {
  const stripped = code.replace(/^0+/, "") || "0";
  const variants = new Set([code, stripped]);
  for (const base of [code, stripped]) {
    if (base.length <= 14) variants.add(base.padStart(14, "0"));
    if (base.length <= 13) variants.add(base.padStart(13, "0"));
    if (base.length <= 12) variants.add(base.padStart(12, "0"));
  }
  return [...variants].filter((c) => c.length >= 8 && c.length <= 14);
}

export interface RetailLookupResult {
  productName: string;
  brand: string;
  category: string;
  barcode: string; // the variant that matched
}

// ---------------------------------------------------------------------------
// Path 1: Local SQLite (dev mode)
// ---------------------------------------------------------------------------
let _stmtLookup: ReturnType<import("better-sqlite3").Database["prepare"]> | null = null;
let _sqliteChecked = false;

function getSqliteStmt() {
  if (_stmtLookup) return _stmtLookup;
  if (_sqliteChecked) return null;
  const db = getKnowledgeDb();
  if (!db) { _sqliteChecked = true; return null; }
  try {
    _stmtLookup = db.prepare("SELECT barcode, product_name, brand, category FROM retail WHERE barcode = ?");
    return _stmtLookup;
  } catch {
    _sqliteChecked = true;
    return null;
  }
}

function lookupSqlite(code: string): RetailLookupResult | null {
  const stmt = getSqliteStmt();
  if (!stmt) return null;
  const variants = barcodeVariants(code.trim());
  for (const v of variants) {
    const row = stmt.get(v) as { barcode: string; product_name: string; brand: string; category: string } | undefined;
    if (row) {
      // Defense-in-depth read guard (QA Task 5): even a not-yet-rebuilt local DB or drifted Turso mirror
      // must not serve a garbled (run-on multi-brand / ingredient-blob) row as a trusted hit.
      if (isGarbledCorpusRow(row.product_name, row.brand)) continue;
      _lastStatus = "sqlite_hit";
      return { productName: row.product_name, brand: row.brand, category: row.category, barcode: row.barcode };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Path 2: Turso remote DB (production on Vercel)
// ---------------------------------------------------------------------------
export type TursoClient = { execute: (stmt: { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };
let _tursoClient: TursoClient | null | "unavailable" = null;

/** Outcome of the most recent lookupRetailBarcode(Async) call, for observability. Distinguishes a
 *  genuine "barcode not in the corpus" miss from a swallowed Turso connection/query error, which
 *  otherwise look identical (both fall through to the paid AI decode path with no visible signal). */
export type RetailLookupStatus = "idle" | "sqlite_hit" | "turso_hit" | "turso_miss" | "turso_error" | "unavailable";
let _lastStatus: RetailLookupStatus = "idle";

/** The status of the most recent retail lookup. Read by the /api/ai-lookup route to surface a
 *  broken Turso connection distinctly from a real corpus miss in the decode debug payload. */
export function getLastRetailLookupStatus(): RetailLookupStatus {
  return _lastStatus;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LibsqlClientModule = { createClient: (config: { url: string; authToken: string }) => any };

// Exported so other server-side knowledge indexes (e.g. tire-knowledge) reuse the SAME Turso
// connection-caching + env-detection pattern instead of a second divergent implementation.
// NOTE: the module-level cache below is shared with retail's own lookups; tire-knowledge calls
// this from a different module scope, so it gets its own independent cache slot (fine — both
// point at the same Turso DB/creds, and each caller wants its own tiny cache lifecycle for tests).
export async function getTursoClient(): Promise<TursoClient | null> {
  if (_tursoClient === "unavailable") return null;
  if (_tursoClient) return _tursoClient;
  const url = process.env.TURSO_DATABASE_URL;
  const token = process.env.TURSO_AUTH_TOKEN;
  if (!url || !token) { _tursoClient = "unavailable"; return null; }
  try {
    const { createClient } = (await import("@libsql/client")) as unknown as LibsqlClientModule;
    _tursoClient = createClient({ url, authToken: token }) as TursoClient;
    console.log("[retail-knowledge] Turso client connected:", url);
    return _tursoClient;
  } catch (e) {
    console.warn("[retail-knowledge] Failed to create Turso client:", (e as Error).message);
    _tursoClient = "unavailable";
    return null;
  }
}

async function lookupTurso(code: string): Promise<RetailLookupResult | null> {
  const client = await getTursoClient();
  if (!client) { _lastStatus = "unavailable"; return null; }
  const variants = barcodeVariants(code.trim());
  // Query all variants in one round-trip
  const placeholders = variants.map(() => "?").join(", ");
  try {
    // Fetch a few matching variants (not LIMIT 1) so the read-time garbage guard can skip a poisoned
    // row and still return a clean sibling variant if one exists (QA Task 5 defense-in-depth).
    const result = await client.execute({
      sql: `SELECT barcode, product_name, brand, category FROM retail WHERE barcode IN (${placeholders}) LIMIT 5`,
      args: variants,
    });
    for (const row of result.rows) {
      const productName = (row.product_name as string) || "";
      const brand = (row.brand as string) || "";
      // Skip garbled (run-on multi-brand / ingredient-blob) rows: a drifted Turso mirror may still be
      // dirty even after the local rebuild, so never serve one as a trusted hit.
      if (isGarbledCorpusRow(productName, brand)) continue;
      _lastStatus = "turso_hit";
      return {
        productName,
        brand,
        category: (row.category as string) || "",
        barcode: row.barcode as string,
      };
    }
    _lastStatus = "turso_miss";
  } catch (e) {
    console.warn("[retail-knowledge] Turso query error:", (e as Error).message);
    _lastStatus = "turso_error";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Look up a barcode in the retail product index. Tries local SQLite first, then Turso. */
export function lookupRetailBarcode(code: string): RetailLookupResult | null {
  // SQLite is synchronous and faster — try it first
  const sqliteResult = lookupSqlite(code);
  if (sqliteResult) return sqliteResult;

  // Turso is async but we need a sync return for the existing call site.
  // Return null here; the async version is used by the API route.
  return null;
}

/** Async version for the API route — tries SQLite first, then Turso over the network. */
export async function lookupRetailBarcodeAsync(code: string): Promise<RetailLookupResult | null> {
  const sqliteResult = lookupSqlite(code);
  if (sqliteResult) return sqliteResult;
  return lookupTurso(code);
}

/** For tests: reset caches so the next lookup re-initializes. */
export function __resetRetailKnowledgeCacheForTests(): void {
  _stmtLookup = null;
  _sqliteChecked = false;
  _tursoClient = null;
  _lastStatus = "idle";
}
