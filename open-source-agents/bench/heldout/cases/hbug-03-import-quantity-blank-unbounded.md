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
## GROUND TRUTH (never shown to subject)
- Defect: two related quantity-parsing gaps. (1) `Number(quantityText)` on a blank or whitespace-only
  cell evaluates to `Number("") === 0` / `Number("   ") === 0`, which passes the
  `Number.isSafeInteger(quantity) && quantity >= 0` check and gets silently imported as an explicit
  zero-on-hand row - indistinguishable from a row where the shop genuinely typed "0". A blank cell
  almost always means "unknown/not filled in", not "confirmed zero stock", so this silently corrupts
  the imported count with no way for the user to tell it happened. (2) There is no upper bound on
  `quantity`: if a column is mis-mapped (e.g. a 12-digit UPC/barcode column accidentally mapped to the
  Quantity field), `Number.isSafeInteger` happily accepts a value like `196006123457`, which gets
  carried downstream into per-unit processing (each unit of quantity drives a scan/count application) -
  a ~10^11-iteration loop that hangs the browser.
- Fix commit: c65f807 fix(import): reject blank/absurd import quantities instead of silently applying 0 or hanging (P4 ultra-review HIGH)
- Key evidence: the fix trims `quantityText`, explicitly rejects an empty-after-trim value with the
  reason "Quantity is blank; enter 0 explicitly if the count is zero." BEFORE calling `Number()` on it,
  and adds `MAX_IMPORT_QUANTITY = 100_000` with a rejection reason "...looks too large; check the
  column mapping." for anything over that bound - while still accepting an explicit `"0"` as a
  legitimate zero-on-hand row.
- Scoring: HIT if the subject identifies BOTH: (a) that `Number(quantityText)` silently treats a blank
  or whitespace-only cell as a valid zero quantity, indistinguishable from an intentional zero, and
  (b) that there is no upper bound on the parsed quantity, so a mis-mapped column (e.g. a barcode)
  could produce an absurdly large quantity that breaks/hangs whatever downstream code applies that
  many units. PARTIAL if the subject finds only one of the two (either the blank-defaults-to-zero
  issue OR the missing upper-bound/mis-mapped-column issue) with a concrete downstream consequence.
  Plausible-but-wrong findings: (1) flagging that `Number.isSafeInteger` rejects non-integer decimals
  like "1.5" as too strict (this is correct behavior for a unit count, not a bug); (2) claiming the
  `SENSITIVE_HEADER` regex filtering of the `raw` object is incomplete/leaky (out of scope for this
  function's actual bug and not demonstrated here); (3) suggesting `identity` falling back through
  `partNumber || barcode || name` could silently pick the wrong field (intentional fallback priority
  documented by the field order, not the real defect in this diff).
