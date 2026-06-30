// Retail product knowledge index: 4M+ products from Open Food Facts.
// Barcode -> productName, brand, category. SERVER-SIDE ONLY.
// Uses SQLite for microsecond lookups with ~5MB memory.
//
// The JSON source file stays in git (Git LFS) for regeneration but is NOT loaded at runtime.
// Run `npm run build:knowledge-db` to generate the SQLite DB from the JSON indexes.

import { getKnowledgeDb } from "@/server/knowledgeDb";

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

// SQLite prepared statement (created lazily, cached for process lifetime)
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
  const stmt = getStmtLookup();
  if (!stmt) return null;

  const variants = barcodeVariants(code.trim());
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

/** For tests: reset caches so the next lookup re-initializes. */
export function __resetRetailKnowledgeCacheForTests(): void {
  _stmtLookup = null;
}
