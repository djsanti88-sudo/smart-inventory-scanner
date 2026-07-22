import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile } from 'node:fs/promises';
import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';

import {
  BASE_CATALOG,
  RESERVED,
  VENDOR_FORMATS,
  SCENARIOS,
  writeBaseCatalogCsv,
  buildReconcileMatrix,
  normalizeHeader,
} from './reconcileScenarios.mjs';

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), 'teach-reconcile-'));
}

describe('base catalog', () => {
  test('BASE_CATALOG has 12 products, RESERVED has 3', () => {
    assert.equal(BASE_CATALOG.length, 12);
    assert.equal(RESERVED.length, 3);
    assert.deepEqual(RESERVED.map((p) => p.brand), ['Dunlop', 'BFGoodrich', 'Toyo']);
  });

  test('writeBaseCatalogCsv writes a CSV that re-parses to 12 rows with brand+barcode+quantity', async () => {
    const outDir = await tempDir();
    const { filePath, products } = await writeBaseCatalogCsv(outDir);
    assert.equal(products.length, 12);

    const raw = await readFile(filePath, 'utf8');
    const rows = parse(raw, { columns: true });
    assert.equal(rows.length, 12);
    rows.forEach((row, i) => {
      const expected = BASE_CATALOG[i];
      assert.equal(row.name, `${expected.brand} ${expected.model}`);
      assert.equal(row.brand, expected.brand);
      assert.equal(row.model, expected.model);
      assert.equal(row.barcode, expected.barcode);
      assert.equal(Number(row.quantity), expected.ourQty);
      assert.ok(row.size.length > 0);
    });
  });

  test('determinism: two calls produce byte-identical catalog.csv', async () => {
    const dirA = await tempDir();
    const dirB = await tempDir();
    const a = await writeBaseCatalogCsv(dirA);
    const b = await writeBaseCatalogCsv(dirB);
    const contentA = await readFile(a.filePath, 'utf8');
    const contentB = await readFile(b.filePath, 'utf8');
    assert.equal(contentA, contentB);
  });
});

describe('VENDOR_FORMATS', () => {
  test('has at least 8 formats', () => {
    assert.ok(VENDOR_FORMATS.length >= 8, `expected >= 8 formats, got ${VENDOR_FORMATS.length}`);
  });

  test('covers all three size notations', () => {
    const notations = new Set(VENDOR_FORMATS.map((f) => f.sizeNotation).filter(Boolean));
    assert.ok(notations.has('slash'));
    assert.ok(notations.has('spaces'));
    assert.ok(notations.has('dashes'));
  });

  test('covers csv, tsv, and xlsx extensions', () => {
    const exts = new Set(VENDOR_FORMATS.map((f) => f.ext));
    assert.ok(exts.has('csv'));
    assert.ok(exts.has('tsv'));
    assert.ok(exts.has('xlsx'));
  });

  test('includes both intentionally-failing PN headers (p/sn, us number)', () => {
    const normalized = VENDOR_FORMATS.map((f) => normalizeHeader(f.pnHeader));
    assert.ok(normalized.includes('p/sn'));
    assert.ok(normalized.includes('us_number'));
  });

  test('every accepted PN header synonym is used at least once', () => {
    const normalized = new Set(VENDOR_FORMATS.map((f) => normalizeHeader(f.pnHeader)));
    for (const accepted of ['part_number', 'sku', 'pn', 'part_no', 'item_no', 'mfg_part_number']) {
      assert.ok(normalized.has(accepted), `missing PN header synonym: ${accepted}`);
    }
  });
});

describe('SCENARIOS', () => {
  test('defines the six required scenario types', () => {
    const keys = SCENARIOS.map((s) => s.key).sort();
    assert.deepEqual(keys, [
      'agreement',
      'ambiguous',
      'expected_not_counted',
      'over_by_1',
      'same_desc_agree',
      'short_by_2',
    ]);
  });
});

