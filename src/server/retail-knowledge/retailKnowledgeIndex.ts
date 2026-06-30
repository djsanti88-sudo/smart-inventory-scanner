// Retail product knowledge index: 4M+ products from Open Food Facts.
// Barcode -> [productName, brand, category]. SERVER-SIDE ONLY.
//
// Primary: SQLite (microsecond lookups, ~5MB memory, no cold-start parse).
// Fallback: JSON (original 247MB file, loaded into memory — only used when the DB doesn't exist).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getKnowledgeDb } from "@/server/knowledgeDb";

// Compact format: barcode -> [name, brand?, category?]
type RetailEntry = [string, string?, string?];
type RetailIndex = Record<string, RetailEntry>;

// JSON fallback cache
let jsonCached: RetailIndex | null = null;

function loadJsonIndex(): RetailIndex {
  if (jsonCached) return jsonCached;
  try {
    const raw = readFileSync(
      join(process.cwd(), "src", "server", "retail-knowledge", "retailKnowledge.generated.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw);
    jsonCached = parsed.index ?? {};
    console.log(`[retail-knowledge] JSON fallback: loaded ${Object.keys(jsonCached!).length} products`);
  } catch (e) {
    console.warn("[retail-knowledge] JSON index not found, retail lookup disabled:", (e as Error).message);
    jsonCached = {};
  }
  return jsonCached!;
}

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
// SQLite prepared statement (created lazily, cached for process lifetime)
// ---------------------------------------------------------------------------
let _stmtLookup: ReturnType<import("better-sqlite3").Database["prepare"]> | null = null;

function getStmtLookup() {
  if (_stmtLookup) return _stmtLookup;
  const db = getKnowledgeDb();
  if (!db) return null;
  _stmtLookup = db.prepare("SELECT barcode, product_name, brand, category FROM retail WHERE barcode = ?");
  return _stmtLookup;
}

/** Look up a barcode in the retail product index. Returns null on miss. Tries zero-padded variants. */
export function lookupRetailBarcode(code: string): RetailLookupResult | null {
  const variants = barcodeVariants(code.trim());

  // SQLite fast path: try each variant (~50 microseconds per indexed lookup)
  const stmt = getStmtLookup();
  if (stmt) {
    for (const v of variants) {
      const row = stmt.get(v) as { barcode: string; product_name: string; brand: string; category: string } | undefined;
      if (row) {
        return {
          productName: row.product_name,
          brand: row.brand,
          category: row.category,
          barcode: row.barcode,
        };
      }
    }
    return null;
  }

  // JSON fallback
  const idx = loadJsonIndex();
  for (const v of variants) {
    const entry = idx[v];
    if (entry) {
      return {
        productName: entry[0],
        brand: entry[1] ?? "",
        category: entry[2] ?? "",
        barcode: v,
      };
    }
  }
  return null;
}

/** For tests: reset caches so the next lookup re-initializes. */
export function __resetRetailKnowledgeCacheForTests(): void {
  jsonCached = null;
  _stmtLookup = null;
}
