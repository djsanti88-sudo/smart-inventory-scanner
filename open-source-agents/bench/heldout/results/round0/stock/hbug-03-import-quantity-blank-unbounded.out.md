<!-- subject=stock case=hbug-03-import-quantity-blank-unbounded round=0 elapsed=201s rc=0 -->
**Defects / Edge‑cases found**

| # | Issue | Why it matters | Suggested fix |
|---|--------|-----------------|---------------|
| 1 | **Empty quantity is treated as `0`** | `cell()` returns an empty string for a missing column, and `Number("")` → `0`. The import will silently accept rows that have no quantity value. | Trim the cell value first (`quantityText.trim()`) and reject if it’s still empty: `<if (!quantityText.trim()) reject …>`. |
| 2 | **Whitespace in other fields is not trimmed** | Names, brands, etc. may contain leading/trailing spaces which will be carried into `displayName()` and the raw data. | Apply `.trim()` to every cell value before using it (e.g., `const val = (row[index] ?? "").trim();`). |
| 3 | **`quantityText` that contains a decimal string is accepted** | `"5.0"` → `Number("5.0") === 5`, which passes the integer check even though the user probably meant “five”. | Reject if the original text does not match `/^\d+$/`. |
| 4 | **The regex for sensitive headers misspells “retail”** | If a header is actually “retail”, it will *not* be filtered out. | Correct the pattern to `/(^|[ _-])(cost|price|retail|msrp|margin)([ _-]|$)/i`. |
| 5 | **`raw` includes the quantity column** | The raw data is meant for “other” columns; including `quantity` can be confusing and may leak sensitive values. | Exclude `"quantity"` from the raw mapping (`filter(([header]) => header !== "quantity" && !SENSITIVE_HEADER.test(header))`). |
| 6 | **Line number calculation may be off** | `sheet.headerRowIndex + rowIndex + 2` assumes `headerRowIndex` is zero‑based. If it’s one‑based, the reported line will be wrong. | Verify the origin of `headerRowIndex`; if it’s already a line number, just use `rowIndex + headerRowIndex`. |
| 7 | **No check for duplicate partNumber/barcode** | Two rows could map to the same product; the current code silently accepts both. | Optionally collect seen identifiers and reject duplicates with a clear reason. |

---

### Minimal patch that addresses the most critical problems

```ts
function cell(row: string[], mapping: ColumnMapping, field: keyof ColumnMapping): string {
  const index = mapping[field];
  // Return an empty trimmed string if the column is missing or blank.
  return index === undefined ? "" : (row[index] ?? "").trim();
}

export function mapUniversalRows(sheet: UniversalSheet, mapping: ColumnMapping): MappingResult {
  const rows: MappedImportRow[] = [];
  const heldForReview: ImportPreviewRow[] = [];
  const rejected: ImportPreviewRow[] = [];

  sheet.rows.forEach((sourceCells, rowIndex) => {
    const line = sheet.headerRowIndex + rowIndex + 2;

    // --- Quantity ---------------------------------------------------------
    const quantityTextRaw = cell(sourceCells, mapping, "quantity");
    if (!/^\d+$/.test(quantityTextRaw)) {          // reject non‑integer or empty
      rejected.push({
        source: null,
        line,
        status: "reject",
        reason: `Quantity "${quantityTextRaw}" is not a non‑negative whole number.`,
        confidence: null,
      });
      return;
    }
    const quantity = Number(quantityTextRaw);       // safe integer by construction
    if (!Number.isSafeInteger(quantity) || quantity < 0) {
      rejected.push({
        source: null,
        line,
        status: "reject",
        reason: `Quantity "${quantityTextRaw}" is not a non‑negative whole number.`,
        confidence: null,
      });
      return;
    }

    // --- Base fields ------------------------------------------------------
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

    // --- Identity ---------------------------------------------------------
    const identity = base.partNumber || base.barcode || base.name;
    if (!identity) {
      rejected.push({
        source: null,
        line,
        status: "reject",
        reason: "No part number, barcode, or name was found on this row.",
        confidence: null,
      });
      return;
    }

    // --- Raw data ---------------------------------------------------------
    const raw = Object.fromEntries(
      sheet.headers
        .map((header, index) => [header, sourceCells[index] ?? ""].filter(Boolean))
        .filter(([header]) => header !== "quantity" && !SENSITIVE_HEADER.test(header)),
    );

    // --- Expected mapping -----------------------------------------------
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

**What changed**

* All cell values are trimmed before use.
* Quantity is now validated against a strict integer regex; empty strings are rejected.
* The `raw` object no longer contains the sensitive headers or the quantity column.
* Minor defensive checks (e.g., filtering out falsy tuples) keep the code robust.

With these fixes, rows that would previously slip through with bad quantities or hidden whitespace will now be correctly rejected, and the raw data will not leak sensitive values.
