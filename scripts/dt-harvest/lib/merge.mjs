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
 *
 * `sameBrandFamily` (optional): a pure `(a, b) => boolean` that returns true when two brands
 * belong to the SAME corporate family (see src/services/catalog/brandFamilies.ts). When supplied,
 * a brand that differs from the registered prefix brand does NOT conflict if the two are the same
 * family - this is what lets a corrected family later recover a previously-conflicting row. When
 * absent (default), behavior is unchanged: any different brand conflicts. Injected rather than
 * imported because this .mjs pipeline cannot import the server-only TS family table (same pattern
 * as backfill.mjs's normPartKey reimplementation).
 */
function hasPrefixConflict(gtin, brand, prefixMap, sameBrandFamily) {
  const digits = (gtin || "").replace(/\D/g, "");
  if (digits.length < 7) return false;
  const prefix = digits.slice(0, 7);
  const expected = prefixMap ? prefixMap[prefix] : undefined;
  if (!expected || (Array.isArray(expected) && expected.length === 0)) return false;
  const expectedBrands = (Array.isArray(expected) ? expected : [expected]).map(normalizeBrand);
  const got = normalizeBrand(brand);
  if (!got) return false;
  if (expectedBrands.includes(got)) return false;
  // Not a literal brand match: it is still NOT a conflict if the row's brand is in the same
  // corporate family as any registered brand for this prefix.
  if (typeof sameBrandFamily === "function") {
    for (const expectedBrand of expectedBrands) {
      if (sameBrandFamily(expectedBrand, got)) return false;
    }
  }
  return true;
}

/**
 * Reject invalid GS1 check digits and catalog-derived brand-prefix conflicts.
 * prefixMap: Record<sevenDigitPrefix, brand | brand[]>.
 * sameBrandFamily (optional): `(a, b) => boolean` same-corporate-family check; when provided,
 *   a same-family brand does not trigger a prefix conflict (see hasPrefixConflict).
 */
export function guardRow(row, prefixMap, sameBrandFamily) {
  if (!isValidCheckDigit(row?.gtin)) {
    return { ok: false, reason: "invalid_check_digit" };
  }
  if (hasPrefixConflict(row.gtin, row.brand, prefixMap, sameBrandFamily)) {
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

/**
 * Count non-empty (non-null/undefined/"") fields, matching the corpus completeness convention.
 * [AM-R2] `part_number_source` is a provenance tag added ONLY by field-level enrichment
 * (see mergeRows' cross_source_duplicate branch) - it must NEVER count toward completeness,
 * or enrichment could flip a future less_complete_duplicate decision it has no business
 * influencing. Excluded here rather than ordering calls, so every call site is safe by
 * construction regardless of when enrichment ran.
 */
function fieldCompleteness(row) {
  return Object.entries(row).filter(
    ([key, v]) => key !== "part_number_source" && v !== null && v !== undefined && v !== ""
  ).length;
}

/**
 * [AM-R2] Field-level enrichment: fill BLANK fields of the existing row from the guarded
 * incoming candidate row, part number first, tagging its provenance. Existing non-blank fields
 * are NEVER overwritten. Returns a new row object (never mutates `existingRow`); returns the
 * same reference untouched when nothing was blank to fill.
 */
function enrichRow(existingRow, candidateRow) {
  let changed = false;
  const next = { ...existingRow };

  const isBlank = (v) => v === null || v === undefined || v === "";

  // Part number first (the root-cause field this fix exists to stop discarding).
  if (isBlank(next.manufacturer_part_number) && !isBlank(candidateRow.manufacturer_part_number)) {
    next.manufacturer_part_number = candidateRow.manufacturer_part_number;
    next.part_number_source = candidateRow.source;
    changed = true;
  }

  for (const [key, value] of Object.entries(candidateRow)) {
    if (key === "manufacturer_part_number" || key === "source" || key === "current_status") continue;
    if (isBlank(next[key]) && !isBlank(value)) {
      next[key] = value;
      changed = true;
    }
  }

  return changed ? next : existingRow;
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
 * - A GTIN already present from ANOTHER source: existing row still WINS every non-blank field;
 *   [AM-R2] field-level enrichment fills the existing row's BLANK fields from the guarded
 *   incoming row (part number first, tagged with `part_number_source`). Skipped as
 *   "cross_source_duplicate" either way (the incoming row is never added as its own row).
 * - A GTIN duplicated within discounttire (existing row already source:"discounttire"),
 *   or duplicated within this incoming batch: higher field-completeness wins; the loser is
 *   skipped as "less_complete_duplicate". `part_number_source` never counts toward completeness
 *   (AM-R2), so enrichment on one row can never flip this decision for another.
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
      // duplicate GTIN already present from ANOTHER source -> existing row still WINS every
      // non-blank field, but [AM-R2] field-level enrichment fills the existing row's BLANK
      // fields from the guarded incoming row (part number first), tagging provenance. The
      // incoming row itself is still never added as its own row - recorded as a skip.
      const enriched = enrichRow(current, candidate);
      if (enriched !== current) {
        const idx = merged.indexOf(current);
        merged[idx] = enriched;
        byBarcode.set(candidate.barcode, enriched);
      }
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
