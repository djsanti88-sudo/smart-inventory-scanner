import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile } from 'node:fs/promises';
import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';

import {
  DEFAULT_PRODUCTS,
  generateInventorySheet,
  generateShopwareCsv,
  buildReconcilePlan,
} from './sheets.mjs';

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), 'teach-sheets-'));
}

function rowToRecord(headers, headerToField, row) {
  const record = {};
  headers.forEach((h, i) => {
    const field = headerToField[h];
    if (field) record[field] = row[i];
  });
  return record;
}

describe('generateInventorySheet level 1 (clean CSV)', () => {
  test('re-parses to rows matching expectedRows via headerToField', async () => {
    const outDir = await tempDir();
    const result = await generateInventorySheet({ level: 1, outDir });
    assert.equal(result.format, 'csv');
    assert.equal(result.delimiter, ',');

    const raw = await readFile(result.filePath, 'utf8');
    const rows = parse(raw, { delimiter: result.delimiter, relax_column_count: true });
    const headerRow = rows[result.headerRowIndex];
    assert.deepEqual(headerRow, result.headers);

    const dataRows = rows.slice(result.headerRowIndex + 1).filter((r) => r.length > 1 || r[0] !== '');
    assert.equal(dataRows.length, result.expectedRows.length);

    dataRows.forEach((row, i) => {
      const record = rowToRecord(result.headers, result.headerToField, row);
      const expected = result.expectedRows[i];
      assert.equal(record.partNumber, expected.partNumber);
      assert.equal(record.brand, expected.brand);
      assert.equal(record.model, expected.model);
      assert.equal(record.size, expected.size);
      assert.equal(Number(record.quantity), expected.quantity);
      assert.equal(record.barcode, expected.barcode);
      assert.equal(record.name, expected.name);
    });
  });

  test('headers are canonical synonym form in canonical order', async () => {
    const outDir = await tempDir();
    const result = await generateInventorySheet({ level: 1, outDir });
    assert.deepEqual(result.headers, ['Part Number', 'Brand', 'Model', 'Size', 'Quantity', 'Barcode', 'Name']);
  });
});

describe('generateInventorySheet level 2 (renamed + shuffled)', () => {
  test('headers are renamed synonyms, order differs from level 1, and generation is deterministic', async () => {
    const outDir = await tempDir();
    const level1 = await generateInventorySheet({ level: 1, outDir });
    const level2a = await generateInventorySheet({ level: 2, outDir, fileBase: 'inv-a' });
    const level2b = await generateInventorySheet({ level: 2, outDir, fileBase: 'inv-b' });

    // renamed: none of the level2 headers equal the level1 canonical headers
    for (const h of level2a.headers) {
      assert.equal(level1.headers.includes(h), false, `level2 header "${h}" should not equal a level1 canonical header`);
    }

    // order differs (field order, not just header text)
    const level1FieldOrder = level1.headers.map((h) => level1.headerToField[h]);
    const level2FieldOrder = level2a.headers.map((h) => level2a.headerToField[h]);
    assert.notDeepEqual(level2FieldOrder, level1FieldOrder);

    // determinism: identical header order across independent calls
    assert.deepEqual(level2a.headers, level2b.headers);
    assert.deepEqual(level2a.headerToField, level2b.headerToField);
  });

  test('data still resolves correctly through headerToField', async () => {
    const outDir = await tempDir();
    const result = await generateInventorySheet({ level: 2, outDir });
    const raw = await readFile(result.filePath, 'utf8');
    const rows = parse(raw, { delimiter: result.delimiter });
    const dataRows = rows.slice(result.headerRowIndex + 1);
    dataRows.forEach((row, i) => {
      const record = rowToRecord(result.headers, result.headerToField, row);
      assert.equal(record.partNumber, result.expectedRows[i].partNumber);
      assert.equal(Number(record.quantity), result.expectedRows[i].quantity);
    });
  });
});

describe('generateInventorySheet level 3 (TSV or semicolon)', () => {
  test('uses tab or semicolon delimiter with renamed headers', async () => {
    const outDir = await tempDir();
    const result = await generateInventorySheet({ level: 3, outDir });
    assert.ok(result.delimiter === '\t' || result.delimiter === ';', `unexpected delimiter: ${JSON.stringify(result.delimiter)}`);

    const raw = await readFile(result.filePath, 'utf8');
    const rows = parse(raw, { delimiter: result.delimiter });
    assert.deepEqual(rows[result.headerRowIndex], result.headers);

    const level1 = await generateInventorySheet({ level: 1, outDir, fileBase: 'lvl1-cmp' });
    for (const h of result.headers) {
      assert.equal(level1.headers.includes(h), false);
    }
  });
});

