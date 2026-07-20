// src/services/columnIntelligence.ts
import { tireSizeToken } from "@/services/ai/tireSpecs";
import { sanitizeCell } from "@/services/csvImport";
import type { ColumnMapping, ImportField, MappingSource } from "@/services/importSchema";
import { isGtinShaped } from "@/services/upc/gtin";

export const HEADER_SYNONYMS: Readonly<Record<ImportField, readonly string[]>> = {
  partNumber: [
    "part number",
    "part no",
    "part",
    "pn",
    "item no",
    "item number",
    "mfg part number",
    "manufacturer part number",
    "sku",
    "primary sku",
  ],
  brand: ["brand", "make", "manufacturer", "mfr"],
  model: ["model", "product", "description", "item description", "product name"],
  size: ["size", "tire size", "tyre size"],
  quantity: ["qty", "quantity", "count", "qoh", "quantity on hand", "qty on hand", "on hand"],
  uom: ["unit", "uom", "unit of measure"],
  barcode: ["barcode", "primary barcode", "upc", "ean", "gtin"],
  name: ["name", "product name", "item name"],
  category: ["category", "department", "product category"],
};

export interface ColumnInference {
  headerRowIndex: number;
  headers: string[];
  mapping: ColumnMapping;
  confidence: "high" | "low";
  source: MappingSource;
  seenHeaders: string[];
  reasons: string[];
}

export function normalizeImportHeader(value: string): string {
  return sanitizeCell(value)
    .toLowerCase()
    .replace(/#/g, " number ")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function fieldForHeader(value: string): ImportField | undefined {
  const normalized = normalizeImportHeader(value);
  return (Object.keys(HEADER_SYNONYMS) as ImportField[]).find((field) =>
    HEADER_SYNONYMS[field].includes(normalized),
  );
}

function nonBlank(row: string[]): boolean {
  return row.some((cell) => cell.trim() !== "");
}

function headerScore(row: string[]): number {
  return new Set(row.map(fieldForHeader).filter((field): field is ImportField => Boolean(field))).size;
}

function valuesForColumn(rows: string[][], index: number): string[] {
  return rows.map((row) => row[index] ?? "").map((value) => value.trim()).filter(Boolean);
}

function allQuantities(values: string[]): boolean {
  return values.length > 0 && values.every((value) => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0;
  });
}

function allSizes(values: string[]): boolean {
  return values.length > 0 && values.every((value) => tireSizeToken({ productName: value }) !== "");
}

function allBarcodes(values: string[]): boolean {
  return values.length > 0 && values.every((value) => isGtinShaped(value));
}

export function inferColumnMapping(matrix: string[][]): ColumnInference {
  const candidateRows = matrix
    .map((row, index) => ({ row, index, score: headerScore(row) }))
    .filter(({ row }) => nonBlank(row));
  const first = candidateRows[0] ?? { row: [], index: 0, score: 0 };
  const header = candidateRows.reduce((best, current) => current.score > best.score ? current : best, first);
  const headers = header.row.map(sanitizeCell);
  const mapping: ColumnMapping = {};
  const reasons: string[] = [];

  headers.forEach((value, index) => {
    const field = fieldForHeader(value);
    if (field !== undefined && mapping[field] === undefined) mapping[field] = index;
  });

  const dataRows = matrix.slice(header.index + 1).filter(nonBlank);
  const used = new Set(Object.values(mapping).filter((value): value is number => value !== undefined));
  // Barcode and size run before quantity: both are narrower, more specific predicates (GTIN shape,
  // tire size pattern) than "any parseable non-negative safe integer," so a long digit-only barcode
  // (e.g. a 12-digit UPC) is claimed as a barcode first and never mistaken for a quantity column.
  const inferred: Array<[ImportField, (values: string[]) => boolean]> = [
    ["barcode", allBarcodes],
    ["size", allSizes],
    ["quantity", allQuantities],
  ];

  for (const [field, predicate] of inferred) {
    if (mapping[field] !== undefined) continue;
    const matches = headers
      .map((_, index) => index)
      .filter((index) => !used.has(index) && predicate(valuesForColumn(dataRows, index)));
    if (matches.length === 1) {
      mapping[field] = matches[0];
      used.add(matches[0]);
      reasons.push(`${field} inferred from cell content.`);
    }
  }

  const hasIdentity = mapping.partNumber !== undefined || mapping.barcode !== undefined || mapping.name !== undefined;
  const hasQuantity = mapping.quantity !== undefined;
  const source: MappingSource = header.score > 0 ? "header" : "content";
  const confidence = source === "header" && hasIdentity && hasQuantity ? "high" : "low";
  if (!hasIdentity) reasons.push("No identity column was recognized.");
  if (!hasQuantity) reasons.push("No quantity column was recognized.");
  if (confidence === "low") reasons.push(`Seen headers: ${headers.join(", ") || "(none)"}.`);

  return {
    headerRowIndex: header.index,
    headers,
    mapping,
    confidence,
    source,
    seenHeaders: headers,
    reasons,
  };
}

export function validateManualMapping(
  headers: string[],
  mapping: ColumnMapping,
): { ok: true } | { ok: false; errors: string[] } {
  const assigned = Object.values(mapping).filter((value): value is number => value !== undefined);
  if (new Set(assigned).size !== assigned.length) {
    return { ok: false, errors: ["One source column cannot be assigned to more than one field."] };
  }
  if (assigned.some((index) => index < 0 || index >= headers.length)) {
    return { ok: false, errors: ["A mapped column is outside the uploaded file."] };
  }
  if (mapping.partNumber === undefined && mapping.barcode === undefined && mapping.name === undefined) {
    return { ok: false, errors: ["Map at least one identity field: part number, barcode, or name."] };
  }
  if (mapping.quantity === undefined) {
    return { ok: false, errors: ["Map the quantity field before previewing."] };
  }
  return { ok: true };
}
