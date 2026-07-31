// src/services/universalFileReader.test.ts
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { readUniversalFile, readUniversalWorkbook } from "@/services/universalFileReader";
import type { UploadFileLike } from "@/services/importSchema";

function textFile(name: string, content: string, size?: number): UploadFileLike {
  const bytes = new TextEncoder().encode(content);
  return {
    name,
    size,
    type: "text/plain",
    text: async () => content,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

describe("readUniversalFile", () => {
  it("reads BOM CSV with blank and title rows plus a semicolon delimiter", async () => {
    const sheet = await readUniversalFile(textFile(
      "inventory.csv",
      "﻿;;;;\nInventory export;;;;\nPN;Make;Model;Tire Size;QOH\nABC-1;Acme;Road;225/45R18;7\n",
    ));
    expect(sheet.kind).toBe("csv");
    expect(sheet.headerRowIndex).toBe(2);
    expect(sheet.headers).toEqual(["PN", "Make", "Model", "Tire Size", "QOH"]);
    expect(sheet.rows).toEqual([["ABC-1", "Acme", "Road", "225/45R18", "7"]]);
  });

  it("reads TSV and sanitizes every cell", async () => {
    const sheet = await readUniversalFile(textFile(
      "inventory.tsv",
      "PN\tMake\tQOH\nABC-1\t=2+2\t3\n",
    ));
    expect(sheet.kind).toBe("tsv");
    expect(sheet.rows[0][1]).toBe("'=2+2");
  });

  it("lazy-loads an XLSX workbook and sanitizes formula results", async () => {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Inventory");
    worksheet.addRow(["PN", "Make", "QOH"]);
    worksheet.addRow(["ABC-1", { formula: "2+2", result: "=4" }, 3]);
    const buffer = await workbook.xlsx.writeBuffer();
    const bytes = new Uint8Array(buffer);
    const file: UploadFileLike = {
      name: "inventory.xlsx",
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      text: async () => "",
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
    const sheet = await readUniversalFile(file);
    expect(sheet.kind).toBe("xlsx");
    expect(sheet.rows[0]).toEqual(["ABC-1", "'=4", "3"]);
  });

  it("keeps every named non-empty XLSX sheet in workbook order", async () => {
    const workbook = new ExcelJS.Workbook();
    const first = workbook.addWorksheet("Inventory");
    first.addRow(["PN", "Make", "QOH"]);
    first.addRow(["ABC-1", "Acme", 7]);
    const second = workbook.addWorksheet("Warehouse B");
    second.addRow(["PN", "Make", "QOH"]);
    second.addRow(["ZZZ-9", "Beta", 3]);
    second.addRow(["ZZZ-8", "Beta", 4]);
    const buffer = await workbook.xlsx.writeBuffer();
    const bytes = new Uint8Array(buffer);
    const file: UploadFileLike = {
      name: "inventory.xlsx",
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      text: async () => "",
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
    const sheets = await readUniversalWorkbook(file);
    expect(sheets).toHaveLength(2);
    expect(sheets.map((sheet) => sheet.importedSheetName)).toEqual(["Inventory", "Warehouse B"]);
    expect(sheets.map((sheet) => sheet.rows)).toEqual([
      [["ABC-1", "Acme", "7"]],
      [["ZZZ-9", "Beta", "3"], ["ZZZ-8", "Beta", "4"]],
    ]);
  });

  it("keeps legacy single-sheet callers safe by rejecting multi-sheet workbooks", async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Inventory").addRow(["PN", "QOH"]);
    workbook.addWorksheet("Warehouse B").addRow(["PN", "QOH"]);
    const buffer = await workbook.xlsx.writeBuffer();
    const bytes = new Uint8Array(buffer);
    const file: UploadFileLike = {
      name: "inventory.xlsx",
      text: async () => "",
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };

    await expect(readUniversalFile(file)).rejects.toThrow(
      "This workbook has 2 non-empty sheets. Choose one sheet or export it as separate files.",
    );
  });

  it("does not warn for a single-sheet workbook (happy path unchanged)", async () => {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Inventory");
    worksheet.addRow(["PN", "Make", "QOH"]);
    worksheet.addRow(["ABC-1", "Acme", 7]);
    const buffer = await workbook.xlsx.writeBuffer();
    const bytes = new Uint8Array(buffer);
    const file: UploadFileLike = {
      name: "inventory.xlsx",
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      text: async () => "",
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
    const sheet = await readUniversalFile(file);
    expect(sheet.rows).toEqual([["ABC-1", "Acme", "7"]]);
    expect(sheet.importedSheetName).toBe("Inventory");
  });

  it("imports the data sheet and does not warn about an empty leading sheet", async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Cover"); // empty, no rows
    const data = workbook.addWorksheet("Data");
    data.addRow(["PN", "Make", "QOH"]);
    data.addRow(["ABC-1", "Acme", 7]);
    const buffer = await workbook.xlsx.writeBuffer();
    const bytes = new Uint8Array(buffer);
    const file: UploadFileLike = {
      name: "inventory.xlsx",
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      text: async () => "",
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
    const sheet = await readUniversalFile(file);
    expect(sheet.rows).toEqual([["ABC-1", "Acme", "7"]]);
    expect(sheet.importedSheetName).toBe("Data");
    expect(sheet.importedSheetName).toBe("Data");
  });

  it("omits styled-only sheets while preserving the physical sheet and source row ordinals", async () => {
    const workbook = new ExcelJS.Workbook();
    const cover = workbook.addWorksheet("Cover");
    cover.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF000000" } };
    const data = workbook.addWorksheet("Data");
    data.addRow(["Report title"]);
    data.addRow(["PN", "QOH"]);
    data.addRow(["ABC-1", 7]);
    const buffer = await workbook.xlsx.writeBuffer();
    const bytes = new Uint8Array(buffer);
    const file: UploadFileLike = {
      name: "inventory.xlsx",
      text: async () => "",
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };

    const [sheet] = await readUniversalWorkbook(file);
    expect(sheet).toMatchObject({ importedSheetName: "Data", sheetOrdinal: 2, headerRowIndex: 1 });
    expect(sheet.sourceRowNumbers).toEqual([3]);
  });

  it("uses only cached formula results and leaves uncached formulas empty", async () => {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Inventory");
    worksheet.addRow(["PN", "QOH"]);
    worksheet.addRow(["ABC-1", { formula: "1+1" }]);
    const buffer = await workbook.xlsx.writeBuffer();
    const bytes = new Uint8Array(buffer);
    const file: UploadFileLike = {
      name: "inventory.xlsx",
      text: async () => "",
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };

    await expect(readUniversalFile(file)).resolves.toMatchObject({ rows: [["ABC-1", ""]] });
  });

  it("turns cached formula error objects into inert empty cells", async () => {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Inventory");
    worksheet.addRow(["PN", "QOH"]);
    worksheet.addRow(["ABC-1", { formula: "1/0", result: { error: "#DIV/0!" } }]);
    const buffer = await workbook.xlsx.writeBuffer();
    const bytes = new Uint8Array(buffer);
    const file: UploadFileLike = {
      name: "inventory.xlsx",
      text: async () => "",
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };

    await expect(readUniversalFile(file)).resolves.toMatchObject({ rows: [["ABC-1", ""]] });
  });

  it("ignores styled far-away cells without allocating their physical width", async () => {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Inventory");
    worksheet.addRow(["PN", "QOH"]);
    worksheet.addRow(["ABC-1", 7]);
    worksheet.getCell("XFD1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF000000" } };
    const buffer = await workbook.xlsx.writeBuffer();
    const bytes = new Uint8Array(buffer);
    const file: UploadFileLike = {
      name: "inventory.xlsx",
      text: async () => "",
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };

    const sheet = await readUniversalFile(file);
    expect(sheet.rows[0].slice(0, 2)).toEqual(["ABC-1", "7"]);
    expect(sheet.rows[0]).toHaveLength(2);
    expect(sheet.rows[0].length).toBeLessThanOrEqual(256);
  });

  it("ignores a styled far-away row without adding it to returned source rows", async () => {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Inventory");
    worksheet.addRow(["PN", "QOH"]);
    worksheet.addRow(["ABC-1", 7]);
    worksheet.getCell("A100001").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF000000" } };
    const buffer = await workbook.xlsx.writeBuffer();
    const bytes = new Uint8Array(buffer);
    const sheet = await readUniversalFile({
      name: "inventory.xlsx",
      text: async () => "",
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });

    expect(sheet.rows).toEqual([["ABC-1", "7"]]);
    expect(sheet.sourceRowNumbers).toEqual([2]);
  });

  it("allows exact file, sheet, column, and row limits", async () => {
    const columns = Array.from({ length: 256 }, (_, index) => `H${index}`).join(",");
    const row = Array.from({ length: 256 }, (_, index) => `V${index}`).join(",");
    const csv = [columns, ...Array.from({ length: 4_999 }, () => row)].join("\n");
    const workbook = await readUniversalWorkbook(textFile("limit.csv", csv, 25 * 1024 * 1024));
    expect(workbook).toHaveLength(1);
    expect(workbook[0].rows).toHaveLength(4_999);
  });

  it("rejects files, workbooks, rows, and columns above their whole-input limits", async () => {
    await expect(readUniversalWorkbook(textFile("large.csv", "PN\nABC", (25 * 1024 * 1024) + 1))).rejects.toThrow(
      "The uploaded file exceeds the 25 MiB limit.",
    );
    const tooManyColumns = Array.from({ length: 257 }, (_, index) => `H${index}`).join(",");
    await expect(readUniversalWorkbook(textFile("columns.csv", tooManyColumns))).rejects.toThrow(
      "The uploaded file exceeds the 256-column limit.",
    );
    const xlsxColumns = new ExcelJS.Workbook();
    const xlsxSheet = xlsxColumns.addWorksheet("Inventory");
    xlsxSheet.getCell(1, 1).value = "PN";
    xlsxSheet.getCell(1, 257).value = "TOO_FAR";
    const xlsxBuffer = await xlsxColumns.xlsx.writeBuffer();
    const xlsxBytes = new Uint8Array(xlsxBuffer);
    await expect(readUniversalWorkbook({
      name: "columns.xlsx",
      text: async () => "",
      arrayBuffer: async () => xlsxBytes.buffer.slice(xlsxBytes.byteOffset, xlsxBytes.byteOffset + xlsxBytes.byteLength),
    })).rejects.toThrow("The uploaded file exceeds the 256-column limit.");
    await expect(readUniversalWorkbook(textFile("rows.csv", Array.from({ length: 5_001 }, () => "PN").join("\n")))).rejects.toThrow(
      "The uploaded file exceeds the 5,000-row limit.",
    );
    const workbook = new ExcelJS.Workbook();
    for (let index = 0; index < 65; index += 1) workbook.addWorksheet(`Sheet ${index + 1}`).addRow(["PN"]);
    const buffer = await workbook.xlsx.writeBuffer();
    const bytes = new Uint8Array(buffer);
    await expect(readUniversalWorkbook({
      name: "sheets.xlsx",
      text: async () => "",
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    })).rejects.toThrow("The uploaded workbook exceeds the 64-sheet limit.");
  });

  it("accepts exactly 64 non-empty workbook sheets", async () => {
    const workbook = new ExcelJS.Workbook();
    for (let index = 0; index < 64; index += 1) workbook.addWorksheet(`Sheet ${index + 1}`).addRow(["PN"]);
    const buffer = await workbook.xlsx.writeBuffer();
    const bytes = new Uint8Array(buffer);
    const sheets = await readUniversalWorkbook({
      name: "64-sheets.xlsx",
      text: async () => "",
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
    expect(sheets).toHaveLength(64);
    expect(sheets.at(-1)?.sheetOrdinal).toBe(64);
  });

  it("rejects every .xls upload with safe conversion guidance", async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Inventory").addRow(["PN", "QOH"]);
    const buffer = await workbook.xlsx.writeBuffer();
    const bytes = new Uint8Array(buffer);
    const renamed: UploadFileLike = {
      name: "inventory.xls",
      text: async () => "",
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
    await expect(readUniversalWorkbook(renamed)).rejects.toThrow(
      "Legacy .xls files are not supported. Save the file as .xlsx or .csv and upload that export.",
    );

    const biffBytes = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const biff: UploadFileLike = {
      name: "legacy.xls",
      type: "application/vnd.ms-excel",
      text: async () => "",
      arrayBuffer: async () => biffBytes.buffer.slice(
        biffBytes.byteOffset,
        biffBytes.byteOffset + biffBytes.byteLength,
      ),
    };
    await expect(readUniversalFile(biff)).rejects.toThrow(
      "Legacy .xls files are not supported. Save the file as .xlsx or .csv and upload that export.",
    );
  });
});
