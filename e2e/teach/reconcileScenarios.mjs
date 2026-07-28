// e2e/teach/reconcileScenarios.mjs
//
// "Teach Bot" reconcile test-data generator. Pure Node ESM, no app source
// imports (mirrors the app's real reconcile header-synonym / matcher rules,
// does NOT import them - same pattern as sheets.mjs).
//
// Produces:
//  1. A base-catalog CSV ("our" imported inventory, known quantities).
//  2. Many "customer exported from their native software" reconcile files,
//     in different formats/headers, referencing the SAME real tire products,
//     each row annotated with the EXPECTED reconcile outcome (bucket + delta)
//     so a lesson can assert reconcile behavior end to end.
//
// Deterministic: no Math.random, no Date.now() in generated content, so two
// calls with the same inputs produce byte-identical files.

import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';

// ---------------------------------------------------------------------------
// Real corpus tire products (verified: barcode + brand + model + size + PN).
// ---------------------------------------------------------------------------

const TIRE_PRODUCTS = [
  { barcode: '848983006257', brand: 'Falken', model: 'Wildpeak A/T3W', size: '265/70R17', pn: '28034300' },
  { barcode: '848983007933', brand: 'Falken', model: 'Rubitrek A/T', size: '265/70R17', pn: '28074576' },
  { barcode: '191563016307', brand: 'Nexen', model: 'Roadian ATX', size: '265/70R17', pn: '18773NXK' },
  { barcode: '715459268979', brand: 'Hankook', model: 'Dynapro ATM RF10', size: 'LT265/70R17', pn: '2001383' },
  { barcode: '721506160851', brand: 'Yokohama', model: 'Geolandar X-AT', size: '265/70R17', pn: '110116085' },
  { barcode: '029142869870', brand: 'Cooper', model: 'Discoverer SRX', size: '265/70R17', pn: '90000027117' },
  { barcode: '697662155133', brand: 'Goodyear', model: 'Wrangler Territory RT', size: '235/65R17', pn: '710004933' },
  { barcode: '092971251802', brand: 'Bridgestone', model: 'Dueler H/P Sport AS', size: '225/65R17', pn: '142367' },
  { barcode: '086699449535', brand: 'Michelin', model: 'Premier LTX', size: '225/65R17', pn: '44953' },
  { barcode: '051342150847', brand: 'Continental', model: 'ProContact TX', size: '235/60R18', pn: '15493460000' },
  { barcode: '054137079934', brand: 'Pirelli', model: 'Cinturato P7 All Season', size: '235/55R18', pn: '3655800' },
  { barcode: '8808956132873', brand: 'Kumho', model: 'Eco Solus KL21', size: '225/65R17', pn: '2159273' },
  { barcode: '697662056829', brand: 'Dunlop', model: 'Grandtrek AT20', size: 'P245/75R16', pn: '290105537' },
  { barcode: '086699028181', brand: 'BFGoodrich', model: 'All-Terrain T/A KO', size: 'LT275/65R18', pn: '02818' },
  { barcode: '4981910526605', brand: 'Toyo', model: 'Open Country A/T3', size: 'LT275/70R18', pn: '355520' },
];

// Deterministic per-product "our counted truth" quantities for the first 12
// (imported) products. Index-aligned with TIRE_PRODUCTS.
const OUR_QTYS = [5, 3, 8, 2, 6, 4, 10, 7, 9, 1, 5, 3];

/** First 12 products: our imported base catalog, with our counted quantity. */
export const BASE_CATALOG = TIRE_PRODUCTS.slice(0, 12).map((p, i) => ({
  ...p,
  ourQty: OUR_QTYS[i],
}));

/** Last 3 products (Dunlop, BFGoodrich, Toyo): never imported into our catalog. */
export const RESERVED = TIRE_PRODUCTS.slice(12);

// ---------------------------------------------------------------------------
// Header normalization + accepted synonym sets (mirrors the app's reconcile
// import mapper rules, does not import them).
// ---------------------------------------------------------------------------

export function normalizeHeader(h) {
  return String(h ?? '').trim().toLowerCase().replace(/\s+/g, '_');
}

