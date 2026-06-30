// Retail product knowledge index: 4M+ products from Open Food Facts, loaded ONCE at server start.
// Barcode -> [productName, brand, category]. Lazy-loaded, cached in-memory.
// SERVER-SIDE ONLY (never imported by client code).

import { readFileSync } from "node:fs";
import { join } from "node:path";

// Compact format: barcode -> [name, brand?, category?]
type RetailEntry = [string, string?, string?];
type RetailIndex = Record<string, RetailEntry>;

let cached: RetailIndex | null = null;

function loadIndex(): RetailIndex {
  if (cached) return cached;
  try {
    const raw = readFileSync(
      join(process.cwd(), "src", "server", "retail-knowledge", "retailKnowledge.generated.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw);
    cached = parsed.index ?? {};
    console.log(`[retail-knowledge] Loaded ${Object.keys(cached!).length} products`);
  } catch (e) {
    console.warn("[retail-knowledge] Index not found or unreadable, retail lookup disabled:", (e as Error).message);
    cached = {};
  }
  return cached!;
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

/** Look up a barcode in the retail product index. Returns null on miss. Tries zero-padded variants. */
export function lookupRetailBarcode(code: string): RetailLookupResult | null {
  const idx = loadIndex();
  const variants = barcodeVariants(code.trim());
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

/** For tests: reset the cached index so the next lookup re-reads from disk. */
export function __resetRetailKnowledgeCacheForTests(): void {
  cached = null;
}
