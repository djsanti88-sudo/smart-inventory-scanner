// Runtime garbage-detector for retail-corpus (Open Food Facts) rows. SERVER-SIDE decode/suggestion path.
//
// WHY (QA 2026-07-15, Task 5): OFF's `brands` field is a community-editable comma-separated tag list.
// Barcodes reused across unrelated OFF placeholder/test submissions produced poisoned corpus rows whose
// brand is a run-on tag list ("Fleischer, Selbst gemacht, The Wholesome Bar, Uberti") or whose name is
// an ingredient/nutrition blob. Such a row must never contribute a verifying vote to the decode
// consensus (parallelResolve findConsensus), and must never be served as a trusted read-time hit
// (retailKnowledgeIndex). The ingest scripts (scripts/retailIngestRules.mjs) now sanitize at build time,
// but this is defense-in-depth: a not-yet-rebuilt local DB or a drifted Turso mirror may still be dirty.
//
// This mirrors scripts/retailIngestRules.mjs's isGarbledText, kept as a small independent TS copy so the
// server bundle has no dependency on a build-only .mjs script.

/** Max length for a real product NAME (chars). Above this is a run-on / concatenated blob. */
export const MAX_CORPUS_NAME_LEN = 120;
/** Max length for a real BRAND (chars). Never a real brand above this. */
export const MAX_CORPUS_BRAND_LEN = 80;

/**
 * True when a corpus name/brand string is garbled run-on text rather than a single real identity:
 * over the length cap, a comma-separated run-on tag list, or far more words than any real name/brand.
 * Deliberately conservative - only clear garbling signals, so real names/brands pass.
 */
function looksGarbled(text: string, maxLen: number): boolean {
  const s = (text ?? "").trim();
  if (!s) return false;
  if (s.length > maxLen) return true;
  // A run-on with many comma-separated fragments is a concatenated tag list / blob, not one identity.
  if (s.split(",").length >= 4) return true;
  // An ingredient list / nutrition blob run into the field has far more words than any real name.
  if (s.split(/\s+/).filter(Boolean).length >= 15) return true;
  return false;
}

/**
 * True when a corpus row (product name + optional brand) is garbled and must NOT be trusted as a
 * verifying/consensus vote or served as a clean read-time hit. A garbled NAME condemns the whole row;
 * a garbled BRAND alone also condemns it (the brand tag list is the primary poisoning signal).
 */
export function isGarbledCorpusRow(name: string, brand = ""): boolean {
  if (looksGarbled(name, MAX_CORPUS_NAME_LEN)) return true;
  if (brand && looksGarbled(brand, MAX_CORPUS_BRAND_LEN)) return true;
  return false;
}
