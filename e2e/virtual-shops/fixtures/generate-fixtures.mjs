// e2e/virtual-shops/fixtures/generate-fixtures.mjs
//
// Deterministic fixture generator for the Virtual Shops harness.
// See shops.config.mjs and docs/HISTORY.md (retired design, "Build task
// list", tasks 3, 5, 6, 7) and e2e/virtual-shops/README.md for the full map.
//
// Produces static, checked-in JSON/CSV fixtures for all four shop personas.
// Every read is offline (local better-sqlite3 corpus + hand-authored seed
// data, or the messy-spreadsheet generator already used by Teach Bot) - no
// network calls, no live providers, and no Date.now()-dependent output, so
// re-running this script produces byte-identical fixtures every time:
//
//   node e2e/virtual-shops/fixtures/generate-fixtures.mjs
//
// Reused machinery:
//   - src/decoding/server/knowledge/knowledge.generated.db (read-only, better-sqlite3) for the
//     Rincon Tire pull, mirroring scripts/seed-tires-from-corpus.ts's "read
//     the corpus, shape rows" pattern (that script's Firestore write path is
//     NOT reused - this generator never touches a network or a database
//     other than the local read-only SQLite file).
//   - e2e/teach/sheets.mjs's messy-spreadsheet generator + reconcile-plan
//     builder for Legacy Tires, reused as-is (imported, never modified).
//   - tools/fable5/fixtures/stress-codes.json (read-only) for Night Shift's
//     known-codes pool.
//
// Output fixture file names/shapes for rincon-tire.json and quickfix-auto.json
// intentionally match what e2e/virtual-shops/drivers/rincon-tire.mjs and
// drivers/quickfix-auto.mjs already load (their FALLBACK_FIXTURE constants
// document the exact contract: `{ known: [{code,label,...}], unknown: [code,...] }`
// and `{ items: [{code,label,...}] }`). Extra fields beyond `code`/`label`
// are additive and ignored by the current drivers; they exist for wave-3
// enhancements (e.g. size-merge assertions, pricing).
//
// Every "random" choice below is a seeded PRNG (mulberry32, same algorithm
// e2e/virtual-shops/drivers/_shared.mjs uses as createSeededRandom, and the
// same algorithm e2e/teach/sheets.mjs uses for junk text) or a pure
// deterministic transform - never Math.random(), never real time in output.

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { generateInventorySheet, buildReconcilePlan } from '../../teach/sheets.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const FIXTURES_DIR = __dirname;
const CORPUS_DB_PATH = path.join(REPO_ROOT, 'src/decoding/server/knowledge/knowledge.generated.db');
const STRESS_CODES_PATH = path.join(REPO_ROOT, 'tools/fable5/fixtures/stress-codes.json');

// ---------------------------------------------------------------------------
// Deterministic helpers (no Math.random, no Date.now in any output value)
// ---------------------------------------------------------------------------

/** mulberry32 seeded PRNG - identical algorithm to drivers/_shared.mjs's
 *  createSeededRandom and e2e/teach/sheets.mjs's seededRng, so behavior
 *  across the harness stays predictable for anyone reading multiple files. */
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

function pick(rng, list) {
  return list[Math.floor(rng() * list.length) % list.length];
}

/** Fisher-Yates shuffle driven by a seeded RNG - deterministic given the seed. */
function seededShuffle(list, rng) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** UPC-A check digit (standard mod-10 algorithm) so generated retail
 *  barcodes are shaped like real 12-digit UPC-A codes, not obviously fake. */
function upcCheckDigit(digits11) {
  let oddSum = 0;
  let evenSum = 0;
  for (let i = 0; i < 11; i += 1) {
    const d = Number(digits11[i]);
    if (i % 2 === 0) oddSum += d;
    else evenSum += d;
  }
  const total = oddSum * 3 + evenSum;
  return String((10 - (total % 10)) % 10);
}

/** Deterministic 12-digit UPC-A-shaped code from an integer seed (no
 *  collisions across the 0..99999 range used by buildQuickFixAuto). */
function deterministicUpc(seedNumber) {
  const base = String(11110000000 + Number(seedNumber)).padStart(11, '0').slice(-11);
  return base + upcCheckDigit(base);
}

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

