// src/services/reconcile/universalAdapter.ts
//
// Universal (XLSX/TSV/CSV) intake adapter for the reconcile round. Converts an ALREADY-PARSED
// UniversalSheet (see @/services/universalFileReader, read-only dependency) plus a resolved
// ColumnMapping (see @/services/columnIntelligence's inferColumnMapping, read-only dependency -
// both already built and proven for Universal Import) into the SAME AdapterResult /
// ExpectedInventoryRow shape the Shop-Ware CSV fast path produces (shopwareCsvAdapter.ts), so
// buildReconcileReport / identityMatcher never need to know which file format a row came from.
//
// Pure, deterministic, NEVER throws on bad input (same contract as parseShopwareCsv): unreadable
// rows land in `unparseable` with a reason, good rows still parse. Price/cost-shaped columns are
// dropped from `raw` entirely (mirrors universalImportPreview.ts's SENSITIVE_HEADER exclusion) -
// `raw` is the only field these rows carry that ever reaches the network (session.adapter.rows is
// sent to /api/reconcile/match), so cost-like columns must never land in it.

import type { AdapterResult, ExpectedInventoryRow } from "@/services/reconcile/types";
import type { ColumnMapping, UniversalSheet } from "@/services/importSchema";

/** Mirrors universalImportPreview.ts's SENSITIVE_HEADER (cost/price/retail/msrp/margin) - kept as
 *  its own copy here rather than an import so this file's exclusion never depends on a module
 *  outside this agent's owned surface. Guard-tested to stay equivalent (universalAdapter.test.ts). */
const SENSITIVE_HEADER = /(^|[ _-])(cost|price|retail|msrp|margin)([ _-]|$)/i;

/** Header text that plausibly names a PER-UNIT cost column for the opt-in, LOCAL-ONLY dollar
 *  variance feature (see dollarVariance.ts / ReconcilePanel's "include unit cost" toggle).
 *  Deliberately narrower than SENSITIVE_HEADER: "retail"/"msrp"/"margin" are excluded from `raw`
 *  but are not reliably a per-unit cost figure, so they are never auto-captured as unit cost. */
const UNIT_COST_HEADER = /(^|[ _-])(cost|unit_cost|unit cost|cost_each|cost each)([ _-]|$)/i;

function cell(row: string[], mapping: ColumnMapping, field: keyof ColumnMapping): string {
  const index = mapping[field];
  if (index === undefined) return "";
  return (row[index] ?? "").trim();
}

function rowIdentity(row: string[], mapping: ColumnMapping): string {
  return cell(row, mapping, "partNumber") || cell(row, mapping, "barcode") || cell(row, mapping, "name");
}

/** Convert an already-parsed universal sheet + resolved column mapping into reconcile's
 *  AdapterResult. `mapping` should already carry at least an identity field (partNumber, barcode,
 *  or name) and quantity - callers run `validateManualMapping` (columnIntelligence.ts) first. */
export function mapUniversalSheetToAdapterResult(sheet: UniversalSheet, mapping: ColumnMapping): AdapterResult {
  const rows: ExpectedInventoryRow[] = [];
  const uomReview: ExpectedInventoryRow[] = [];
  const unparseable: Array<{ line: number; reason: string }> = [];
  const assumptions: string[] = [];

  if (mapping.uom === undefined) {
    assumptions.push('Quantities assumed unit "each" (no unit column mapped).');
  }

  sheet.rows.forEach((sourceCells, rowIndex) => {
    const line = sheet.headerRowIndex + rowIndex + 2;
    const partNumber = cell(sourceCells, mapping, "partNumber");
    const barcode = cell(sourceCells, mapping, "barcode");
    const name = cell(sourceCells, mapping, "name");
    const identity = partNumber || barcode || name;
    if (!identity) {
      unparseable.push({ line, reason: "No part number, barcode, or name was found on this row." });
      return;
    }

    const quantityText = cell(sourceCells, mapping, "quantity");
    if (quantityText === "") {
      unparseable.push({ line, reason: "Missing or unparseable quantity." });
      return;
    }
    const qty = Number(quantityText);
    if (!Number.isFinite(qty)) {
      unparseable.push({ line, reason: `Quantity "${quantityText}" is not a number.` });
      return;
    }

    const brand = cell(sourceCells, mapping, "brand");
    const model = cell(sourceCells, mapping, "model");
    const size = cell(sourceCells, mapping, "size");
    const category = cell(sourceCells, mapping, "category");
    const uom = cell(sourceCells, mapping, "uom");

    const raw: Record<string, string> = {};
    sheet.headers.forEach((header, index) => {
      if (SENSITIVE_HEADER.test(header)) return;
      raw[header] = sourceCells[index] ?? "";
    });

    const row: ExpectedInventoryRow = {
      externalId: identity,
      partNumbers: [...new Set([partNumber, barcode].filter(Boolean))],
      brand: brand || undefined,
      model: model || undefined,
      sizeText: size || undefined,
      specs: [brand, model, size].filter(Boolean).join(" ") || undefined,
      barcode: barcode || undefined,
      name: name || undefined,
      category: category || undefined,
      qty,
      raw,
    };

    if (uom && uom.toLowerCase() !== "each") {
      uomReview.push(row);
    } else {
      rows.push(row);
    }
  });

  return { rows, uomReview, unparseable, assumptions };
}

function parseMoney(value: string): number | undefined {
  const cleaned = value.replace(/[$,]/g, "").trim();
  if (cleaned === "") return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

/** Opt-in, LOCAL-ONLY per-SKU unit cost extraction from an already-parsed universal sheet. Returns
 *  externalId (the SAME identity mapUniversalSheetToAdapterResult assigns each row) -> unit cost.
 *  Callers MUST keep this map out of session.adapter (never sent to /api/reconcile/match) - see
 *  reconcileStore's separate `unitCosts` field and ReconcilePanel's outbound-payload guard test. */
export function extractUniversalUnitCosts(sheet: UniversalSheet, mapping: ColumnMapping): Record<string, number> {
  const costIndex = sheet.headers.findIndex((h) => UNIT_COST_HEADER.test(h));
  if (costIndex < 0) return {};
  const unitCosts: Record<string, number> = {};
  for (const sourceCells of sheet.rows) {
    const identity = rowIdentity(sourceCells, mapping);
    if (!identity) continue;
    const cost = parseMoney(sourceCells[costIndex] ?? "");
    if (cost !== undefined) unitCosts[identity] = cost;
  }
  return unitCosts;
}
