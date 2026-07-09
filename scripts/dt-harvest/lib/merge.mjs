// scripts/dt-harvest/lib/merge.mjs
// Poison guard + cross-source-safe merge for the Discount Tire harvest (Task 3).
// Pure, no imports beyond this file. Untrusted scraped rows never enter the corpus
// with a bad GTIN check digit or a brand that conflicts with a known single-brand
// GS1 prefix, and a duplicate GTIN from another source is never silently overwritten.

/** GS1 mod-10 check digit over the full code (last digit is the check digit).
 * Logic shape mirrors src/services/upc/gtin.ts isValidCheckDigit (reference only, not imported).
 */
function isGtinShaped(code) {
  const t = (code ?? "").trim();
  return /^\d{8}$|^\d{12,14}$/.test(t);
}

function isValidCheckDigit(code) {
  const t = (code ?? "").trim();
  if (!isGtinShaped(t)) return false;
  const digits = t.split("").map(Number);
  const check = digits.pop();
  let sum = 0;
  // weights 3,1,3,... from the RIGHTMOST payload digit
  for (let i = digits.length - 1, w = 3; i >= 0; i--, w = 4 - w) sum += digits[i] * w;
  return (10 - (sum % 10)) % 10 === check;
}

function normalizeBrand(b) {
  return (b || "").toString().trim().toLowerCase();
}

/**
 * True when the barcode's 7-digit GS1 company prefix maps to a known brand list
 * AND row.brand is not (case/whitespace-insensitively) one of those brands.
 * Unknown/unmapped prefixes and empty brands never conflict.
 */
function hasPrefixConflict(gtin, brand, prefixMap) {
  const digits = (gtin || "").replace(/\D/g, "");
  if (digits.length < 7) return false;
  const prefix = digits.slice(0, 7);
  const expected = prefixMap ? prefixMap[prefix] : undefined;
  if (!expected || (Array.isArray(expected) && expected.length === 0)) return false;
  const expectedBrands = (Array.isArray(expected) ? expected : [expected]).map(normalizeBrand);
  const got = normalizeBrand(brand);
  if (!got) return false;
  return !expectedBrands.includes(got);
}

/**
 * Reject invalid GS1 check digits and catalog-derived brand-prefix conflicts.
 * prefixMap: Record<sevenDigitPrefix, brand | brand[]>.
 */
export function guardRow(row, prefixMap) {
  if (!isValidCheckDigit(row?.gtin)) {
    return { ok: false, reason: "invalid_check_digit" };
  }
  if (hasPrefixConflict(row.gtin, row.brand, prefixMap)) {
    return { ok: false, reason: "prefix_conflict" };
  }
  return { ok: true };
}

function barcodeTypeFor(gtin) {
  const digits = (gtin || "").replace(/\D/g, "");
  if (digits.length === 12) return "upc";
  if (digits.length === 13) return "ean";
  if (digits.length === 14) return "gtin14";
  return "unknown";
}

/** Count non-empty (non-null/undefined/"") fields, matching the corpus completeness convention. */
function fieldCompleteness(row) {
  return Object.values(row).filter((v) => v !== null && v !== undefined && v !== "").length;
}

function toCorpusRow(tireRow) {
  return {
    barcode: (tireRow.gtin || "").trim(),
    brand: tireRow.brand || "",
    model: tireRow.model || "",
    size: tireRow.size || "",
    load_index: tireRow.loadIndex || "",
    speed_rating: tireRow.speedRating || "",
    barcode_type: barcodeTypeFor(tireRow.gtin),
    source: "discounttire",
    current_status: "active_retail",
    manufacturer_part_number: tireRow.partNumber || "",
    canonical_product_uid: tireRow.canonicalProductUid || "",
  };
}

/**
 * Merge guarded incoming TireRow[] into the existing CorpusRow[] corpus.
 * - Guard failures (invalid check digit / prefix conflict) are skipped with that reason.
 * - A GTIN already present from ANOTHER source: existing wins, skip "cross_source_duplicate".
 * - A GTIN duplicated within discounttire (existing row already source:"discounttire"),
 *   or duplicated within this incoming batch: higher field-completeness wins; the loser is
 *   skipped as "less_complete_duplicate".
 * Never mutates existing or incoming.
 */
export function mergeRows(existing, incoming, prefixMap) {
  const merged = existing.map((row) => ({ ...row }));
  const byBarcode = new Map(merged.map((row) => [row.barcode, row]));
  const skipped = [];
  let added = 0;

  for (const tireRow of incoming || []) {
    const guard = guardRow(tireRow, prefixMap);
    if (!guard.ok) {
      skipped.push({ row: tireRow, reason: guard.reason });
      continue;
    }

    const candidate = toCorpusRow(tireRow);
    const current = byBarcode.get(candidate.barcode);

    if (!current) {
      byBarcode.set(candidate.barcode, candidate);
      merged.push(candidate);
      added += 1;
      continue;
    }

    if (current.source !== "discounttire") {
      // duplicate GTIN already present from ANOTHER source -> keep existing, never overwrite
      skipped.push({ row: tireRow, reason: "cross_source_duplicate" });
      continue;
    }

    // duplicate within discounttire: higher field-completeness wins
    if (fieldCompleteness(candidate) > fieldCompleteness(current)) {
      const idx = merged.indexOf(current);
      merged[idx] = candidate;
      byBarcode.set(candidate.barcode, candidate);
      added += 1;
    } else {
      skipped.push({ row: tireRow, reason: "less_complete_duplicate" });
    }
  }

  return { merged, added, skipped };
}