async function writeJson(filePath, data) {
  await ensureDir(path.dirname(filePath));
  const json = `${JSON.stringify(data, null, 2)}\n`;
  await writeFile(filePath, json, 'utf8');
  return { filePath, bytes: Buffer.byteLength(json, 'utf8') };
}

// ---------------------------------------------------------------------------
// (a) Rincon Tire - ~800 real tire SKUs pulled offline from the corpus DB
// ---------------------------------------------------------------------------

const RINCON_TARGET_ROWS = 800;
const RINCON_MIN_GROUP_SIZES = 3; // a size-merge group needs >= 3 distinct sizes to be interesting
const RINCON_MAX_GROUP_ROWS = 8; // cap so a handful of groups don't dominate the 800-row budget
const RINCON_GROUP_COUNT = 25;

function buildRinconTire() {
  const db = new Database(CORPUS_DB_PATH, { readonly: true, fileMustExist: true });
  try {
    // Deterministic group selection: alphabetical by (brand_normalized, model_normalized),
    // never LIMIT-with-RANDOM. These are the deliberate same-model/different-size groups
    // the design doc calls for, to exercise services/catalog/identityMerge.ts.
    const groups = db
      .prepare(
        `SELECT brand_normalized, model_normalized, COUNT(*) as rowCount, COUNT(DISTINCT size) as sizeCount
         FROM tires
         WHERE usable_for='auto_count_candidate' AND current_status='active_retail'
           AND brand_normalized <> '' AND model_normalized <> '' AND size <> ''
         GROUP BY brand_normalized, model_normalized
         HAVING sizeCount >= ? AND rowCount <= ?
         ORDER BY brand_normalized, model_normalized
         LIMIT ?`,
      )
      .all(RINCON_MIN_GROUP_SIZES, RINCON_MAX_GROUP_ROWS, RINCON_GROUP_COUNT);

    const rowStmt = db.prepare(
      `SELECT barcode, brand, model, model_display, size, load_index, speed_rating,
              manufacturer_part_number, canonical_product_uid, brand_normalized, model_normalized
       FROM tires
       WHERE brand_normalized = ? AND model_normalized = ?
         AND usable_for='auto_count_candidate' AND current_status='active_retail'
       ORDER BY size`,
    );

    const used = new Set();
    const known = [];
    const sizeMergeGroups = [];

    for (const group of groups) {
      const rows = rowStmt.all(group.brand_normalized, group.model_normalized);
      const groupKey = `${group.brand_normalized}::${group.model_normalized}`;
      const codesInGroup = [];
      for (const row of rows) {
        if (used.has(row.barcode)) continue;
        used.add(row.barcode);
        codesInGroup.push(row.barcode);
        known.push({
          code: row.barcode,
          label: `${row.brand} ${row.model_display} ${row.size}`.replace(/\s+/g, ' ').trim(),
          brand: row.brand,
          model: row.model_display,
          size: row.size,
          loadIndex: row.load_index,
          speedRating: row.speed_rating,
          manufacturerPartNumber: row.manufacturer_part_number,
          canonicalProductUid: row.canonical_product_uid,
          groupKey,
          sizeMergeGroupMember: true,
        });
      }
      if (codesInGroup.length >= 2) sizeMergeGroups.push({ groupKey, brand: group.brand_normalized, model: group.model_normalized, codes: codesInGroup });
    }

    const fillNeeded = RINCON_TARGET_ROWS - known.length;
    const candidates = db
      .prepare(
        `SELECT barcode, brand, model, model_display, size, load_index, speed_rating,
                manufacturer_part_number, canonical_product_uid, brand_normalized, model_normalized
         FROM tires
         WHERE usable_for='auto_count_candidate' AND current_status='active_retail'
         ORDER BY barcode
         LIMIT ?`,
      )
      .all(fillNeeded + used.size + 100);

    for (const row of candidates) {
      if (known.length >= RINCON_TARGET_ROWS) break;
      if (used.has(row.barcode)) continue;
      used.add(row.barcode);
      known.push({
        code: row.barcode,
        label: `${row.brand} ${row.model_display} ${row.size}`.replace(/\s+/g, ' ').trim(),
        brand: row.brand,
        model: row.model_display,
        size: row.size,
        loadIndex: row.load_index,
        speedRating: row.speed_rating,
        manufacturerPartNumber: row.manufacturer_part_number,
        canonicalProductUid: row.canonical_product_uid,
        groupKey: `${row.brand_normalized}::${row.model_normalized}`,
        sizeMergeGroupMember: false,
      });
    }

    // Vendor-label-shaped unknown codes (non-UPC, deliberately not resolvable):
    // matches CLAUDE.md's vendor_label routing (never treated as UPC/EAN/GTIN).
    const unknown = Array.from({ length: 10 }, (_, i) => `RINCONUNKNOWN${String(i + 1).padStart(3, '0')}`);

    const fixture = { known, unknown };
    const meta = {
      shopKey: 'rincon-tire',
      generatedFrom: 'src/decoding/server/knowledge/knowledge.generated.db (offline read-only SQL, better-sqlite3)',
      sourcePattern: 'scripts/seed-tires-from-corpus.ts (row-shaping only; this generator never writes to Firestore)',
      targetRows: RINCON_TARGET_ROWS,
      actualRows: known.length,
      sizeMergeGroupCount: sizeMergeGroups.length,
      sizeMergeGroups,
      unknownCodeCount: unknown.length,
      deterministic: true,
      notes:
        'known[] mixes deliberate same-model/different-size groups (sizeMergeGroupMember: true, ' +
        'grouped by groupKey) with single-size fill rows, all ordered by deterministic SQL ORDER BY ' +
        '(no LIMIT-with-RANDOM). Re-running this script against an unchanged corpus DB reproduces the ' +
        'same fixture byte-for-byte.',
    };
    return { fixture, meta };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// (b) QuickFix Auto - ~150 mixed non-tire retail items + error-injection table
// ---------------------------------------------------------------------------

const QUICKFIX_SEED = 20260729;
const QUICKFIX_TARGET_ITEMS = 150;

const QUICKFIX_CATEGORIES = [
  { name: 'Oil Filter', basePrice: 8.99 },
  { name: 'Air Filter', basePrice: 14.49 },
  { name: 'Cabin Air Filter', basePrice: 16.99 },
  { name: 'Wiper Blade', basePrice: 12.99 },
  { name: 'Brake Pad Set', basePrice: 42.99 },
  { name: 'Brake Rotor', basePrice: 54.99 },
  { name: 'Spark Plug', basePrice: 6.49 },
  { name: '12V Battery', basePrice: 119.99 },
  { name: 'Headlight Bulb', basePrice: 11.49 },
  { name: 'Motor Oil 5W-30 (Quart)', basePrice: 7.99 },
  { name: 'Coolant/Antifreeze (Gallon)', basePrice: 15.99 },
  { name: 'Brake Fluid DOT3', basePrice: 9.49 },
  { name: 'Serpentine Belt', basePrice: 24.99 },
  { name: 'Radiator Hose', basePrice: 19.99 },
  { name: 'Shop Rag Bundle', basePrice: 13.99 },
  { name: 'Floor Mat Set', basePrice: 34.99 },
  { name: 'Tire Pressure Gauge', basePrice: 9.99 },
  { name: 'Jump Starter Pack', basePrice: 59.99 },
  { name: 'Fuel Filter', basePrice: 17.49 },
  { name: 'Power Steering Fluid', basePrice: 8.49 },
];

const QUICKFIX_BRANDS = [
  'Fram', 'Bosch', 'ACDelco', 'Duralast', 'Champion', 'Mobil 1', 'Prestone', 'NGK',
  'Denso', 'Wagner', 'Monroe', 'Optima', 'Interstate', 'Rain-X', 'Anco', 'STP',
  'Castrol', 'Valvoline', 'K&N', 'Gates',
];

function buildQuickFixAuto() {
  const rng = seededRng(QUICKFIX_SEED);
  const combos = [];
  for (const category of QUICKFIX_CATEGORIES) {
    for (const brand of QUICKFIX_BRANDS) combos.push({ category, brand });
  }
  const shuffled = seededShuffle(combos, rng);
  const chosen = shuffled.slice(0, QUICKFIX_TARGET_ITEMS);
  // Restore a stable, readable order (category then brand) after the deterministic shuffle picked *which* combos to use.
  chosen.sort((a, b) => (a.category.name === b.category.name ? a.brand.localeCompare(b.brand) : a.category.name.localeCompare(b.category.name)));

  const items = chosen.map((combo, index) => {
    const priceRng = seededRng(QUICKFIX_SEED + index + 1);
    const priceVariance = (priceRng() - 0.5) * 2; // +/- $1.00 deterministic jitter around basePrice
    const unitPrice = Math.max(1, Math.round((combo.category.basePrice + priceVariance) * 100) / 100);
    const qtyRng = seededRng(QUICKFIX_SEED + index + 5000);
    const qtyOnHand = 1 + Math.floor(qtyRng() * 40);
    return {
      code: deterministicUpc(index),
      label: `${combo.brand} ${combo.category.name}`,
      sku: `QFA-${String(index + 1).padStart(3, '0')}`,
      category: combo.category.name,
      brand: combo.brand,
      unitPrice,
      qtyOnHand,
    };
  });

  // ---- error-injection table -------------------------------------------------
  // Documented reference table matching the design doc's "typo positions,
  // double-scan pairs, interrupt points" requirement. NOTE (see README.md):
  // the already-built e2e/virtual-shops/drivers/quickfix-auto.mjs computes its
  // OWN error class per scan slot at runtime via a seeded RNG + CLI-tunable
  // rates (createSeededRandom + pickErrorClass), so it does not currently read
  // this file. This table exists as (1) the reproducible reference the design
  // doc calls for and (2) a ready-made input for a future driver revision that
  // wants a pre-committed, reviewable error pattern instead of runtime-only
  // randomness.
  const TYPO_RATE = 0.08;
  const DOUBLE_SCAN_RATE = 0.1;
  const INTERRUPT_RATE = 0.03;
  const DAY_COUNT = 5;

  function injectTypo(code, positionRng) {
    const digits = code.split('');
    const dropPosition = 2 + Math.floor(positionRng() * (digits.length - 4));
    const dropped = digits.slice(0, dropPosition).concat(digits.slice(dropPosition + 1)).join('');
    const dupPosition = 2 + Math.floor(positionRng() * (digits.length - 4));
    const duplicated = digits.slice(0, dupPosition).concat([digits[dupPosition]], digits.slice(dupPosition)).join('');
    return { droppedDigit: dropped, extraDigit: duplicated };
  }

  const days = [];
  for (let dayIndex = 1; dayIndex <= DAY_COUNT; dayIndex += 1) {
    const dayRng = seededRng(QUICKFIX_SEED + dayIndex * 97);
    const typoInjections = [];
    const doubleScans = [];
    const interrupts = [];
    items.forEach((item, itemIndex) => {
      const roll = dayRng();
      if (roll < TYPO_RATE) {
        const variant = injectTypo(item.code, dayRng);
        typoInjections.push({
          itemIndex,
          code: item.code,
          typoType: dayRng() < 0.5 ? 'dropped-digit' : 'extra-digit',
          typoCode: dayRng() < 0.5 ? variant.droppedDigit : variant.extraDigit,
        });
      } else if (roll < TYPO_RATE + DOUBLE_SCAN_RATE) {
        doubleScans.push({ itemIndex, code: item.code });
      } else if (roll < TYPO_RATE + DOUBLE_SCAN_RATE + INTERRUPT_RATE) {
        interrupts.push({
          afterItemIndex: itemIndex,
          code: item.code,
          action: dayRng() < 0.5 ? 'reload' : 'navigate-away',
          resumeDelayMs: 200 + Math.floor(dayRng() * 800),
        });
      }
    });
    days.push({
      dayIndex,
      seed: QUICKFIX_SEED + dayIndex * 97,
      typoInjections,
      doubleScans,
      interrupts,
      counts: { typo: typoInjections.length, doubleScan: doubleScans.length, interrupt: interrupts.length },
    });
  }

  const errorInjection = {
    shopKey: 'quickfix-auto',
    consumedBy: 'NOT YET WIRED - drivers/quickfix-auto.mjs currently generates its own seeded error pattern at runtime (see notes above); this table is the design-doc-compliant reference for a future revision',
    rates: { typoRate: TYPO_RATE, doubleScanRate: DOUBLE_SCAN_RATE, interruptRate: INTERRUPT_RATE },
    itemCount: items.length,
    days,
  };

  const fixture = { items };
  const meta = {
    shopKey: 'quickfix-auto',
    generatedFrom: 'curated static catalog (retail-shaped, deterministic) - see README.md for why src/decoding/server/knowledge/retail/ was NOT used',
    targetItems: QUICKFIX_TARGET_ITEMS,
    actualItems: items.length,
    categoryCount: QUICKFIX_CATEGORIES.length,
    brandCount: QUICKFIX_BRANDS.length,
    deterministic: true,
    seed: QUICKFIX_SEED,
  };
  return { fixture, meta, errorInjection };
}

// ---------------------------------------------------------------------------
// (c) Legacy Tires - ugly spreadsheet (via e2e/teach/sheets.mjs) + ground truth
// ---------------------------------------------------------------------------

// Small legacy tire-shop product list. Includes a blank partNumber (missing
// part number ugliness), a blank barcode (mixed-format ugliness), and prices
// so the reconciliation ground truth can compute an exact dollar variance.
const LEGACY_PRODUCTS = [
  { partNumber: '28816861', brand: 'Falken', model: 'Sincera ST80 A/S', size: '215/70R15', barcode: '848983012906', name: 'Falken Sincera ST80 A/S', quantity: 6, unitPrice: 118.0 },
  { partNumber: '90000002732', brand: 'Cooper', model: 'Evolution Tour', size: '215/60R16', barcode: '', name: 'Cooper Evolution Tour', quantity: 4, unitPrice: 104.5 },
  { partNumber: '44953', brand: 'Michelin', model: 'Defender T+H', size: '225/65R17', barcode: '', name: 'Michelin Defender', quantity: 8, unitPrice: 168.75 },
  { partNumber: '', brand: 'Goodyear', model: 'Assurance WeatherReady', size: '235/60R18', barcode: '741089123456', name: 'Goodyear Assurance WeatherReady', quantity: 5, unitPrice: 189.99 },
  { partNumber: 'BFG-KO2-31105', brand: 'BFGoodrich', model: 'All-Terrain T/A KO2', size: '265/70R17', barcode: '790011223344', name: 'BFGoodrich All-Terrain T/A KO2', quantity: 10, unitPrice: 245.0 },
  { partNumber: '90000029683', brand: 'Cooper', model: 'Discoverer AT3 4S', size: '245/75R16', barcode: '', name: 'Cooper Discoverer AT3 4S', quantity: 3, unitPrice: 210.0 },
  { partNumber: '52121', brand: 'Continental', model: 'TrueContact Tour', size: '205/55R16', barcode: '683345667788', name: 'Continental TrueContact Tour', quantity: 7, unitPrice: 132.4 },
  { partNumber: '', brand: 'General', model: 'AltiMAX RT43', size: '215/65R16', barcode: '', name: 'General AltiMAX RT43', quantity: 9, unitPrice: 99.99 },
];

async function buildLegacyTires() {
  // e2e/teach/sheets.mjs is reused as-is (imported, never modified) per the design doc.
  const sheetMeta = await generateInventorySheet({
    level: 5, // blank title row + junk column + typo'd brand/model - the "ugliest" built-in level
    products: LEGACY_PRODUCTS,
    outDir: FIXTURES_DIR,
    fileBase: 'legacy-tires',
  });

  // Inject one exact-duplicate data row directly after the last product's row, to also exercise the
  // design doc's "duplicated rows" ugliness. This is a pure text-level addition on top of sheets.mjs's
  // output; it does NOT change LEGACY_PRODUCTS or the reconciliation math below (see ground-truth notes).
  const original = await readFile(sheetMeta.filePath, 'utf8');
  const lines = original.split('\r\n').filter((line) => line.length > 0);
  const lastDataLine = lines[lines.length - 1];
  const withDuplicate = `${original.trimEnd()}\r\n${lastDataLine}\r\n`;
  await writeFile(sheetMeta.filePath, withDuplicate, 'utf8');

  // buildReconcilePlan (reused as-is) builds a deterministic variance: the first product is
  // over-scanned by 1 (physical > book -> "found"), the last product is never scanned (physical <
  // book -> "missing"), everything else scans exactly at book quantity.
  const { scanPlan, shopwareQuantities } = buildReconcilePlan(LEGACY_PRODUCTS, { equal: false });

  const priceByKey = new Map(LEGACY_PRODUCTS.map((p) => [p.partNumber || p.barcode || p.name, p.unitPrice]));
  const nameByKey = new Map(LEGACY_PRODUCTS.map((p) => [p.partNumber || p.barcode || p.name, p.name]));

  let totalDollarVariance = 0;
  const perProduct = scanPlan.map((entry) => {
    const bookQuantity = shopwareQuantities[entry.key] ?? 0;
    const physicalQuantity = entry.times;
    const unitsDelta = physicalQuantity - bookQuantity;
    const unitPrice = priceByKey.get(entry.key) ?? 0;
    const dollarDelta = Math.round(unitsDelta * unitPrice * 100) / 100;
    totalDollarVariance += dollarDelta;
    return {
      key: entry.key,
      name: nameByKey.get(entry.key) ?? entry.key,
      partNumber: entry.partNumber,
      barcode: entry.barcode,
      bookQuantity,
      physicalQuantity,
      unitsDelta,
      unitPrice,
      dollarDelta,
    };
  });
  totalDollarVariance = Math.round(totalDollarVariance * 100) / 100;

  const groundTruth = {
    shopKey: 'legacy-tires',
    spreadsheetFile: path.relative(REPO_ROOT, sheetMeta.filePath).replace(/\\/g, '/'),
    spreadsheetFormat: sheetMeta.format,
    spreadsheetLevel: sheetMeta.level,
    spreadsheetNotes: sheetMeta.notes,
    uglinessFeaturesPresent: [
      'blank title row before headers',
      'blank row before headers',
      'renamed/shuffled column headers (PN/Make/Product/Junk Column/Tire Size/QOH/UPC/Item Name)',
      'junk column with no mapped field',
      "typo'd brand/model text (deterministic vowel-drop transform)",
      'missing part numbers (2 of 8 products)',
      'missing barcodes (3 of 8 products, mixed formats)',
      'one exact-duplicate data row appended after generation',
    ],
    duplicateRowAssumption:
      'Ground truth below assumes the importer collapses an exact-duplicate row to the SAME quantity as ' +
      'the original (never drops the row, never sums it again) - the common/sane import behavior. If the ' +
      'app instead sums duplicate-row quantities, the last product\'s bookQuantity here would be off by ' +
      'its own quantity and this ground truth needs re-deriving; flagged for wave-3 to verify against the ' +
      'real import path before treating this fixture as gospel.',
    bookCountSource: 'shopwareQuantities from e2e/teach/sheets.mjs buildReconcilePlan({ equal: false }) - matches the imported spreadsheet quantities above',
    physicalCountSource: 'scanPlan.times from the same buildReconcilePlan() call - the exact sequence a wave-3 driver should scan to reproduce this ground truth',
    perProduct,
    totalDollarVariance,
    narrative:
      totalDollarVariance >= 0
        ? `We found you $${totalDollarVariance.toFixed(2)} in inventory the spreadsheet undercounted.`
        : `We found $${Math.abs(totalDollarVariance).toFixed(2)} of inventory the spreadsheet overcounted (missing stock).`,
  };

  const groundTruthPath = path.join(FIXTURES_DIR, 'legacy-tires-ground-truth.json');
  const written = await writeJson(groundTruthPath, groundTruth);
  return {
    csvFile: sheetMeta.filePath,
    groundTruthFile: written.filePath,
    totalDollarVariance,
    productCount: LEGACY_PRODUCTS.length,
  };
}

// ---------------------------------------------------------------------------
// (d) Night Shift - offline/refresh/retry scan sequence over stress-codes.json
// ---------------------------------------------------------------------------

const NIGHT_SHIFT_DAYS = 3;
const NIGHT_SHIFT_BURST_SIZE = 10;

async function buildNightShift() {
  const raw = await readFile(STRESS_CODES_PATH, 'utf8');
  const stressCodes = JSON.parse(raw);
  const codes = stressCodes.codes;
  if (!Array.isArray(codes) || codes.length === 0) {
    throw new Error(`No codes found in ${STRESS_CODES_PATH}`);
  }

  const days = [];
  for (let dayIndex = 1; dayIndex <= NIGHT_SHIFT_DAYS; dayIndex += 1) {
    // Deterministic rotating window into the shared code pool - a different slice per day,
    // wrapping around with modulo (no randomness needed for "different day, different codes").
    const startOffset = ((dayIndex - 1) * NIGHT_SHIFT_BURST_SIZE) % codes.length;
    const burst = [];
    for (let i = 0; i < NIGHT_SHIFT_BURST_SIZE; i += 1) burst.push(codes[(startOffset + i) % codes.length]);

    days.push({
      dayIndex,
      phases: [
        { phase: 'offline-burst', offline: true, scans: burst },
        { phase: 'refresh-mid-session', action: 'reload', offlineDuringReload: true },
        { phase: 'reconnect', action: 'go-online' },
        {
          phase: 'retry-storm',
          action: 'trigger-pending-sync-retry',
          retryCount: 3,
          note:
            'Resubmit the SAME pending ScanEvents created during offline-burst (via the app\'s own retry ' +
            'mechanism / reconnect drain, never by re-scanning). Every ScanEvent keeps the idempotencyKey ' +
            'it was assigned at scan time; retrying must never create a duplicate InventoryCount.scanEventIds entry.',
        },
      ],
      expected: {
        totalScansThisDay: burst.length,
        totalCountedThisDay: burst.length,
        pendingQueueDrainedAfterReconnect: true,
        duplicateCountsAfterRetryStorm: 0,
      },
    });
  }

  const scanSequence = {
    shopKey: 'night-shift',
    source: 'Codes reused read-only from tools/fable5/fixtures/stress-codes.json (not modified); this shop is about the sync/reliability layer, not catalog realism.',
    sourceCodesFile: 'tools/fable5/fixtures/stress-codes.json',
    codePoolSize: codes.length,
    burstSizePerDay: NIGHT_SHIFT_BURST_SIZE,
    deterministic: true,
    days,
  };

  const filePath = path.join(FIXTURES_DIR, 'night-shift-scan-sequence.json');
  const written = await writeJson(filePath, scanSequence);
  return { filePath: written.filePath, days: NIGHT_SHIFT_DAYS, burstSizePerDay: NIGHT_SHIFT_BURST_SIZE, codePoolSize: codes.length };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const results = {};

  const { fixture: rinconFixture, meta: rinconMeta } = buildRinconTire();
  const rinconWritten = await writeJson(path.join(FIXTURES_DIR, 'rincon-tire.json'), rinconFixture);
  const rinconMetaWritten = await writeJson(path.join(FIXTURES_DIR, 'rincon-tire.meta.json'), rinconMeta);
  results.rinconTire = {
    file: path.relative(REPO_ROOT, rinconWritten.filePath).replace(/\\/g, '/'),
    bytes: rinconWritten.bytes,
    metaFile: path.relative(REPO_ROOT, rinconMetaWritten.filePath).replace(/\\/g, '/'),
    knownRows: rinconFixture.known.length,
    unknownRows: rinconFixture.unknown.length,
    sizeMergeGroups: rinconMeta.sizeMergeGroupCount,
  };

  const { fixture: quickfixFixture, meta: quickfixMeta, errorInjection } = buildQuickFixAuto();
  const quickfixWritten = await writeJson(path.join(FIXTURES_DIR, 'quickfix-auto.json'), quickfixFixture);
  const quickfixMetaWritten = await writeJson(path.join(FIXTURES_DIR, 'quickfix-auto.meta.json'), quickfixMeta);
  const errorInjectionWritten = await writeJson(path.join(FIXTURES_DIR, 'quickfix-auto-error-injection.json'), errorInjection);
  results.quickfixAuto = {
    file: path.relative(REPO_ROOT, quickfixWritten.filePath).replace(/\\/g, '/'),
    bytes: quickfixWritten.bytes,
    metaFile: path.relative(REPO_ROOT, quickfixMetaWritten.filePath).replace(/\\/g, '/'),
    errorInjectionFile: path.relative(REPO_ROOT, errorInjectionWritten.filePath).replace(/\\/g, '/'),
    items: quickfixFixture.items.length,
  };

  const legacy = await buildLegacyTires();
  results.legacyTires = {
    csvFile: path.relative(REPO_ROOT, legacy.csvFile).replace(/\\/g, '/'),
    groundTruthFile: path.relative(REPO_ROOT, legacy.groundTruthFile).replace(/\\/g, '/'),
    totalDollarVariance: legacy.totalDollarVariance,
    productCount: legacy.productCount,
  };

  const nightShift = await buildNightShift();
  results.nightShift = {
    file: path.relative(REPO_ROOT, nightShift.filePath).replace(/\\/g, '/'),
    days: nightShift.days,
    burstSizePerDay: nightShift.burstSizePerDay,
    codePoolSize: nightShift.codePoolSize,
  };

  console.log(JSON.stringify({ generated: results }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
