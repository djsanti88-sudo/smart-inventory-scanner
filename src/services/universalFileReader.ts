// src/services/universalFileReader.ts
import { parse as parseCsvSync } from "csv-parse/sync";
import { inferColumnMapping } from "@/services/columnIntelligence";
import { sanitizeCell } from "@/services/csvImport";
import {
  buildSourceSignature,
  type UniversalSheet,
  type UploadFileLike,
  type UploadKind,
} from "@/services/importSchema";

const DELIMITERS = [",", "\t", ";", "|"] as const;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_SHEETS = 64;
const MAX_COLUMNS = 256;
const MAX_TOTAL_ROWS = 5_000;

export function detectDelimitedSeparator(text: string): (typeof DELIMITERS)[number] {
  const line = text.replace(/^﻿/, "").split(/\r?\n/).find((value) => value.trim() !== "") ?? "";
  let quoted = false;
  const counts = new Map<(typeof DELIMITERS)[number], number>(DELIMITERS.map((value) => [value, 0]));
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') index += 1;
      else quoted = !quoted;
      continue;
    }
    if (!quoted && DELIMITERS.includes(char as (typeof DELIMITERS)[number])) {
      const delimiter = char as (typeof DELIMITERS)[number];
      counts.set(delimiter, (counts.get(delimiter) ?? 0) + 1);
    }
  }
  return DELIMITERS.reduce((best, current) =>
    (counts.get(current) ?? 0) > (counts.get(best) ?? 0) ? current : best,
  ",");
}

function extension(name: string): UploadKind {
  const suffix = name.trim().toLowerCase().split(".").pop();
  if (suffix === "csv" || suffix === "tsv" || suffix === "xlsx" || suffix === "xls") return suffix;
  throw new Error("Choose a .csv, .tsv, .xlsx, or .xls file.");
}

function hasData(row: string[]): boolean {
  return row.some((cell) => cell.trim() !== "");
}

function delimitedMatrix(text: string, kind: UploadKind): string[][] {
  const delimiter = kind === "tsv" ? "\t" : detectDelimitedSeparator(text);
  const records = parseCsvSync(text, {
    delimiter,
    bom: true,
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: false,
  }) as unknown[][];
  return records.map((row) => row.map((cell) => sanitizeCell(String(cell ?? ""))));
}

function inertCellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return "";
}

function excelCellText(value: unknown): string {
  if (typeof value !== "object" || value === null || value instanceof Date) return inertCellText(value);
  const record = value as Record<string, unknown>;
  // Formula text is never evaluated. Only a scalar cached result is importable; errors and
  // unsupported result objects are deliberately inert rather than becoming "[object Object]".
  if (record.formula !== undefined) return inertCellText(record.result);
  if (record.result !== undefined) return inertCellText(record.result);
  if (Array.isArray(record.richText)) {
    return record.richText
      .map((part) => typeof part === "object" && part !== null ? inertCellText((part as { text?: unknown }).text) : "")
      .join("");
  }
  if (record.text !== undefined) return inertCellText(record.text);
  if (record.hyperlink !== undefined) return inertCellText(record.text ?? record.hyperlink);
  return "";
}

interface NamedMatrix {
  matrix: string[][];
  sourceRowNumbers: number[];
  sheetName: string;
  sheetOrdinal: number;
}

function assertFileSize(size: number): void {
  if (size > MAX_FILE_BYTES) throw new Error("The uploaded file exceeds the 25 MiB limit.");
}

function assertMatrixLimits(matrices: string[][][]): void {
  const totalRows = matrices.reduce((total, matrix) => total + matrix.filter(hasData).length, 0);
  if (totalRows > MAX_TOTAL_ROWS) throw new Error("The uploaded file exceeds the 5,000-row limit.");
  const hasTooWideData = matrices.some((matrix) => matrix.some((row) =>
    row.reduce((lastDataColumn, cell, index) => cell.trim() === "" ? lastDataColumn : index + 1, 0) > MAX_COLUMNS,
  ));
  if (hasTooWideData) {
    throw new Error("The uploaded file exceeds the 256-column limit.");
  }
}

