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

function excelCellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return String(value);
  const record = value as Record<string, unknown>;
  if (record.result !== undefined) return String(record.result ?? "");
  if (Array.isArray(record.richText)) {
    return record.richText
      .map((part) => typeof part === "object" && part !== null ? String((part as { text?: unknown }).text ?? "") : "")
      .join("");
  }
  if (record.text !== undefined) return String(record.text ?? "");
  if (record.hyperlink !== undefined) return String(record.text ?? record.hyperlink ?? "");
  return String(value);
}

async function workbookMatrix(file: UploadFileLike, kind: UploadKind): Promise<string[][]> {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    // exceljs@4.4.0 ships `declare interface Buffer extends ArrayBuffer {}`, which merges into the
    // ambient global Buffer type and conflicts with @types/node's generic Buffer<T> under this
    // project's lib config (a real Node Buffer is not structurally an ArrayBuffer, so no cast target
    // satisfies both). This is a pre-existing exceljs/@types-node typings collision, not specific to
    // this call; the runtime call itself is correct per the exceljs README (workbook.xlsx.load(data)).
    // @ts-expect-error exceljs 4.4.0 Buffer typings conflict with @types/node; see comment above.
    await workbook.xlsx.load(bytes as unknown as Buffer);
  } catch (error) {
    if (kind === "xls") {
      throw new Error(
        "Legacy binary .xls is not supported by installed ExcelJS 4.4.0. Save it as .xlsx or .csv.",
      );
    }
    throw new Error(`Could not read this XLSX workbook: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  const worksheet = workbook.worksheets.find((candidate) => candidate.rowCount > 0);
  if (!worksheet) return [];
  const matrix: string[][] = [];
  for (let rowNumber = 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row: string[] = [];
    for (let columnNumber = 1; columnNumber <= worksheet.columnCount; columnNumber += 1) {
      row.push(sanitizeCell(excelCellText(worksheet.getRow(rowNumber).getCell(columnNumber).value)));
    }
    matrix.push(row);
  }
  return matrix;
}

export async function readUniversalFile(file: UploadFileLike): Promise<UniversalSheet> {
  const kind = extension(file.name);
  const matrix = kind === "csv" || kind === "tsv"
    ? delimitedMatrix(await file.text(), kind)
    : await workbookMatrix(file, kind);
  if (!matrix.some(hasData)) throw new Error("The uploaded file is empty.");
  const inference = inferColumnMapping(matrix);
  const rows = matrix.slice(inference.headerRowIndex + 1).filter(hasData);
  return {
    fileName: file.name,
    kind,
    headers: inference.headers,
    rows,
    headerRowIndex: inference.headerRowIndex,
    sourceSignature: buildSourceSignature(inference.headers),
    seenRows: matrix.slice(0, inference.headerRowIndex + 4),
  };
}
