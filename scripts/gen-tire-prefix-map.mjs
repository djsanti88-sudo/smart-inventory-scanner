// Generate a tire-specific 7-digit-prefix -> brand map from the trusted tire knowledge DB.
//
// Why: the general catalog-derived firewall map (brandPrefixMap.json) misses tire GS1 prefixes
// (e.g. 0929711 = Bridgestone) because it is built from the retail catalog, not the tire corpus.
// The confirmed live Go-UPC error 2026-07-08 (barcode prefix 0929711 = Bridgestone family,
// Go-UPC answered Westlake) is exactly the class this map lets the firewall catch.
//
// Keying: `code.replace(/\D/g,'').slice(0,7)` - IDENTICAL to brandPrefixGeneral.prefixBrandConflict,
// so the two maps compose cleanly at the same 7-digit granularity.
//
// Rule: for each prefix, tally brand votes across all tire rows. Keep the prefix -> top brand ONLY
// when the top brand has >= 5 rows (>= MIN_ROWS). This is a high-signal, low-false-positive gate:
// same-company siblings (bridgestone/firestone/dayton) sit under one prefix but the firewall's
// sameBrandFamily table absorbs those, so picking the dominant brand here is safe.
//
// Output: src/services/catalog/tirePrefixMap.generated.json  (committed).
// Run:    node scripts/gen-tire-prefix-map.mjs

import Database from "better-sqlite3";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "..", "src", "server", "knowledge.generated.db");
const OUT_PATH = join(__dirname, "..", "src", "services", "catalog", "tirePrefixMap.generated.json");

const MIN_ROWS = 5; // the top brand for a prefix must have >= this many rows to be trusted

function prefixOf(barcode) {
  const digits = String(barcode ?? "").replace(/\D/g, "");
  if (digits.length < 8) return null; // too short to carry a 7-digit company prefix
  return digits.slice(0, 7);
}

function normBrand(b) {
  return String(b ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(tire|tires|tyre|tyres|inc|llc|co|company)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const db = new Database(DB_PATH, { readonly: true });
const rows = db
  .prepare("SELECT barcode, brand FROM tires WHERE barcode IS NOT NULL AND brand IS NOT NULL")
  .all();
db.close();

// prefix -> Map(brand -> count)
const votes = new Map();
for (const { barcode, brand } of rows) {
  const prefix = prefixOf(barcode);
  const b = normBrand(brand);
  if (!prefix || !b) continue;
  let tally = votes.get(prefix);
  if (!tally) {
    tally = new Map();
    votes.set(prefix, tally);
  }
  tally.set(b, (tally.get(b) ?? 0) + 1);
}

const map = {};
let kept = 0;
for (const [prefix, tally] of votes) {
  let topBrand = null;
  let topCount = 0;
  for (const [brand, count] of tally) {
    if (count > topCount) {
      topCount = count;
      topBrand = brand;
    }
  }
  if (topBrand && topCount >= MIN_ROWS) {
    map[prefix] = topBrand;
    kept += 1;
  }
}

// Deterministic key order so the committed file has a stable diff.
const sorted = {};
for (const key of Object.keys(map).sort()) sorted[key] = map[key];

writeFileSync(OUT_PATH, JSON.stringify(sorted, null, 2) + "\n", "utf8");

console.log(`Scanned ${rows.length} tire rows, ${votes.size} distinct prefixes.`);
console.log(`Kept ${kept} prefixes (top brand >= ${MIN_ROWS} rows).`);
console.log(`0929711 -> ${sorted["0929711"] ?? "(absent)"}`);
console.log(`Wrote ${OUT_PATH}`);
