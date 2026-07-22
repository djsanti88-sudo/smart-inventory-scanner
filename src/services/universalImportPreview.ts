import type { ColumnMapping, ImportPreview, ImportPreviewRow, ImportPreviewStatus, MappedImportRow, MappingSource, RetailCatalogMatch, UniversalSheet } from "@/services/importSchema";
import type { MatchResult } from "@/services/reconcile/identityMatcher";

/**
 * User-facing warning when a multi-tab workbook had more than one non-empty worksheet. Only the first
 * non-empty sheet is imported; this names it and the non-empty sheets that were NOT imported, so the
 * data gap is never silent. Returns "" when nothing was skipped (single-sheet or delimited files).
 */
export function describeSkippedSheets(sheet: UniversalSheet): string {
  const skipped = sheet.skippedSheets ?? [];
  if (skipped.length === 0) return "";
  const imported = sheet.importedSheetName ?? "the first sheet";
  const others = skipped.map((s) => `"${s.name}" (${s.rowCount} rows)`).join(", ");
  return `Imported sheet "${imported}". ${others} ${skipped.length === 1 ? "was" : "were"} not imported; upload it separately if needed.`;
}

const SENSITIVE_HEADER = /(^|[ _-])(cost|price|retail|msrp|margin)([ _-]|$)/i;

// Upper bound for a single import row's quantity. A real shop's on-hand count for one SKU never
// approaches this; values above it almost always mean a mis-mapped column (e.g. a 12-digit barcode
// mapped to Quantity), which would otherwise drive ~10^11 processScan calls downstream (browser hang).
export const MAX_IMPORT_QUANTITY = 100_000;

export interface PreviewMatchResult extends MatchResult {
  retailCatalogMatch?: RetailCatalogMatch;
}

export interface MappingResult {
  rows: MappedImportRow[];
  heldForReview: ImportPreviewRow[];
  rejected: ImportPreviewRow[];
}

function cell(row: string[], mapping: ColumnMapping, field: keyof ColumnMapping): string {
  const index = mapping[field];
  return index === undefined ? "" : row[index] ?? "";
}

function displayName(row: Omit<MappedImportRow, "expected">): string {
  return row.name || [row.brand, row.model, row.size].filter(Boolean).join(" ") || row.partNumber || row.barcode;
}

export function mapUniversalRows(sheet: UniversalSheet, mapping: ColumnMapping): MappingResult {
  const rows: MappedImportRow[] = [];
  const heldForReview: ImportPreviewRow[] = [];
  const rejected: ImportPreviewRow[] = [];
  sheet.rows.forEach((sourceCells, rowIndex) => {
    const line = sheet.headerRowIndex + rowIndex + 2;
    const quantityText = cell(sourceCells, mapping, "quantity");
    const quantityTrimmed = quantityText.trim();
    if (quantityTrimmed === "") {
      rejected.push({ source: null, line, status: "reject", reason: "Quantity is blank; enter 0 explicitly if the count is zero.", confidence: null });
      return;
    }
    const quantity = Number(quantityTrimmed);
    if (!Number.isSafeInteger(quantity) || quantity < 0) {
      rejected.push({ source: null, line, status: "reject", reason: `Quantity "${quantityText}" is not a non-negative whole number.`, confidence: null });
      return;
    }
    if (quantity > MAX_IMPORT_QUANTITY) {
      rejected.push({ source: null, line, status: "reject", reason: `Quantity "${quantityText}" looks too large; check the column mapping.`, confidence: null });
      return;
    }
    const base = {
      line,
      partNumber: cell(sourceCells, mapping, "partNumber"),
      barcode: cell(sourceCells, mapping, "barcode"),
      name: cell(sourceCells, mapping, "name"),
      brand: cell(sourceCells, mapping, "brand"),
      model: cell(sourceCells, mapping, "model"),
      size: cell(sourceCells, mapping, "size"),
      category: cell(sourceCells, mapping, "category"),
      quantity,
      uom: cell(sourceCells, mapping, "uom"),
    };
    const identity = base.partNumber || base.barcode || base.name;
    if (!identity) {
      rejected.push({ source: null, line, status: "reject", reason: "No part number, barcode, or name was found on this row.", confidence: null });
      return;
    }
    const raw = Object.fromEntries(
      sheet.headers
        .map((header, index) => [header, sourceCells[index] ?? ""] as const)
        .filter(([header]) => !SENSITIVE_HEADER.test(header)),
    );
    const mapped: MappedImportRow = {
      ...base,
      expected: {
        externalId: identity,
        partNumbers: [...new Set([base.partNumber, base.barcode].filter(Boolean))],
        brand: base.brand || undefined,
        model: base.model || undefined,
        sizeText: base.size || undefined,
        specs: displayName(base),
        barcode: base.barcode || undefined,
        name: displayName(base),
        category: base.category || undefined,
        qty: quantity,
        raw,
      },
    };
    if (mapped.uom && mapped.uom.toLowerCase() !== "each") {
      heldForReview.push({ source: mapped, line, status: "review", reason: `Unit "${mapped.uom}" requires review; only each is applied automatically.`, confidence: null });
      return;
    }
    rows.push(mapped);
  });
  return { rows, heldForReview, rejected };
}

function statusForMatch(match: PreviewMatchResult, mappingSource: MappingSource): ImportPreviewStatus {
  // RESOLVER-TRUST LAW: only a genuine exact identity is ever "exact" (which Task 10 auto-counts).
  // A miss (unmatched), an ambiguous match, or any non-exact outcome MUST route to review - wrong or
  // absent identity auto-counting is the project's top forbidden failure; unknown is acceptable.
  // mappingSource must NEVER be able to promote a non-match to "exact".
  void mappingSource;
  if (match.status === "matched") {
    return match.matchBasis === "part_number_exact" ? "exact" : "fuzzy";
  }
  if (match.status === "non_tire" && match.retailCatalogMatch) return "exact";
  return "review";
}

export function buildImportPreview(
  mapped: MappingResult,
  matches: PreviewMatchResult[],
  mappingSource: MappingSource,
): ImportPreview {
  if (matches.length !== mapped.rows.length) {
    throw new Error(`Matcher returned ${matches.length} results for ${mapped.rows.length} rows.`);
  }
  const matchedRows = mapped.rows.map((source, index): ImportPreviewRow => {
    const match = matches[index];
    const status = statusForMatch(match, mappingSource);
    const reason = match.retailCatalogMatch
      ? `identified from the 4M-product catalog: ${match.retailCatalogMatch.productName}`
      : match.reason;
    return {
      source,
      line: source.line,
      status,
      reason,
      confidence: match.confidence ?? (status === "exact" ? 1 : null),
      candidate: match.candidate,
      retailCatalogMatch: match.retailCatalogMatch,
    };
  });
  const rows = [...matchedRows, ...mapped.heldForReview, ...mapped.rejected].sort((a, b) => a.line - b.line);
  const count = (status: ImportPreviewStatus) => rows.filter((row) => row.status === status).length;
  const exact = count("exact");
  return {
    rows,
    total: rows.length,
    exact,
    fuzzy: count("fuzzy"),
    review: count("review"),
    reject: count("reject"),
    headline: `Matched ${exact} of ${rows.length} automatically`,
  };
}
