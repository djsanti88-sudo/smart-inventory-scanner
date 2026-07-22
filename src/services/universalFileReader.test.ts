// src/services/universalFileReader.test.ts
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { readUniversalFile } from "@/services/universalFileReader";
import type { UploadFileLike } from "@/services/importSchema";

function textFile(name: string, content: string): UploadFileLike {
  const bytes = new TextEncoder().encode(content);
  return {
    name,
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

  it("warns when a workbook has more than one non-empty worksheet, importing the first", async () => {
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
    const sheet = await readUniversalFile(file);
    // First non-empty sheet is imported byte-for-byte the same as before.
    expect(sheet.rows).toEqual([["ABC-1", "Acme", "7"]]);
    // The other non-empty sheet is surfaced, never silently dropped.
    expect(sheet.importedSheetName).toBe("Inventory");
    expect(sheet.skippedSheets).toEqual([{ name: "Warehouse B", rowCount: 3 }]);
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
    expect(sheet.skippedSheets).toEqual([]);
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
    // The empty leading sheet is NOT a skipped-data warning (only non-empty extras count).
    expect(sheet.skippedSheets).toEqual([]);
  });

  it("accepts OOXML bytes with an .xls filename but rejects genuine legacy BIFF honestly", async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Inventory").addRow(["PN", "QOH"]);
    const buffer = await workbook.xlsx.writeBuffer();
    const bytes = new Uint8Array(buffer);
    const renamed: UploadFileLike = {
      name: "inventory.xls",
      text: async () => "",
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
    await expect(readUniversalFile(renamed)).resolves.toMatchObject({ kind: "xls" });

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
      "Legacy binary .xls is not supported by installed ExcelJS 4.4.0. Save it as .xlsx or .csv.",
    );
  });
});
