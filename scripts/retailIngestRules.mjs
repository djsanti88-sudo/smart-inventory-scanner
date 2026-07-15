// Pure, dependency-free ingest-sanitize rules for the retail (Open Food Facts) knowledge index.
// Shared by the generator (scripts/build-retail-knowledge.mjs, reads retail_off.jsonl) and the
// JSON->SQLite converter (scripts/build-knowledge-db.mjs, reads the generated JSON) so BOTH ingest
// paths clean the same way and can be unit-tested directly (scripts/retailIngestRules.test.mjs).
//
// WHY: OFF's `brands` field is a community-editable comma-separated tag list. A barcode reused across
// unrelated OFF placeholder/test submissions (e.g. the well-known dummy UPC 123456789012) produced
// poisoned rows like 0123456789012 -> brand "Fleischer, Selbst gemacht, The Wholesome Bar, Uberti".
// That garbage then reached the decode consensus path and could be hand-set verified without ever
// passing EvidenceVerifier (QA 2026-07-15, Task 5). These rules stop the poison at ingest time.

/** Max length for a real product NAME (chars). Above this is a strong garbling signal (run-on text,
 *  embedded ingredient lists / nutrition facts). Real product names are well under this. */
export const MAX_NAME_LEN = 120;
/** Max length for a real BRAND (chars). Never a real brand above this; a run-on tag list or an
 *  ingredient/address blob concatenated into the field. */
export const MAX_BRAND_LEN = 80;

/**
 * Keep ONLY the first Open Food Facts brand tag. OFF `brands` is a comma-separated tag list; the
 * correct brand is the first, the rest are aliases/retailers/garbage. Mirrors the sibling scripts
 * (analyze-prefix-db.mjs, phase05-prefix-cleanup.mjs) which already do `.split(",")[0].trim()`.
 */
export function firstBrandTag(brands) {
  return (brands ?? "").toString().split(",")[0].trim();
}

// GS1 / OFF placeholder + test barcodes. These are never a real product; many unrelated OFF
// submissions reuse them, and the "keep the longest name+brand" dedup deterministically selects the
// most garbled submission. Matched on the digits-only form so padded (0123456789012 / 00123456789012)
// and unpadded (123456789012) variants are all caught.
const DUMMY_BARCODE_RE = /^0*(?:123456789012|1234567890128|000000000000|00000000000000|999999999999|9999999999999)$/;

/** True when the barcode is a known GS1/OFF dummy/placeholder/test code (never index it). */
export function isDummyBarcode(code) {
  const d = (code ?? "").toString().trim();
  if (!/^\d+$/.test(d)) return false;
  // All-zero or all-nine of any indexable length (8-14) is always a placeholder.
  if (/^0{8,14}$/.test(d) || /^9{12,14}$/.test(d)) return true;
  return DUMMY_BARCODE_RE.test(d);
}

/**
 * True when a name/brand string looks like garbled run-on text rather than a real identity: over the
 * length cap, or a long comma-separated run-on (an ingredient list / nutrition blob concatenated in).
 * Deliberately conservative - only clear garbling signals, so real long-ish names pass.
 */
export function isGarbledText(text, maxLen = MAX_BRAND_LEN) {
  const s = (text ?? "").toString().trim();
  if (!s) return false;
  if (s.length > maxLen) return true;
  // A run-on with many comma-separated fragments is a concatenated tag list / blob, not one identity.
  if (s.split(",").length >= 4) return true;
  // An ingredient list / nutrition blob run into the field has far more words than any real product
  // name or brand. Real names/brands are well under this; 15+ words is a strong garbling signal.
  if (s.split(/\s+/).filter(Boolean).length >= 15) return true;
  return false;
}

/**
 * Sanitize one retail index entry [name, brand, category] for a barcode. Returns a cleaned
 * [name, brand?, category?] array (undefined for empty fields, matching the generator's compact
 * format), or null when the row must be DROPPED (dummy barcode, unusable/garbled name).
 */
export function sanitizeRetailEntry(code, entry) {
  if (isDummyBarcode(code)) return null;

  const rawName = (entry?.[0] ?? "").toString().trim();
  if (!rawName || rawName.length < 3) return null;
  // A garbled/over-length NAME means the whole row is untrustworthy - drop it (do not truncate a
  // name into a lie).
  if (rawName.length > MAX_NAME_LEN) return null;
  if (isGarbledText(rawName, MAX_NAME_LEN)) return null;

  let brand = firstBrandTag(entry?.[1]);
  // If even the FIRST brand tag is garbled/over-length, drop the brand (keep the row; name is still
  // usable). A brand is optional in the compact format.
  if (brand && (brand.length > MAX_BRAND_LEN || isGarbledText(brand))) brand = "";

  const category = (entry?.[2] ?? "").toString().split(",")[0].trim();

  return [rawName, brand || undefined, category || undefined];
}
