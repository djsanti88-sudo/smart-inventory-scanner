// scripts/dt-harvest/lib/applyTransform.mjs
// Pure transforms for Task 6 (apply.mjs): turn raw harvested.jsonl lines into guard-eligible
// TireRow objects, and map a TireRow onto the REAL corpus row schema found in
// src/server/tire-knowledge/tireKnowledge.generated.json (barcodeIndex[barcode] = {...}).
//
// The real corpus schema differs from lib/merge.mjs's assumed CorpusRow columns (no top-level
// array, no `source`/`current_status` exactly matching the merge.mjs shape in the same way) so
// this module is the single place that adapts between "TireRow from the scraper" and "the row
// shape actually stored in tireKnowledge.generated.json". lib/merge.mjs itself is not edited.
//
// Untrusted input: every line of harvested.jsonl came from scraped HTML (see parseProduct.mjs's
// semantic-firewall note). This module only parses and maps fields; it never executes or obeys
// any text found inside a line.

import { guardRow } from "./merge.mjs";

/**
 * @typedef {{
 *   gtin: string,
 *   brand: string,
 *   model: string,
 *   size: string,
 *   loadIndex: string,
 *   speedRating: string,
 *   partNumber: string,
 *   imageUrl: string,
 *   sourceUrl: string,
 *   fetchedAt: string,
 *   guard?: "ok" | string,
 * }} HarvestedLine
 */

/** Count non-empty (non-null/undefined/"") fields of a TireRow-shaped object. */
function fieldCompleteness(row) {
  return Object.values(row).filter((v) => v !== null && v !== undefined && v !== "").length;
}

/**
 * Parse raw JSONL lines (one JSON object per line) into HarvestedLine objects, keeping only
 * lines that are valid JSON, pass the guard, and have a non-empty `gtin`. Blank lines and
 * lines that fail to parse are skipped silently (worker files may have trailing newlines).
 * Within the resulting set, dedupes by gtin: when the same gtin appears more than once, the
 * entry with higher field-completeness wins (ties keep the first-seen entry).
 *
 * The `guard` field in each raw line is a STALE stamp written ONCE at harvest time. To let a
 * later corrected brand-family / prefix map recover rows that were only rejected as
 * `prefix_conflict` under old rules, this function RE-EVALUATES guardRow LIVE for those rows
 * when `options.prefixMap` is supplied - admitting them if they now pass. Rows stamped for a
 * GENUINE reason (`invalid_check_digit`, a bad GS1 check digit that is prefixMap-independent and
 * always bad) STAY dropped, and prefix_conflict rows that STILL conflict under current rules stay
 * dropped. When no `options` (or no prefixMap) is given, behavior is the original strict
 * `guard === "ok"` filter (a prefix_conflict row cannot be re-evaluated without a map, so it
 * stays dropped) - fully backward compatible with existing callers.
 *
 * @param {string[]} lines
 * @param {{ prefixMap?: Record<string, string | string[]>, sameBrandFamily?: (a: string, b: string) => boolean }} [options]
 * @returns {HarvestedLine[]}
 */
export function jsonlLinesToRows(lines, options = {}) {
  const byGtin = new Map();
  const { prefixMap, sameBrandFamily } = options || {};
  const canReguard = prefixMap && typeof prefixMap === "object";

  for (const line of lines || []) {
    const trimmed = (line ?? "").trim();
    if (!trimmed) continue;

    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;

    if (parsed.guard !== "ok") {
      // Only a stale `prefix_conflict` stamp is eligible for live re-evaluation, and only when a
      // prefixMap is available to re-evaluate against. Any other non-ok reason (e.g.
      // invalid_check_digit) is a genuine, prefixMap-independent rejection and stays dropped.
      if (!(canReguard && parsed.guard === "prefix_conflict")) continue;
      const reguard = guardRow(parsed, prefixMap, sameBrandFamily);
      if (!reguard.ok) continue; // still conflicts under current rules -> stays dropped
    }

    const gtin = (parsed.gtin ?? "").toString().trim();
    if (!gtin) continue;

    const current = byGtin.get(gtin);
    if (!current) {
      byGtin.set(gtin, parsed);
      continue;
    }
    if (fieldCompleteness(parsed) > fieldCompleteness(current)) {
      byGtin.set(gtin, parsed);
    }
  }

  return Array.from(byGtin.values());
}

/** Derive the corpus barcode_type from the GTIN's digit length: 12 -> upc, 13 -> ean, 14 -> gtin14. */
export function barcodeTypeFor(gtin) {
  const digits = (gtin || "").toString().replace(/\D/g, "");
  if (digits.length === 12) return "upc";
  if (digits.length === 13) return "ean";
  if (digits.length === 14) return "gtin14";
  return "unknown";
}

function normalizeToken(value) {
  return (value || "").toString().trim().toLowerCase();
}

/**
 * Map a harvested TireRow onto the REAL corpus row schema (the shape stored at
 * tireKnowledge.generated.json's barcodeIndex[barcode]), NOT lib/merge.mjs's assumed columns.
 * Always stamps source "discounttire" and current_status "active_retail" per the plan's Task 6
 * corpus-provenance requirement, even though those exact field names/values are additive to the
 * real schema (the real schema has no `source` column today; downstream code that does not know
 * about it simply ignores the extra field).
 *
 * @param {HarvestedLine} tireRow
 * @returns {object} corpus-schema row
 */
export function toCorpusRow(tireRow) {
  const barcode = (tireRow.gtin || "").toString().trim();
  const brand = (tireRow.brand || "").toString().trim();
  const model = (tireRow.model || "").toString().trim();
  const rawSize = (tireRow.size || "").toString().trim();

  return {
    canonical_product_uid: "", // filled by apply.mjs once merged with corpus-wide uniqueness rules
    brand,
    brand_normalized: normalizeToken(brand),
    model,
    model_normalized: normalizeToken(model),
    size: rawSize,
    raw_size_text: rawSize,
    load_index: (tireRow.loadIndex || "").toString().trim(),
    speed_rating: (tireRow.speedRating || "").toString().trim(),
    load_range: "",
    type: "",
    season: "",
    manufacturer_part_number: (tireRow.partNumber || "").toString().trim(),
    barcode,
    barcode_type: barcodeTypeFor(barcode),
    confidence: "verified_1src_strong",
    current_status: "active_retail",
    usable_for: "auto_count_candidate",
    field_completeness_score: "",
    missing_fields: "",
    source_count: 1,
    source: "discounttire",
  };
}
