# Case: hbug-03-import-quantity-blank-unbounded
## Task prompt (what the subject model sees)
Review the following code for real defects. This is the row-mapping stage of a universal CSV/Excel
import for a barcode inventory app: each source row is mapped to product fields plus a `quantity`
via a user-configured `ColumnMapping` (which spreadsheet column holds which field). Rows that can't
be safely applied should be rejected with an honest, specific reason rather than silently imported
wrong or crashing the import.
## Input code
```ts
// src/services/universalImportPreview.ts

import type { ColumnMapping, ImportPreview, ImportPreviewRow, ImportPreviewStatus, MappedImportRow, MappingSource, RetailCatalogMatch, UniversalSheet } from "@/services/importSchema";
import type { MatchResult } from "@/services/reconcile/identityMatcher";

const SENSITIVE_HEADER = /(^|[ _-])(cost|price|retail|msrp|margin)([ _-]|$)/i;

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
    const quantity = Number(quantityText);
    if (!Number.isSafeInteger(quantity) || quantity < 0) {
      rejected.push({ source: null, line, status: "reject", reason: `Quantity "${quantityText}" is not a non-negative whole number.`, confidence: null });
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
        raw,
      },
    };
    rows.push(mapped);
  });
  return { rows, heldForReview, rejected };
}
```