describe('generateInventorySheet level 4 (XLSX)', () => {
  test('is a real XLSX readable by exceljs with a second "Notes" sheet', async () => {
    const outDir = await tempDir();
    const result = await generateInventorySheet({ level: 4, outDir });
    assert.equal(result.format, 'xlsx');

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(result.filePath);
    assert.equal(workbook.worksheets.length, 2);

    const inventorySheet = workbook.worksheets[0];
    const headerRow = inventorySheet.getRow(1).values.slice(1);
    assert.deepEqual(headerRow, result.headers);

    const notesSheet = workbook.getWorksheet('Notes');
    assert.ok(notesSheet, 'Notes sheet should exist');
    assert.ok(notesSheet.rowCount > 0);
    assert.ok(String(notesSheet.getRow(1).getCell(1).value).length > 0);

    // data rows resolve via headerToField
    for (let i = 0; i < result.expectedRows.length; i++) {
      const row = inventorySheet.getRow(i + 2).values.slice(1);
      const record = rowToRecord(result.headers, result.headerToField, row);
      assert.equal(record.partNumber, result.expectedRows[i].partNumber);
      assert.equal(Number(record.quantity), result.expectedRows[i].quantity);
    }
  });
});

describe('generateInventorySheet level 5 (blank title row, junk column, typos)', () => {
  test('has a blank leading row, a junk column, and typo brand while partNumber/barcode stay exact', async () => {
    const outDir = await tempDir();
    const result = await generateInventorySheet({ level: 5, outDir });

    const raw = await readFile(result.filePath, 'utf8');
    const lines = raw.split(/\r\n|\n/).filter((_, i, arr) => i < arr.length - 1 || arr[i] !== '');
    // line 0 = title, line 1 = blank, line 2 = header
    assert.equal(lines[1], '', 'second line should be blank');
    assert.equal(result.headerRowIndex, 2);

    const junkHeader = result.headers.find((h) => result.headerToField[h] === null);
    assert.ok(junkHeader, 'expected at least one junk column mapped to null');

    const rows = parse(raw, { delimiter: result.delimiter, relax_column_count: true });
    const headerRow = rows[result.headerRowIndex];
    assert.deepEqual(headerRow, result.headers);

    const dataRows = rows.slice(result.headerRowIndex + 1).filter((r) => r.length > 1);
    dataRows.forEach((row, i) => {
      const record = rowToRecord(result.headers, result.headerToField, row);
      const expected = result.expectedRows[i];
      // identifiers stay exact so fuzzy match still resolves
      assert.equal(record.partNumber, expected.partNumber);
      assert.equal(record.barcode, expected.barcode);
      // brand/model are typo'd (different from clean canonical value, when non-empty)
      if (expected.brand) {
        assert.notEqual(record.brand, expected.brand);
      }
      if (expected.model) {
        assert.notEqual(record.model, expected.model);
      }
    });
  });
});

describe('generateShopwareCsv', () => {
  test('has snake_case headers and honors quantityOverride', async () => {
    const outDir = await tempDir();
    const base = await generateShopwareCsv({ outDir, fileBase: 'sw-base' });
    assert.deepEqual(base.headers, ['part_number', 'brand', 'model', 'size', 'qty_on_hand', 'unit']);

    const rawBase = await readFile(base.filePath, 'utf8');
    const rowsBase = parse(rawBase, { columns: true, delimiter: ',' });
    rowsBase.forEach((row, i) => {
      assert.equal(row.part_number, base.expectedRows[i].partNumber);
      assert.equal(Number(row.qty_on_hand), base.expectedRows[i].qtyOnHand);
      assert.equal(row.unit, 'each');
    });

    const override = { [DEFAULT_PRODUCTS[0].partNumber]: 999 };
    const overridden = await generateShopwareCsv({ outDir, fileBase: 'sw-override', quantityOverride: override });
    assert.equal(overridden.expectedRows[0].qtyOnHand, 999);

    const rawOverride = await readFile(overridden.filePath, 'utf8');
    const rowsOverride = parse(rawOverride, { columns: true, delimiter: ',' });
    assert.equal(Number(rowsOverride[0].qty_on_hand), 999);
  });
});

describe('buildReconcilePlan', () => {
  test('equal:true yields matching quantities for every product', () => {
    const { scanPlan, shopwareQuantities } = buildReconcilePlan(DEFAULT_PRODUCTS, { equal: true });
    assert.equal(scanPlan.length, DEFAULT_PRODUCTS.length);
    for (const entry of scanPlan) {
      assert.equal(entry.times, shopwareQuantities[entry.key]);
    }
  });

  test('equal:false yields at least one mismatch and one unscanned expected item', () => {
    const { scanPlan, shopwareQuantities } = buildReconcilePlan(DEFAULT_PRODUCTS, { equal: false });

    const mismatches = scanPlan.filter((entry) => entry.times !== shopwareQuantities[entry.key]);
    assert.ok(mismatches.length >= 1, 'expected at least one quantity mismatch');

    const unscanned = scanPlan.filter((entry) => entry.times === 0 && shopwareQuantities[entry.key] > 0);
    assert.ok(unscanned.length >= 1, 'expected at least one expected-but-unscanned item');
  });
});
