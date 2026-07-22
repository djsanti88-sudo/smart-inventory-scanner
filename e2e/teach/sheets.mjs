// e2e/teach/sheets.mjs
//
// "Teach Bot" spreadsheet generator. Pure Node ESM, no app source imports.
// Produces increasingly messy "business owner exported their inventory from
// other software" files (CSV / TSV / semicolon / XLSX) plus a Shop-Ware
// reconcile CSV, for exercising the app's fuzzy column mapper + reconcile flow.
//
// Mirrors (does NOT import) the app's real header synonym table so the
// generated messiness stays realistic without coupling to app internals.

import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';

// ---------------------------------------------------------------------------
// Schema + synonym table (hardcoded mirror of the app's real mapper table).
// ---------------------------------------------------------------------------

export const SCHEMA_FIELDS = [
  'partNumber',
  'brand',
  'model',
  'size',
  'quantity',
  'uom',
  'barcode',
  'name',
  'category',
];

export const HEADER_SYNONYMS = {
  partNumber: ['part number', 'part no', 'part', 'pn', 'item no', 'item number', 'mfg part number', 'sku', 'primary sku'],
  brand: ['brand', 'make', 'manufacturer', 'mfr'],
  model: ['model', 'product', 'description', 'product name'],
  size: ['size', 'tire size', 'tyre size'],
  quantity: ['qty', 'quantity', 'count', 'qoh', 'quantity on hand', 'qty on hand', 'on hand'],
  uom: ['unit', 'uom', 'unit of measure'],
  barcode: ['barcode', 'primary barcode', 'upc', 'ean', 'gtin'],
  name: ['name', 'product name', 'item name'],
  category: ['category', 'department', 'product category'],
};

// ---------------------------------------------------------------------------
// Default seed products (real corpus/seed matches so reconcile can resolve).
// ---------------------------------------------------------------------------

export const DEFAULT_PRODUCTS = [
  {
    partNumber: '28816861',
    brand: 'Falken',
    model: 'Sincera ST80 A/S',
    size: '215/70R15',
    barcode: '848983012906',
    name: 'Falken Sincera ST80 A/S',
    quantity: 6,
  },
  {
    partNumber: '90000002732',
    brand: 'Cooper',
    model: 'Evolution Tour',
    size: '215/60R16',
    barcode: '',
    name: 'Cooper Evolution Tour',
    quantity: 4,
  },
  {
    partNumber: '44953',
    brand: 'Michelin',
    model: 'Defender T+H',
    size: '225/65R17',
    barcode: '',
    name: 'Michelin Defender',
    quantity: 8,
  },
  {
    partNumber: '',
    brand: 'Coca-Cola',
    model: '12 pack 12oz',
    size: '',
    barcode: '049000028904',
    name: 'Coca-Cola 12 pack',
    quantity: 12,
  },
];

const CORE_FIELDS = ['partNumber', 'brand', 'model', 'size', 'quantity', 'barcode', 'name'];

// ---------------------------------------------------------------------------
// Small deterministic helpers (no Math.random anywhere).
// ---------------------------------------------------------------------------

/** Deterministic seeded pseudo-random generator (mulberry32), used only for
 *  picking "random-ish" junk text - never for anything that must be stable
 *  test-to-test in a way callers rely on beyond documented determinism. */
