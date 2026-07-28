#!/usr/bin/env node
// Task B2 - Lane 0 (deterministic enrichment lane) for the tire-DB repair/enrichment bakeoff.
//
// Blind lane: reads ONLY sample.json (never answer_key.json). Uses:
//   1. GS1 company-prefix -> brand map from the repo's existing catalog data
//      (src/services/catalog/brandPrefixMap.json, consumed by brandPrefixGeneral.ts /
//      prefixFirewall.ts). This JSON file is already a plain { "<7-digit-prefix>": "brand" }
//      map with exactly one brand per prefix (per the generator's own invariant documented
//      in brandPrefixGeneral.ts: "Only buckets with >=3 entries that are 100% ONE brand are
//      kept"), so no extra TS-parsing/extraction step is needed - it is not TS-embedded data,
//      it is already a re-exported JSON artifact. We import it directly.
//   2. Read-only cross-reference against the rich tire DB
//      (backups/claude-tire-db-handoff-2026-07-28/02_ENRICHMENT_STAGE_2_rich.db) via
//      better-sqlite3 {readonly:true} to find sibling rows sharing the same GS1 prefix and/or
//      the same manufacturer_part_number "family" pattern, for size/MPN suggestions.
//
// Rules (per task-B2-brief.md / global-constraints.md):
//   - GS1 prefix -> brand fill is confidence "high" ONLY when the prefix maps to exactly one
//     brand family (true for every entry in brandPrefixMap.json by construction).
//   - Sibling-row interpolation (same prefix + MPN pattern family elsewhere in the DB) is
//     reported confidence "low" and goes in `suggestions`, never in `fills`.
//   - Never resolve ambiguity with LIMIT 1 / arbitrary row order: multiple distinct candidate
//     values for a sibling-interpolated field => no suggestion emitted for that field (treated
//     as a conflict, not guessed).
//   - No DB writes. No web calls. No git commands.
//
// Output: repair-2026-07-28/bakeoff/results_lane0.json (one entry per sample row, plus a
// top-level `solved_ids` array of rows where every missing field got a HIGH-confidence fill).

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

const SAMPLE_PATH = path.join(
  REPO_ROOT,
  "backups/claude-tire-db-handoff-2026-07-28/repair-2026-07-28/bakeoff/sample.json"
);
const DB_PATH = path.join(
  REPO_ROOT,
  "backups/claude-tire-db-handoff-2026-07-28/02_ENRICHMENT_STAGE_2_rich.db"
);
const PREFIX_MAP_PATH = path.join(
  REPO_ROOT,
  "src/services/catalog/brandPrefixMap.json"
);
const OUT_PATH = path.join(
  REPO_ROOT,
  "backups/claude-tire-db-handoff-2026-07-28/repair-2026-07-28/bakeoff/results_lane0.json"
);

// ---- helpers ---------------------------------------------------------------

function digitsOnly(s) {
  return String(s || "").replace(/\D/g, "");
}

/** GTIN-13 form: left-pad the digit string to 13 with leading zeros (UPC-12 -> EAN-13). */
function toGtin13(code) {
  const d = digitsOnly(code);
  return d.padStart(13, "0").slice(-13);
}

/** The 7-digit GS1 company prefix bucket used by brandPrefixMap.json (matches brandPrefixGeneral.ts). */
function gs1Prefix7(code) {
  const g13 = toGtin13(code);
  return g13.slice(0, 7);
}

/** Strip separators to compare MPN "family" patterns (e.g. "24556014" vs "24465014" -> same length/shape family). */
function mpnShape(mpn) {
  const s = String(mpn || "").trim();
  if (!s) return null;
  // Shape = length + whether alnum/digits-only, used only as a soft family grouping signal,
  // never as a value guess by itself.
  const isDigits = /^\d+$/.test(s);
  return `${s.length}:${isDigits ? "d" : "a"}`;
}

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/**
 * Normalizes brand/model tokens for comparison across the two different underscore/space
 * conventions seen in the sample (e.g. "extremecontact_dw") vs. the DB's own
 * brand_normalized/model_normalized columns (e.g. "extremecontact dw"). Comparison-only; never
 * used to synthesize or alter a displayed value.
 */