export const ACCEPTED_PN_HEADERS = new Set(['part_number', 'sku', 'pn', 'part_no', 'item_no', 'mfg_part_number']);
export const ACCEPTED_QTY_HEADERS = new Set(['qty_on_hand', 'qoh', 'on_hand', 'qty_available', 'available']);
export const ACCEPTED_BRAND_HEADERS = new Set(['brand', 'make']);
export const ACCEPTED_MODEL_HEADERS = new Set(['model']);
export const ACCEPTED_SIZE_HEADERS = new Set(['size', 'tire_size']);
export const ACCEPTED_SPECS_HEADERS = new Set(['specs', 'description']);

// ---------------------------------------------------------------------------
// Small deterministic helpers (no Math.random anywhere).
// ---------------------------------------------------------------------------

/** Deterministic typo transform: removes the first non-leading vowel. Keeps
 *  identifiers (partNumber/barcode) untouched by callers - only ever applied
 *  to brand/model display text, so fuzzy matching should still tolerate it. */
function typoify(str) {
  if (!str) return str;
  const chars = String(str).split('');
  const idx = chars.findIndex((c, i) => i > 0 && /[aeiou]/i.test(c));
  if (idx > -1) chars.splice(idx, 1);
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

/** Parses a tire size like "LT265/70R17" / "P245/75R16" / "235/65R17". */
function sizeParts(size) {
  const m = /^([A-Za-z]*)(\d{3})\/(\d{2})R(\d{2})$/.exec(String(size));
  if (!m) throw new Error(`sizeParts: cannot parse size "${size}"`);
  return { prefix: m[1], width: m[2], aspect: m[3], rim: m[4] };
}

/** Renders a size in one of three notations: slash keeps the prefix + slash +
 *  R; spaces/dashes drop the prefix and the R, per the spec's normalization
 *  rule (matcher treats these three as equal after normalization). */
export function sizeToNotation(size, notation) {
  const { prefix, width, aspect, rim } = sizeParts(size);
  if (notation === 'slash') return `${prefix}${width}/${aspect}R${rim}`;
  if (notation === 'spaces') return `${width} ${aspect} ${rim}`;
  if (notation === 'dashes') return `${width}-${aspect}-${rim}`;
  throw new Error(`sizeToNotation: unknown notation "${notation}"`);
}

const JUNK_CHOICES = ['n/a', 'x', 'TBD', '-'];
function junkValue(rowIndex) {
  return JUNK_CHOICES[rowIndex % JUNK_CHOICES.length];
}

// ---------------------------------------------------------------------------
// writeBaseCatalogCsv
// ---------------------------------------------------------------------------

/**
 * Writes catalog.csv: our Universal Import base catalog.
 * Headers: name,brand,model,size,barcode,quantity (canonical, slash size notation).
 * @param {string} outDir
 * @returns {Promise<{ filePath: string, products: typeof BASE_CATALOG }>}
 */
export async function writeBaseCatalogCsv(outDir) {
  await mkdir(outDir, { recursive: true });
  const headers = ['name', 'brand', 'model', 'size', 'barcode', 'quantity'];
  const lines = [writeDelimitedRow(headers, ',')];
  for (const p of BASE_CATALOG) {
    const name = `${p.brand} ${p.model}`;
    lines.push(
      writeDelimitedRow([name, p.brand, p.model, sizeToNotation(p.size, 'slash'), p.barcode, p.ourQty], ','),
    );
  }
  const content = lines.join('\r\n') + '\r\n';
  const filePath = path.join(outDir, 'catalog.csv');
  await writeFile(filePath, content, 'utf8');
  return { filePath, products: BASE_CATALOG };
}

// ---------------------------------------------------------------------------
// Reconcile scenario definitions.
// ---------------------------------------------------------------------------

/**
 * expectedDelta = ourCountedQty - customerQty (positive = we are OVER vs the
 * customer file, negative = we are SHORT vs the customer file).
 */
export const SCENARIOS = [
  {
    key: 'agreement',
    bucket: 'agreement',
    computeCustomerQty: (ourQty) => ourQty,
    computeDelta: () => 0,
    typo: false,
    conflictBrand: false,
    notCounted: false,
  },
  {
    key: 'short_by_2',
    // Customer's software says 2 MORE than we counted -> we are short by 2.
    bucket: 'variance',
    computeCustomerQty: (ourQty) => ourQty + 2,
    computeDelta: () => -2,
    typo: false,
    conflictBrand: false,
    notCounted: false,
  },
  {
    key: 'over_by_1',
    // Customer's software says 1 LESS than we counted -> we are over by 1.
    bucket: 'variance',
    computeCustomerQty: (ourQty) => ourQty - 1,
    computeDelta: () => 1,
    typo: false,
    conflictBrand: false,
    notCounted: false,
  },
  {
    key: 'same_desc_agree',
    // Typo'd brand+model, cosmetic-only difference; qty agrees -> still agreement.
    bucket: 'agreement',
    computeCustomerQty: (ourQty) => ourQty,
    computeDelta: () => 0,
    typo: true,
    conflictBrand: false,
    notCounted: false,
  },
  {
    key: 'ambiguous',
    // PN present but paired with a CONFLICTING brand -> PN alone isn't trusted
    // and the conflicting brand actively contradicts it -> ambiguous.
    bucket: 'ambiguous',
    computeCustomerQty: (ourQty) => ourQty,
    computeDelta: () => null,
    typo: false,
    conflictBrand: true,
    notCounted: false,
  },
  {
    key: 'expected_not_counted',
    // A RESERVED product: present in the customer file, never imported/counted by us.
    bucket: 'expected_not_counted',
    computeCustomerQty: () => 4,
    computeDelta: () => null,
    typo: false,
    conflictBrand: false,
    notCounted: true,
  },
];

const SCENARIO_BY_KEY = Object.fromEntries(SCENARIOS.map((s) => [s.key, s]));

/** Deterministic per-vendor-file scenario assignment across BASE_CATALOG
 *  indices 0-7, plus RESERVED[0] for expected_not_counted. */
const ASSIGNMENT = [
  { productIndex: 0, scenarioKey: 'agreement' },
  { productIndex: 1, scenarioKey: 'short_by_2' },
  { productIndex: 2, scenarioKey: 'over_by_1' },
  { productIndex: 3, scenarioKey: 'same_desc_agree' },
  { productIndex: 4, scenarioKey: 'agreement' },
  { productIndex: 5, scenarioKey: 'agreement' },
  { productIndex: 6, scenarioKey: 'ambiguous' },
  { productIndex: 7, scenarioKey: 'agreement' },
];

// ---------------------------------------------------------------------------
// Vendor format descriptors.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} VendorFormat
 * @property {string} key
 * @property {'csv'|'tsv'|'xlsx'} ext
 * @property {string|null} delimiter
 * @property {string} pnHeader - literal header text written to file
 * @property {string} qtyHeader
 * @property {'slash'|'spaces'|'dashes'|null} sizeNotation
 * @property {'separate'|'mashed'|'none'} brandModel
 * @property {string} [brandHeader]
 * @property {string} [modelHeader]
 * @property {string} [descHeader]
 * @property {string} [sizeHeader]
 * @property {boolean} [barcodeColumn]
 * @property {string} [barcodeHeader]
 * @property {object} [quirks]
 * @property {string} description
 */

export const VENDOR_FORMATS = [
  {
    key: 'shopware',
    ext: 'csv',
    delimiter: ',',
    pnHeader: 'Part Number',
    qtyHeader: 'Qty On Hand',
    sizeNotation: 'slash',
    brandModel: 'separate',
    brandHeader: 'Brand',
    modelHeader: 'Model',
    sizeHeader: 'Size',
    description: 'Shop-Ware style export: clean columns, canonical part_number/qty_on_hand headers.',
  },
  {
    key: 'generic_pos',
    ext: 'csv',
    delimiter: ',',
    pnHeader: 'SKU',
    qtyHeader: 'Qty Available',
    sizeNotation: 'dashes',
    brandModel: 'mashed',
    descHeader: 'Description',
    sizeHeader: 'Size',
    description: 'Generic POS export: SKU + Description (brand+model mashed together), dash size notation.',
  },
  {
    key: 'tire_distributor',
    ext: 'csv',
    delimiter: ',',
    pnHeader: 'PN',
    qtyHeader: 'On Hand',
    sizeNotation: 'spaces',
    brandModel: 'separate',
    brandHeader: 'Make',
    modelHeader: 'Model',
    sizeHeader: 'Tire Size',
    description: 'Tire distributor export: spaces size notation, abbreviated headers.',
  },
  {
    key: 'quickbooks_messy',
    ext: 'csv',
    delimiter: ',',
    pnHeader: 'Part No',
    qtyHeader: 'QOH',
    sizeNotation: 'dashes',
    brandModel: 'separate',
    brandHeader: 'Make',
    modelHeader: 'Product',
    sizeHeader: 'Size',
    quirks: { blankTitleRow: true, junkColumn: true, typoBrandModel: true },
    description: 'QuickBooks/Excel-messy export: blank title row, junk column, typo\'d brand/model throughout.',
  },
  {
    key: 'minimal_pnqty',
    ext: 'csv',
    delimiter: ',',
    pnHeader: 'Item No',
    qtyHeader: 'Qty On Hand',
    sizeNotation: null,
    brandModel: 'none',
    description: 'Minimal export: PN + qty columns only, no brand/model/size/barcode.',
  },
  {
    key: 'barcode_based',
    ext: 'csv',
    delimiter: ',',
    pnHeader: 'Mfg Part Number',
    qtyHeader: 'Qty Available',
    sizeNotation: 'slash',
    brandModel: 'separate',
    brandHeader: 'Brand',
    modelHeader: 'Model',
    sizeHeader: 'Size',
    barcodeColumn: true,
    barcodeHeader: 'Barcode',
    description: 'Barcode-forward export: adds a Barcode column alongside PN/brand/model/size.',
  },
  {
    key: 'failing_pslashsn',
    ext: 'csv',
    delimiter: ',',
    pnHeader: 'P/SN',
    qtyHeader: 'Qty On Hand',
    sizeNotation: 'slash',
    brandModel: 'separate',
    brandHeader: 'Brand',
    modelHeader: 'Model',
    sizeHeader: 'Size',
    description: 'Unrecognized "P/SN" PN header - whole file should reconcile-import-error.',
  },
  {
    key: 'failing_usnumber',
    ext: 'csv',
    delimiter: ',',
    pnHeader: 'US Number',
    qtyHeader: 'On Hand',
    sizeNotation: 'spaces',
    brandModel: 'mashed',
    descHeader: 'Description',
    sizeHeader: 'Size',
    description: 'Unrecognized "US Number" PN header - whole file should reconcile-import-error.',
  },
  {
    key: 'tsv_variant',
    ext: 'tsv',
    delimiter: '\t',
    pnHeader: 'SKU',
    qtyHeader: 'QOH',
    sizeNotation: 'dashes',
    brandModel: 'mashed',
    descHeader: 'Description',
    sizeHeader: 'Size',
    description: 'Tab-separated export, SKU + QOH headers, mashed description column.',
  },
  {
    key: 'xlsx_variant',
    ext: 'xlsx',
    delimiter: null,
    pnHeader: 'Mfg Part Number',
    qtyHeader: 'Qty Available',
    sizeNotation: 'slash',
    brandModel: 'separate',
    brandHeader: 'Brand',
    modelHeader: 'Model',
    sizeHeader: 'Size',
    quirks: { extraColumns: ['Warehouse', 'Cost'] },
    description: 'XLSX workbook export with extra distributor columns (Warehouse, Cost).',
  },
];

function computeExpectFileError(format) {
  return !ACCEPTED_PN_HEADERS.has(normalizeHeader(format.pnHeader));
}

// ---------------------------------------------------------------------------
// Row planning: turns (product, scenario, format) into written values +
// the expected annotation.
// ---------------------------------------------------------------------------

function planRow({ product, scenarioKey, format, conflictBrandName }) {
  let scenario = SCENARIO_BY_KEY[scenarioKey];
  // Formats with no brand/model column at all can't express typo'd or
  // conflicting-brand scenarios - fall back to plain agreement for those slots.
  if (format.brandModel === 'none' && (scenario.key === 'same_desc_agree' || scenario.key === 'ambiguous')) {
    scenario = SCENARIO_BY_KEY.agreement;
  }

  const ourQty = product.ourQty ?? 0;
  const customerQty = scenario.computeCustomerQty(ourQty);
  const applyTypo = scenario.typo || Boolean(format.quirks?.typoBrandModel);

  const displayBrand = scenario.conflictBrand ? conflictBrandName : product.brand;
  const brandValue = applyTypo && !scenario.conflictBrand ? typoify(displayBrand) : displayBrand;
  const modelValue = applyTypo ? typoify(product.model) : product.model;
  const sizeValue = format.sizeNotation ? sizeToNotation(product.size, format.sizeNotation) : null;

  return {
    pnValue: product.pn,
    barcodeValue: product.barcode,
    brandValue,
    modelValue,
    sizeValue,
    qtyValue: customerQty,
    expected: {
      key: product.pn,
      brand: brandValue,
      model: modelValue,
      size: sizeValue,
      bucket: scenario.bucket,
      delta: scenario.computeDelta(),
    },
  };
}

function buildPlannedRows(format) {
  const rows = [];
  for (const { productIndex, scenarioKey } of ASSIGNMENT) {
    const product = BASE_CATALOG[productIndex];
    const conflictBrandName = BASE_CATALOG[(productIndex + 5) % BASE_CATALOG.length].brand;
    rows.push(planRow({ product, scenarioKey, format, conflictBrandName }));
  }
  // Reserved product row: expected_not_counted.
  rows.push(planRow({ product: RESERVED[0], scenarioKey: 'expected_not_counted', format, conflictBrandName: null }));
  return rows;
}

// ---------------------------------------------------------------------------
// File writers per format shape.
// ---------------------------------------------------------------------------

function buildHeaderAndGetters(format) {
  const headers = [format.pnHeader];
  const getters = [(r) => r.pnValue];

  if (format.brandModel === 'separate') {
    headers.push(format.brandHeader, format.modelHeader);
    getters.push((r) => r.brandValue, (r) => r.modelValue);
  } else if (format.brandModel === 'mashed') {
    headers.push(format.descHeader);
    getters.push((r) => `${r.brandValue} ${r.modelValue}`);
  }

  if (format.sizeNotation) {
    headers.push(format.sizeHeader);
    getters.push((r) => r.sizeValue);
  }

  if (format.barcodeColumn) {
    headers.push(format.barcodeHeader);
    getters.push((r) => r.barcodeValue);
  }

  headers.push(format.qtyHeader);
  getters.push((r) => r.qtyValue);

  if (format.quirks?.extraColumns) {
    for (const extraHeader of format.quirks.extraColumns) {
      headers.push(extraHeader);
      getters.push((_r, rowIndex) => (extraHeader === 'Cost' ? (25.5 + rowIndex).toFixed(2) : `WH-${(rowIndex % 3) + 1}`));
    }
  }

  if (format.quirks?.junkColumn) {
    headers.push('Notes');
    getters.push((_r, rowIndex) => junkValue(rowIndex));
  }

  return { headers, getters };
}

async function writeDelimitedFile(format, rows, outDir) {
  const { headers, getters } = buildHeaderAndGetters(format);
  const lines = [];
  if (format.quirks?.blankTitleRow) {
    lines.push('My Shop Export 2026');
    lines.push('');
  }
  lines.push(writeDelimitedRow(headers, format.delimiter));
  rows.forEach((row, rowIndex) => {
    lines.push(writeDelimitedRow(getters.map((get) => get(row, rowIndex)), format.delimiter));
  });
  const content = lines.join('\r\n') + '\r\n';
  const filePath = path.join(outDir, `${format.key}.${format.ext}`);
  await writeFile(filePath, content, 'utf8');
  return filePath;
}

async function writeXlsxFile(format, rows, outDir) {
  const { headers, getters } = buildHeaderAndGetters(format);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Reconcile');
  sheet.addRow(headers);
  rows.forEach((row, rowIndex) => {
    sheet.addRow(getters.map((get) => get(row, rowIndex)));
  });
  const filePath = path.join(outDir, `${format.key}.${format.ext}`);
  await workbook.xlsx.writeFile(filePath);
  return filePath;
}

// ---------------------------------------------------------------------------
// buildReconcileMatrix
// ---------------------------------------------------------------------------

/**
 * Builds one customer reconcile file per VENDOR_FORMATS entry, each spanning
 * ~8 catalog products + 1 reserved product, annotated with the expected
 * reconcile outcome per row.
 * @param {string} outDir
 * @returns {Promise<Array<{ name: string, formatKey: string, filePath: string, ext: string, expectFileError: boolean, expected: Array<object> }>>}
 */
export async function buildReconcileMatrix(outDir) {
  await mkdir(outDir, { recursive: true });
  const cases = [];

  for (const format of VENDOR_FORMATS) {
    const rows = buildPlannedRows(format);
    const expectFileError = computeExpectFileError(format);

    let filePath;
    if (format.ext === 'xlsx') {
      filePath = await writeXlsxFile(format, rows, outDir);
    } else {
      filePath = await writeDelimitedFile(format, rows, outDir);
    }

    cases.push({
      name: `${format.key} reconcile file`,
      formatKey: format.key,
      filePath,
      ext: format.ext,
      expectFileError,
      expected: expectFileError ? [] : rows.map((r) => r.expected),
    });
  }

  return cases;
}