function seededRng(seed) {
  let a = seed >>> 0 || 1;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function junkText(rng) {
  const choices = ['n/a', 'x', 'TBD', '-', 'misc', '0', 'see note'];
  const idx = Math.floor(rng() * choices.length) % choices.length;
  return choices[idx];
}

/** Deterministic typo transform: never randomness-driven, purely a function
 *  of the input string. Used to simulate human-entered messy data while
 *  keeping identifiers (partNumber/barcode) exact so fuzzy match still works. */
function typoify(str) {
  if (!str) return str;
  let s = String(str).replace(/\+/g, ' ');
  const chars = s.split('');
  const idx = chars.findIndex((c, i) => i > 0 && /[aeiou]/i.test(c));
  if (idx > -1) {
    chars.splice(idx, 1);
  }
  return chars.join('');
}

function escapeCsvField(value, delimiter) {
  const str = value === null || value === undefined ? '' : String(value);
  const needsQuote = str.includes(delimiter) || str.includes('"') || str.includes('\n') || str.includes('\r');
  if (!needsQuote) return str;
  return `"${str.replace(/"/g, '""')}"`;
}

function writeDelimitedRow(cells, delimiter) {
  return cells.map((c) => escapeCsvField(c, delimiter)).join(delimiter);
}

function keyOf(product) {
  return product.partNumber || product.barcode || product.name;
}

// ---------------------------------------------------------------------------
// generateInventorySheet
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {number} opts.level 1-5, increasing messiness
 * @param {Array<object>} [opts.products]
 * @param {string} opts.outDir
 * @param {string} [opts.fileBase]
 */
export async function generateInventorySheet({ level, products = DEFAULT_PRODUCTS, outDir, fileBase = 'inventory' }) {
  if (!Number.isInteger(level) || level < 1 || level > 5) {
    throw new Error(`generateInventorySheet: level must be an integer 1-5, got ${level}`);
  }
  await mkdir(outDir, { recursive: true });

  const expectedRows = products.map((p) => ({
    partNumber: p.partNumber ?? '',
    brand: p.brand ?? '',
    model: p.model ?? '',
    size: p.size ?? '',
    quantity: Number(p.quantity ?? 0),
    barcode: p.barcode ?? '',
    name: p.name ?? '',
  }));

  if (level === 1) return generateLevel1(products, expectedRows, outDir, fileBase);
  if (level === 2) return generateLevel2(products, expectedRows, outDir, fileBase);
  if (level === 3) return generateLevel3(products, expectedRows, outDir, fileBase);
  if (level === 4) return generateLevel4(products, expectedRows, outDir, fileBase);
  return generateLevel5(products, expectedRows, outDir, fileBase);
}

// --- level 1: clean canonical CSV -------------------------------------------------

function generateLevel1(products, expectedRows, outDir, fileBase) {
  const order = ['partNumber', 'brand', 'model', 'size', 'quantity', 'barcode', 'name'];
  const headerLabel = {
    partNumber: 'Part Number',
    brand: 'Brand',
    model: 'Model',
    size: 'Size',
    quantity: 'Quantity',
    barcode: 'Barcode',
    name: 'Name',
  };
  const headers = order.map((f) => headerLabel[f]);
  const headerToField = Object.fromEntries(headers.map((h, i) => [h, order[i]]));

  const lines = [writeDelimitedRow(headers, ',')];
  for (const p of products) {
    lines.push(writeDelimitedRow(order.map((f) => (f === 'quantity' ? Number(p.quantity ?? 0) : p[f] ?? '')), ','));
  }
  const content = lines.join('\r\n') + '\r\n';

  return finalizeCsv({
    content,
    outDir,
    fileBase,
    ext: 'csv',
    level: 1,
    format: 'csv',
    delimiter: ',',
    headers,
    headerToField,
    expectedRows,
    headerRowIndex: 0,
    notes: 'Clean canonical CSV, exact synonym headers, canonical column order.',
  });
}

// --- level 2: renamed synonyms + shuffled column order -----------------------------

function level2HeaderPlan() {
  // Deterministic (not Math.random-derived) renamed-header order, matching
  // the spec's illustrative example: Make, QOH, Tire Size, PN, Product, UPC, Item Name.
  return [
    { field: 'brand', header: 'Make' },
    { field: 'quantity', header: 'QOH' },
    { field: 'size', header: 'Tire Size' },
    { field: 'partNumber', header: 'PN' },
    { field: 'model', header: 'Product' },
    { field: 'barcode', header: 'UPC' },
    { field: 'name', header: 'Item Name' },
  ];
}

function generateLevel2(products, expectedRows, outDir, fileBase) {
  const plan = level2HeaderPlan();
  const headers = plan.map((p) => p.header);
  const headerToField = Object.fromEntries(plan.map((p) => [p.header, p.field]));

  const lines = [writeDelimitedRow(headers, ',')];
  for (const p of products) {
    lines.push(writeDelimitedRow(plan.map(({ field }) => (field === 'quantity' ? Number(p.quantity ?? 0) : p[field] ?? '')), ','));
  }
  const content = lines.join('\r\n') + '\r\n';

  return finalizeCsv({
    content,
    outDir,
    fileBase,
    ext: 'csv',
    level: 2,
    format: 'csv',
    delimiter: ',',
    headers,
    headerToField,
    expectedRows,
    headerRowIndex: 0,
    notes: 'Renamed synonym headers, shuffled column order (deterministic).',
  });
}

// --- level 3: TSV or semicolon-delimited, renamed headers --------------------------

function generateLevel3(products, expectedRows, outDir, fileBase) {
  const delimiter = level % 0 === 0 ? ';' : '\t'; // placeholder, replaced below
  const plan = [
    { field: 'partNumber', header: 'Item No' },
    { field: 'brand', header: 'Manufacturer' },
    { field: 'model', header: 'Description' },
    { field: 'size', header: 'Size' },
    { field: 'quantity', header: 'Count' },
    { field: 'barcode', header: 'EAN' },
    { field: 'name', header: 'Product Name' },
  ];
  const chosenDelimiter = 3 % 2 === 1 ? '\t' : ';'; // level=3 is odd -> tab (parity rule)
  const headers = plan.map((p) => p.header);
  const headerToField = Object.fromEntries(plan.map((p) => [p.header, p.field]));

  const lines = [writeDelimitedRow(headers, chosenDelimiter)];
  for (const p of products) {
    lines.push(
      writeDelimitedRow(
        plan.map(({ field }) => (field === 'quantity' ? Number(p.quantity ?? 0) : p[field] ?? '')),
        chosenDelimiter,
      ),
    );
  }
  const content = lines.join('\r\n') + '\r\n';
  const ext = chosenDelimiter === '\t' ? 'tsv' : 'csv';

  return finalizeCsv({
    content,
    outDir,
    fileBase,
    ext,
    level: 3,
    format: chosenDelimiter === '\t' ? 'tsv' : 'csv-semicolon',
    delimiter: chosenDelimiter,
    headers,
    headerToField,
    expectedRows,
    headerRowIndex: 0,
    notes: `Delimiter-alternate export (${chosenDelimiter === '\t' ? 'tab' : 'semicolon'}), renamed headers.`,
  });
}

// --- level 4: XLSX via exceljs, renamed headers, extra "Notes" sheet ---------------

async function generateLevel4(products, expectedRows, outDir, fileBase) {
  const plan = [
    { field: 'partNumber', header: 'SKU' },
    { field: 'brand', header: 'Mfr' },
    { field: 'model', header: 'Product' },
    { field: 'size', header: 'Tyre Size' },
    { field: 'quantity', header: 'Qty On Hand' },
    { field: 'barcode', header: 'GTIN' },
    { field: 'name', header: 'Item Name' },
  ];
  const headers = plan.map((p) => p.header);
  const headerToField = Object.fromEntries(plan.map((p) => [p.header, p.field]));

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Inventory');
  sheet.addRow(headers);
  for (const p of products) {
    sheet.addRow(plan.map(({ field }) => (field === 'quantity' ? Number(p.quantity ?? 0) : p[field] ?? '')));
  }

  const notesSheet = workbook.addWorksheet('Notes');
  notesSheet.addRow(['Exported from LegacyShopSoftware v3']);
  notesSheet.addRow(['Contact billing@example-legacy-shop.test for questions']);

  await mkdir(outDir, { recursive: true });
  const filePath = path.join(outDir, `${fileBase}-level4.xlsx`);
  await workbook.xlsx.writeFile(filePath);

  return {
    filePath,
    format: 'xlsx',
    delimiter: null,
    headers,
    headerToField,
    expectedRows,
    level: 4,
    headerRowIndex: 0,
    notes: 'XLSX workbook, renamed headers, second non-empty "Notes" sheet.',
  };
}

// --- level 5: blank title row, junk column, typo'd brand/model --------------------

function generateLevel5(products, expectedRows, outDir, fileBase) {
  const plan = [
    { field: 'partNumber', header: 'PN' },
    { field: 'brand', header: 'Make' },
    { field: 'model', header: 'Product' },
    { field: null, header: 'Junk Column' },
    { field: 'size', header: 'Tire Size' },
    { field: 'quantity', header: 'QOH' },
    { field: 'barcode', header: 'UPC' },
    { field: 'name', header: 'Item Name' },
  ];
  const headers = plan.map((p) => p.header);
  const headerToField = Object.fromEntries(plan.map((p) => [p.header, p.field]));

  const rng = seededRng(5);
  const titleRow = 'My Shop Export 2026';
  const blankRow = '';
  const headerRowIndex = 2; // title row (0), blank row (1), header row (2)

  const lines = [titleRow, blankRow, writeDelimitedRow(headers, ',')];

  for (const p of products) {
    const rowCells = plan.map(({ field }) => {
      if (field === null) return junkText(rng);
      if (field === 'quantity') return Number(p.quantity ?? 0);
      if (field === 'brand') return typoify(p.brand ?? '');
      if (field === 'model') return typoify(p.model ?? '');
      return p[field] ?? '';
    });
    lines.push(writeDelimitedRow(rowCells, ','));
  }
  const content = lines.join('\r\n') + '\r\n';

  return finalizeCsv({
    content,
    outDir,
    fileBase,
    ext: 'csv',
    level: 5,
    format: 'csv',
    delimiter: ',',
    headers,
    headerToField,
    expectedRows,
    headerRowIndex,
    notes: 'Blank leading title row, junk column, typo\'d brand/model; partNumber/barcode stay exact.',
  });
}

async function finalizeCsv({ content, outDir, fileBase, ext, level, format, delimiter, headers, headerToField, expectedRows, headerRowIndex, notes }) {
  await mkdir(outDir, { recursive: true });
  const filePath = path.join(outDir, `${fileBase}-level${level}.${ext}`);
  await writeFile(filePath, content, 'utf8');
  return { filePath, format, delimiter, headers, headerToField, expectedRows, level, headerRowIndex, notes };
}

// ---------------------------------------------------------------------------
// generateShopwareCsv
// ---------------------------------------------------------------------------

export async function generateShopwareCsv({ products = DEFAULT_PRODUCTS, outDir, fileBase = 'shopware', quantityOverride = null }) {
  await mkdir(outDir, { recursive: true });
  const headers = ['part_number', 'brand', 'model', 'size', 'qty_on_hand', 'unit'];
  const lines = [writeDelimitedRow(headers, ',')];
  const expectedRows = [];

  for (const p of products) {
    const key = keyOf(p);
    let qty = Number(p.quantity ?? 0);
    if (quantityOverride && Object.prototype.hasOwnProperty.call(quantityOverride, key)) {
      qty = Number(quantityOverride[key]);
    }
    lines.push(writeDelimitedRow([p.partNumber ?? '', p.brand ?? '', p.model ?? '', p.size ?? '', qty, 'each'], ','));
    expectedRows.push({ partNumber: p.partNumber ?? '', qtyOnHand: qty });
  }
  const content = lines.join('\r\n') + '\r\n';
  const filePath = path.join(outDir, `${fileBase}.csv`);
  await writeFile(filePath, content, 'utf8');

  return { filePath, headers, expectedRows };
}

// ---------------------------------------------------------------------------
// buildReconcilePlan
// ---------------------------------------------------------------------------

/**
 * @param {Array<object>} products
 * @param {object} opts
 * @param {boolean} opts.equal - true: everything reconciles (scanned == shopware);
 *   false: at least one variance AND at least one expected-but-unscanned item.
 */
export function buildReconcilePlan(products, { equal }) {
  const scanPlan = [];
  const shopwareQuantities = {};

  products.forEach((p, idx) => {
    const key = keyOf(p);
    const baseQty = Number(p.quantity ?? 0);
    shopwareQuantities[key] = baseQty;

    if (equal) {
      scanPlan.push({ barcode: p.barcode ?? '', partNumber: p.partNumber ?? '', key, times: baseQty });
      return;
    }

    // equal === false: deterministic variance construction.
    const isLast = idx === products.length - 1;
    const isFirst = idx === 0;
    if (isLast) {
      // Expected in shopware, never scanned -> expected_not_counted.
      scanPlan.push({ barcode: p.barcode ?? '', partNumber: p.partNumber ?? '', key, times: 0 });
      return;
    }
    if (isFirst) {
      // Scanned a different quantity than shopware expects -> variance.
      scanPlan.push({ barcode: p.barcode ?? '', partNumber: p.partNumber ?? '', key, times: baseQty + 1 });
      return;
    }
    scanPlan.push({ barcode: p.barcode ?? '', partNumber: p.partNumber ?? '', key, times: baseQty });
  });

  return { scanPlan, shopwareQuantities };
}