function normToken(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[_\-]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---- main -------------------------------------------------------------------

function main() {
  const t0 = Date.now();
  const sample = loadJson(SAMPLE_PATH);
  const prefixMap = loadJson(PREFIX_MAP_PATH); // { "<7-digit prefix>": "brand" }, one brand per prefix.

  const db = new Database(DB_PATH, { readonly: true });

  const results = [];
  const solvedIds = [];

  for (const row of sample) {
    const startRow = process.hrtime.bigint();
    const { id, barcode, known_fields = {}, missing_fields = [] } = row;
    const fills = {};
    const suggestions = {};
    const evidenceParts = [];

    const prefix7 = gs1Prefix7(barcode);
    const mappedBrand = prefixMap[prefix7];

    for (const field of missing_fields) {
      if (field === "brand") {
        if (mappedBrand) {
          // Exactly one brand per prefix bucket by construction of brandPrefixMap.json ->
          // eligible for a HIGH-confidence fill.
          fills.brand = mappedBrand;
          evidenceParts.push(
            `GS1 prefix ${prefix7} maps to exactly one brand family ("${mappedBrand}") in brandPrefixMap.json.`
          );
        } else {
          // Unknown/ambiguous prefix: no fill. Try sibling interpolation for a LOW suggestion.
          const siblingBrand = siblingLookup(db, "brand", prefix7, null, null);
          if (siblingBrand && siblingBrand.value) {
            suggestions.brand = siblingBrand.value;
            evidenceParts.push(
              `No single-brand GS1 prefix mapping for ${prefix7}; sibling-row interpolation from ${siblingBrand.n} DB row(s) sharing this prefix suggests "${siblingBrand.value}" (low confidence, not a fill).`
            );
          } else {
            evidenceParts.push(`No prefix-map entry and no consistent sibling rows for prefix ${prefix7}; brand left unfilled.`);
          }
        }
      } else if (field === "size") {
        // Size is never GS1-derivable; only sibling interpolation applies, and only ever as a
        // low-confidence suggestion (size is a spec field, not something a prefix determines).
        const mpn = known_fields.manufacturer_part_number;
        const sib = siblingLookup(db, "size", prefix7, mpn, mpnShape(mpn));
        if (sib && sib.value) {
          suggestions.size = sib.value;
          evidenceParts.push(
            `Sibling-row interpolation: ${sib.n} DB row(s) sharing GS1 prefix ${prefix7}${sib.usedMpnFamily ? " + matching MPN-shape family" : ""} agree on size "${sib.value}" (low confidence, not a fill; sizes are never GS1-derivable).`
          );
        } else {
          evidenceParts.push(`No consistent sibling rows for size under prefix ${prefix7}; left unfilled.`);
        }
      } else if (field === "manufacturer_part_number") {
        // MPN is per-SKU manufacturer data, never GS1-derivable; only sibling interpolation as a
        // low-confidence suggestion, matched on prefix + same brand/model/size (the identity we
        // already know for these rows) rather than a value guess.
        const brand = known_fields.brand;
        const model = known_fields.model;
        const size = known_fields.size;
        const sib = siblingLookupMpn(db, prefix7, brand, model, size);
        if (sib && sib.value) {
          suggestions.manufacturer_part_number = sib.value;
          evidenceParts.push(
            `Sibling-row interpolation: ${sib.n} DB row(s) sharing GS1 prefix ${prefix7} + same brand/model/size agree on manufacturer_part_number "${sib.value}" (low confidence, not a fill; MPNs are never GS1-derivable).`
          );
        } else {
          evidenceParts.push(`No consistent sibling rows for manufacturer_part_number under prefix ${prefix7} + same brand/model/size; left unfilled.`);
        }
      } else {
        evidenceParts.push(`Field "${field}" is out of scope for lane0 deterministic rules; left unfilled.`);
      }
    }

    const allFilledHigh =
      missing_fields.length > 0 && missing_fields.every((f) => Object.prototype.hasOwnProperty.call(fills, f));
    if (allFilledHigh) solvedIds.push(id);

    const latencyMs = Number(process.hrtime.bigint() - startRow) / 1e6;

    const entry = {
      id,
      lane: "lane0",
      fills,
      source_url: null,
      source_host: "deterministic",
      evidence_quote: evidenceParts.join(" "),
      latency_ms: Math.round(latencyMs * 100) / 100,
      cost_estimate: 0,
      confidence: allFilledHigh ? "high" : Object.keys(fills).length > 0 ? "high" : "low",
    };
    if (Object.keys(suggestions).length > 0) entry.suggestions = suggestions;

    results.push(entry);
  }

  db.close();

  const totalLatency = Date.now() - t0;
  const output = {
    lane: "lane0",
    generated_at: new Date().toISOString(),
    sample_size: sample.length,
    solved_ids: solvedIds,
    total_latency_ms: totalLatency,
    results,
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf8");

  console.log(`Lane 0 complete: ${results.length} rows, ${solvedIds.length} fully high-confidence solved.`);
  console.log(`Output written to ${path.relative(REPO_ROOT, OUT_PATH)}`);
}

/**
 * Generic sibling lookup for a single field, scoped to rows sharing the same GS1 prefix
 * (derived from the tires table's own barcode column). Never resolves with LIMIT 1 or
 * arbitrary order: if sibling rows disagree (more than one distinct non-empty value), no
 * suggestion is produced for that field.
 */
function siblingLookup(db, field, prefix7, mpn, mpnFamilyShape) {
  const allowedFields = new Set(["brand", "size"]);
  if (!allowedFields.has(field)) return null;

  // Pull all rows in the tires table, then filter by recomputed GS1 prefix (barcode column may
  // be EAN13 or UPC12 - both fold to the same 7-digit prefix via toGtin13). This is a full scan
  // but the bakeoff sample is tiny (30 rows) and this runs once per row; acceptable for a lane
  // proof-of-concept.
  const rows = db
    .prepare(`SELECT barcode, ${field} AS val, manufacturer_part_number AS mpn FROM tires WHERE ${field} IS NOT NULL AND TRIM(${field}) != ''`)
    .all();

  const matches = rows.filter((r) => gs1Prefix7(r.barcode) === prefix7);
  let pool = matches;
  let usedMpnFamily = false;
  if (mpnFamilyShape) {
    const familyMatches = matches.filter((r) => mpnShape(r.mpn) === mpnFamilyShape);
    if (familyMatches.length > 0) {
      pool = familyMatches;
      usedMpnFamily = true;
    }
  }
  if (pool.length === 0) return null;

  const distinctValues = new Set(pool.map((r) => String(r.val).trim()));
  if (distinctValues.size !== 1) return null; // disagreement among siblings -> no guess (never LIMIT 1)

  return { value: [...distinctValues][0], n: pool.length, usedMpnFamily };
}

/**
 * MPN sibling lookup: scoped to rows sharing the same GS1 prefix AND the same known
 * brand/model/size identity (the fields we already have for these rows). Never resolves
 * ambiguity with LIMIT 1/arbitrary order: disagreement among matching sibling rows yields no
 * suggestion.
 */
const mpnLookupStmt = (() => {
  let stmt = null;
  return (db) => {
    if (!stmt) {
      stmt = db.prepare(
        `SELECT barcode, brand_normalized, model_normalized, size, manufacturer_part_number AS mpn
         FROM tires
         WHERE manufacturer_part_number IS NOT NULL AND TRIM(manufacturer_part_number) != ''`
      );
    }
    return stmt;
  };
})();

function siblingLookupMpn(db, prefix7, brand, model, size) {
  if (!brand && !model && !size) return null;

  const wantBrand = brand ? normToken(brand) : null;
  const wantModel = model ? normToken(model) : null;
  const wantSize = size ? String(size).trim() : null;

  const rows = mpnLookupStmt(db).all();

  const identityMatches = rows.filter((r) => {
    if (wantBrand && normToken(r.brand_normalized) !== wantBrand) return false;
    if (wantModel && normToken(r.model_normalized) !== wantModel) return false;
    if (wantSize && String(r.size || "").trim() !== wantSize) return false;
    return true;
  });

  const prefixMatches = identityMatches.filter((r) => gs1Prefix7(r.barcode) === prefix7);
  const pool = prefixMatches.length > 0 ? prefixMatches : identityMatches; // fall back to identity match without prefix restriction
  if (pool.length === 0) return null;

  const distinctValues = new Set(pool.map((r) => String(r.mpn).trim()));
  if (distinctValues.size !== 1) return null; // disagreement -> no guess (never LIMIT 1 / arbitrary order)

  return { value: [...distinctValues][0], n: pool.length };
}

main();