describe('buildReconcileMatrix', () => {
  test('returns one case per vendor format', async () => {
    const outDir = await tempDir();
    const cases = await buildReconcileMatrix(outDir);
    assert.equal(cases.length, VENDOR_FORMATS.length);
  });

  test('the p/sn and "us number" cases are flagged expectFileError:true with empty expected', async () => {
    const outDir = await tempDir();
    const cases = await buildReconcileMatrix(outDir);
    const pSn = cases.find((c) => c.formatKey === 'failing_pslashsn');
    const usNumber = cases.find((c) => c.formatKey === 'failing_usnumber');
    assert.ok(pSn);
    assert.ok(usNumber);
    assert.equal(pSn.expectFileError, true);
    assert.equal(usNumber.expectFileError, true);
    assert.deepEqual(pSn.expected, []);
    assert.deepEqual(usNumber.expected, []);
  });

  test('non-error cases carry a non-empty expected annotation array', async () => {
    const outDir = await tempDir();
    const cases = await buildReconcileMatrix(outDir);
    for (const c of cases) {
      if (c.expectFileError) continue;
      assert.ok(c.expected.length > 0, `case ${c.formatKey} should have expected rows`);
      for (const row of c.expected) {
        assert.ok(['agreement', 'variance', 'expected_not_counted', 'ambiguous'].includes(row.bucket));
      }
    }
  });

  test('a same_desc_agree case has a typo\'d brand AND expected bucket agreement delta 0', async () => {
    const outDir = await tempDir();
    const cases = await buildReconcileMatrix(outDir);
    const shopware = cases.find((c) => c.formatKey === 'shopware');
    assert.ok(shopware);
    // Product index 3 (Hankook Dynapro ATM RF10) is assigned same_desc_agree.
    const hankook = shopware.expected.find((r) => r.key === '2001383');
    assert.ok(hankook, 'expected the Hankook PN row in the shopware case');
    assert.notEqual(hankook.brand, 'Hankook');
    assert.equal(hankook.bucket, 'agreement');
    assert.equal(hankook.delta, 0);
  });

  test('short_by_2 and over_by_1 rows carry the correctly signed delta', async () => {
    const outDir = await tempDir();
    const cases = await buildReconcileMatrix(outDir);
    const shopware = cases.find((c) => c.formatKey === 'shopware');

    // Product index 1 (Falken Rubitrek, PN 28074576, ourQty 3) -> short_by_2.
    const rubitrek = shopware.expected.find((r) => r.key === '28074576');
    assert.ok(rubitrek);
    assert.equal(rubitrek.bucket, 'variance');
    assert.equal(rubitrek.delta, -2);

    // Product index 2 (Nexen Roadian ATX, PN 18773NXK, ourQty 8) -> over_by_1.
    const nexen = shopware.expected.find((r) => r.key === '18773NXK');
    assert.ok(nexen);
    assert.equal(nexen.bucket, 'variance');
    assert.equal(nexen.delta, 1);
  });

  test('expected_not_counted case references a RESERVED product', async () => {
    const outDir = await tempDir();
    const cases = await buildReconcileMatrix(outDir);
    const shopware = cases.find((c) => c.formatKey === 'shopware');
    const notCounted = shopware.expected.find((r) => r.bucket === 'expected_not_counted');
    assert.ok(notCounted);
    const reservedPns = RESERVED.map((p) => p.pn);
    assert.ok(reservedPns.includes(notCounted.key));
    assert.ok(!BASE_CATALOG.some((p) => p.pn === notCounted.key));
  });

  test('an ambiguous case has a PN paired with a conflicting brand', async () => {
    const outDir = await tempDir();
    const cases = await buildReconcileMatrix(outDir);
    const shopware = cases.find((c) => c.formatKey === 'shopware');
    // Product index 6 (Goodyear Wrangler Territory RT, PN 710004933) -> ambiguous.
    const ambiguousRow = shopware.expected.find((r) => r.key === '710004933');
    assert.ok(ambiguousRow);
    assert.equal(ambiguousRow.bucket, 'ambiguous');
    assert.notEqual(ambiguousRow.brand, 'Goodyear');
  });

  test('XLSX case writes a real workbook readable by exceljs', async () => {
    const outDir = await tempDir();
    const cases = await buildReconcileMatrix(outDir);
    const xlsxCase = cases.find((c) => c.ext === 'xlsx');
    assert.ok(xlsxCase);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(xlsxCase.filePath);
    const sheet = workbook.worksheets[0];
    assert.ok(sheet.rowCount > 1);
    const headerRow = sheet.getRow(1).values.filter((v) => v !== undefined && v !== null);
    assert.ok(headerRow.some((h) => normalizeHeader(h) === 'mfg_part_number'));
  });

  test('determinism: same call twice produces identical CSV file bytes', async () => {
    const dirA = await tempDir();
    const dirB = await tempDir();
    const casesA = await buildReconcileMatrix(dirA);
    const casesB = await buildReconcileMatrix(dirB);
    const shopwareA = casesA.find((c) => c.formatKey === 'shopware');
    const shopwareB = casesB.find((c) => c.formatKey === 'shopware');
    const contentA = await readFile(shopwareA.filePath, 'utf8');
    const contentB = await readFile(shopwareB.filePath, 'utf8');
    assert.equal(contentA, contentB);
    assert.deepEqual(shopwareA.expected, shopwareB.expected);
  });

  test('TSV case is delimited by tabs and parses to expected row count', async () => {
    const outDir = await tempDir();
    const cases = await buildReconcileMatrix(outDir);
    const tsvCase = cases.find((c) => c.ext === 'tsv');
    assert.ok(tsvCase);
    const raw = await readFile(tsvCase.filePath, 'utf8');
    const rows = parse(raw, { delimiter: '\t', columns: true });
    assert.equal(rows.length, tsvCase.expected.length);
  });

  test('minimal PN+qty format has no brand/model/size columns', async () => {
    const outDir = await tempDir();
    const cases = await buildReconcileMatrix(outDir);
    const minimal = cases.find((c) => c.formatKey === 'minimal_pnqty');
    assert.ok(minimal);
    const raw = await readFile(minimal.filePath, 'utf8');
    const rows = parse(raw, { columns: true });
    const headers = Object.keys(rows[0]);
    assert.equal(headers.length, 2);
  });

  test('quickbooks_messy format has a blank title row and a junk column', async () => {
    const outDir = await tempDir();
    const cases = await buildReconcileMatrix(outDir);
    const qb = cases.find((c) => c.formatKey === 'quickbooks_messy');
    assert.ok(qb);
    const raw = await readFile(qb.filePath, 'utf8');
    const lines = raw.split('\r\n');
    assert.equal(lines[0], 'My Shop Export 2026');
    assert.equal(lines[1], '');
    assert.ok(lines[2].includes('Notes'));
  });
});
