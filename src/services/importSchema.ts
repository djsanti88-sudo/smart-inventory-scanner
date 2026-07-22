// src/services/importSchema.ts
import type { CorpusCandidate } from "@/services/reconcile/identityMatcher";
import type { ExpectedInventoryRow } from "@/services/reconcile/types";

export const IMPORT_FIELD_ORDER = [
  "partNumber",
  "brand",
  "model",
  "size",
  "quantity",
  "uom",
  "barcode",
  "name",
  "category",
] as const;

export type ImportField = (typeof IMPORT_FIELD_ORDER)[number];
export type ColumnMapping = Partial<Record<ImportField, number>>;
export type MappingSource = "header" | "content" | "manual" | "remembered";
export type UploadKind = "csv" | "tsv" | "xlsx" | "xls";

export interface UploadFileLike {
  name: string;
  type?: string;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface SkippedSheet {
  name: string;
  rowCount: number;
}

export interface UniversalSheet {
  fileName: string;
  kind: UploadKind;
  headers: string[];
  rows: string[][];
  headerRowIndex: number;
  sourceSignature: string;
  // Multi-tab workbooks: only the first non-empty worksheet is imported. importedSheetName names it;
  // skippedSheets lists any OTHER non-empty worksheets that were NOT imported (never silently dropped).
  // Empty for delimited files and single-sheet workbooks. undefined only on legacy/synthetic sheets.
  importedSheetName?: string;
  skippedSheets?: SkippedSheet[];
}

export interface MappedImportRow {
  line: number;
  expected: ExpectedInventoryRow;
  partNumber: string;
  barcode: string;
  name: string;
  brand: string;
  model: string;
  size: string;
  category: string;
  quantity: number;
  uom: string;
}

export type ImportPreviewStatus = "exact" | "fuzzy" | "review" | "reject";

export interface RetailCatalogMatch {
  productName: string;
  brand: string;
  category: string;
  barcode: string;
}

export interface ImportPreviewRow {
  source: MappedImportRow | null;
  line: number;
  status: ImportPreviewStatus;
  reason: string;
  confidence: number | null;
  candidate?: CorpusCandidate;
  retailCatalogMatch?: RetailCatalogMatch;
}

export interface ImportPreview {
  rows: ImportPreviewRow[];
  total: number;
  exact: number;
  fuzzy: number;
  review: number;
  reject: number;
  headline: string;
}

export interface UniversalImportApplySummary {
  applied: number;
  queuedForReview: number;
  rejected: number;
}

export interface ImportReviewContext {
  importQuantity: number;
  suggestion?: {
    name: string;
    brand: string;
    category: string;
    specsShort: string;
    primarySku: string;
    primaryBarcode: string;
  };
}

function normalizedHeader(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function buildSourceSignature(headers: string[]): string {
  const content = headers.map(normalizedHeader).join("");
  let hash = 5381;
  for (let index = 0; index < content.length; index += 1) {
    hash = ((hash << 5) + hash + content.charCodeAt(index)) | 0;
  }
  return `import-source-${(hash >>> 0).toString(36)}-${headers.length}`;
}

export function emptyColumnMapping(): ColumnMapping {
  return {};
}