async function workbookMatrices(file: UploadFileLike): Promise<NamedMatrix[]> {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  const bytes = new Uint8Array(await file.arrayBuffer());
  assertFileSize(bytes.byteLength);
  try {
    // exceljs@4.4.0 ships `declare interface Buffer extends ArrayBuffer {}`, which merges into the
    // ambient global Buffer type and conflicts with @types/node's generic Buffer<T> under this
    // project's lib config (a real Node Buffer is not structurally an ArrayBuffer, so no cast target
    // satisfies both). This is a pre-existing exceljs/@types-node typings collision, not specific to
    // this call; the runtime call itself is correct per the exceljs README (workbook.xlsx.load(data)).
    // @ts-expect-error exceljs 4.4.0 Buffer typings conflict with @types/node; see comment above.
    await workbook.xlsx.load(bytes as unknown as Buffer);
  } catch (error) {
    throw new Error(`Could not read this XLSX workbook: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  if (workbook.worksheets.length > MAX_SHEETS) throw new Error("The uploaded workbook exceeds the 64-sheet limit.");
  const matrices = workbook.worksheets.map((worksheet, index) => {
    const matrix: string[][] = [];
    const sourceRowNumbers: number[] = [];
    worksheet.eachRow({ includeEmpty: false }, (worksheetRow, rowNumber) => {
      const row: string[] = [];
      worksheetRow.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
        const text = sanitizeCell(excelCellText(cell.value));
        if (columnNumber > MAX_COLUMNS) {
          if (text.trim() !== "") throw new Error("The uploaded file exceeds the 256-column limit.");
          return;
        }
        // An instantiated formula/error cell remains an inert empty cell at its physical position.
        // Style-only cells are excluded by ExcelJS's sparse `includeEmpty: false` iteration.
        row[columnNumber - 1] = text;
      });
      if (!hasData(row)) return;
      matrix.push(row);
      sourceRowNumbers.push(rowNumber);
    });
    return { matrix, sourceRowNumbers, sheetName: worksheet.name, sheetOrdinal: index + 1 };
  });
  assertMatrixLimits(matrices.map(({ matrix }) => matrix));
  return matrices.filter(({ matrix }) => matrix.some(hasData));
}

function universalSheet(
  file: UploadFileLike,
  kind: UploadKind,
  matrix: string[][],
  importedSheetName?: string,
  sheetOrdinal?: number,
  matrixSourceRowNumbers = matrix.map((_, index) => index + 1),
): UniversalSheet {
  if (!matrix.some(hasData)) throw new Error("The uploaded file is empty.");
  const inference = inferColumnMapping(matrix);
  const headerRowIndex = matrixSourceRowNumbers[inference.headerRowIndex] - 1;
  const sourceRows = matrix.slice(inference.headerRowIndex + 1);
  const sourceRowNumbers = matrixSourceRowNumbers.slice(inference.headerRowIndex + 1);
  return {
    fileName: file.name,
    kind,
    headers: inference.headers,
    rows: sourceRows.filter(hasData),
    headerRowIndex,
    sourceSignature: buildSourceSignature(inference.headers),
    importedSheetName,
    sheetOrdinal,
    sourceRowNumbers: sourceRows
      .map((row, index) => ({ row, sourceRowNumber: sourceRowNumbers[index] }))
      .filter(({ row }) => hasData(row))
      .map(({ sourceRowNumber }) => sourceRowNumber),
    skippedSheets: [],
  };
}

export async function readUniversalWorkbook(file: UploadFileLike): Promise<UniversalSheet[]> {
  const kind = extension(file.name);
  if (kind === "xls") {
    throw new Error("Legacy .xls files are not supported. Save the file as .xlsx or .csv and upload that export.");
  }
  if (file.size !== undefined) assertFileSize(file.size);
  if (kind === "csv" || kind === "tsv") {
    const text = await file.text();
    assertFileSize(new TextEncoder().encode(text).byteLength);
    const matrix = delimitedMatrix(text, kind);
    assertMatrixLimits([matrix]);
    return [universalSheet(file, kind, matrix)];
  }
  const sheets = await workbookMatrices(file);
  if (sheets.length === 0) throw new Error("The uploaded file is empty.");
  return sheets.map(({ matrix, sourceRowNumbers, sheetName, sheetOrdinal }) =>
    universalSheet(file, kind, matrix, sheetName, sheetOrdinal, sourceRowNumbers),
  );
}

/** Legacy single-sheet seam. Multi-tab workbooks must be routed through readUniversalWorkbook. */
export async function readUniversalFile(file: UploadFileLike): Promise<UniversalSheet> {
  const sheets = await readUniversalWorkbook(file);
  if (sheets.length !== 1) {
    throw new Error(
      `This workbook has ${sheets.length} non-empty sheets. Choose one sheet or export it as separate files.`,
    );
  }
  return sheets[0];
}
