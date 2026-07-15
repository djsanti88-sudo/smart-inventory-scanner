// scripts/dt-harvest/lib/backfill.mjs (Task 1, Phase 1 core)
// Pure lib: fill in blank manufacturer_part_number fields on the REAL tire corpus
// (barcodeIndex[barcode] rows) from harvested Discount Tire rows, WITHOUT overwriting any
// existing non-blank field. Never touches any field other than manufacturer_part_number /
// part_number_source. Corpus row shape: src/server/tire-knowledge/tireKnowledge.generated.json
// (barcodeIndex: Record<barcode, RowV1>, partNumberIndex: Record<normalizedPartNumber, uid>).
//
// Untrusted input: harvest rows came from scraped HTML (see parseProduct.mjs's semantic-firewall
// note). Rows are only parsed/guarded/mapped here, never executed or obeyed.
//
// Reuses guardRow from ./merge.mjs verbatim (no reimplementation of the poison guard).

import { guardRow } from "./merge.mjs";

/** Reimplemented identically to src/server/tire-knowledge/tireKnowledgeIndex.ts's normPartKey
 * (3-line normalizer) rather than importing server-only TS into this .mjs script. */
export function normPartKey(pn) {
  return (pn ?? "").toString().replace(/[ -]/g, "").trim().toUpperCase().replace(/\s/g, "");
}

/** Dedupe harvest rows by gtin: within the input list, later rows win (matches Task 1 spec's
 * "later rows win" dedupe rule, distinct from applyTransform.mjs's completeness-based dedupe). */
function dedupeByGtinLastWins(harvestRows) {
  const byGtin = new Map();
  for (const row of harvestRows || []) {
    const gtin = (row?.gtin ?? "").toString().trim();
    if (!gtin) continue;
    byGtin.set(gtin, row);
  }
  return Array.from(byGtin.values());
}

/**
 * Fill blank manufacturer_part_number fields on the corpus from guarded harvest rows.
 *
 * @param {{ barcodeIndex: Record<string, object>, partNumberIndex: Record<string, string> }} corpus
 * @param {Array<object>} harvestRows - raw harvested TireRow-shaped objects (gtin, brand, model,
 *   size, loadIndex, speedRating, partNumber, ...).
 * @param {{ prefixMap: Record<string, string | string[]> }} options
 * @returns {{ corpus: object, report: {
 *   filled: number, agreed: number,
 *   conflicts: Array<{ barcode: string, corpusPn: string, dtPn: string, brand: string, model: string, size: string }>,
 *   guardRejected: number, junkKeysDropped: number, junkFillsNotIndexed: number, noCorpusRow: number,
 * } }}
 */
export function applyBackfill(corpus, harvestRows, { prefixMap } = {}) {
  const nextBarcodeIndex = { ...(corpus.barcodeIndex || {}) };
  const nextPartNumberIndex = { ...(corpus.partNumberIndex || {}) };

  const report = {
    filled: 0,
    agreed: 0,
    conflicts: [],
    guardRejected: 0,
    junkKeysDropped: 0,
    junkFillsNotIndexed: 0,
    noCorpusRow: 0,
  };

  // AM-R1: pre-existing junk index keys (normalized length <= 4) are always dropped, corpus-wide,
  // independent of whether any harvest rows are supplied this run.
  for (const key of Object.keys(nextPartNumberIndex)) {
    if (key.length <= 4) {
      delete nextPartNumberIndex[key];
      report.junkKeysDropped += 1;
    }
  }

  const deduped = dedupeByGtinLastWins(harvestRows);

  for (const harvestRow of deduped) {
    const guard = guardRow(harvestRow, prefixMap);
    if (!guard.ok) {
      report.guardRejected += 1;
      continue;
    }

    const barcode = (harvestRow.gtin ?? "").toString().trim();
    const corpusRow = nextBarcodeIndex[barcode];
    if (!corpusRow) {
      report.noCorpusRow += 1;
      continue;
    }

    const dtPn = (harvestRow.partNumber ?? "").toString().trim();
    if (!dtPn) continue; // nothing to fill/compare

    const corpusPn = (corpusRow.manufacturer_part_number ?? "").toString().trim();

    if (!corpusPn) {
      // Blank in the corpus: fill it and stamp the source. Never touch any other field.
      const filledRow = { ...corpusRow, manufacturer_part_number: dtPn, part_number_source: "discounttire" };
      nextBarcodeIndex[barcode] = filledRow;
      report.filled += 1;

      const normalized = normPartKey(dtPn);
      if (normalized.length > 4) {
        nextPartNumberIndex[normalized] = filledRow.canonical_product_uid;
      } else {
        report.junkFillsNotIndexed += 1;
      }
      continue;
    }

    // Corpus already has a PN: agree or conflict, but never change anything.
    if (normPartKey(corpusPn) === normPartKey(dtPn)) {
      report.agreed += 1;
    } else {
      report.conflicts.push({
        barcode,
        corpusPn,
        dtPn,
        brand: (harvestRow.brand ?? "").toString(),
        model: (harvestRow.model ?? "").toString(),
        size: (harvestRow.size ?? "").toString(),
      });
    }
  }

  return {
    corpus: { ...corpus, barcodeIndex: nextBarcodeIndex, partNumberIndex: nextPartNumberIndex },
    report,
  };
}
