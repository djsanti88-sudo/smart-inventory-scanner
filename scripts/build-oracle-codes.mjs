// Build the correctness-oracle dataset for the Teach Bot harness.
//
// Ground truth = the app's OWN product corpus. A code that exists in the
// corpus SHOULD resolve to that corpus product's identity when scanned.
// This one-off extractor samples codes with a CLEAR product identity
// (barcode + brand + model/name) and writes them to
// testing/app-knowledge/oracle-codes.json.
//
// Sources:
//   1. src/server/tire-knowledge/tireKnowledge.generated.json (git-tracked,
//      plain JSON) -> barcodeIndex -> { brand, model, size, barcode_type, ... }
//   2. benchmarks/phase1_100_codes.csv (already has expectedName/expectedBrand/
//      expectedSource columns) -> folded in verbatim.
//
// Read-only over product source. Writes ONLY under testing/. Run:
//   node scripts/build-oracle-codes.mjs
//
// This is a build/extraction tool, not part of the test suite. The committed
// oracle-codes.json is the artifact the harness consumes; re-run this only to
// regenerate it.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const TIRE_CORPUS = resolve(repoRoot, 'src/server/tire-knowledge/tireKnowledge.generated.json');
const PHASE1_CSV = resolve(repoRoot, 'benchmarks/phase1_100_codes.csv');
const OUT_PATH = resolve(repoRoot, 'testing/app-knowledge/oracle-codes.json');

// How many tire-corpus codes to sample. Kept in the 30-80 band the harness
// wants; we spread the pick across the corpus so it is not all one brand.
const TIRE_SAMPLE_COUNT = 60;

/** Title-case a corpus slug like "wildpeak_a_t3w" -> "Wildpeak A T3w". */
function humanizeSlug(slug) {
  if (!slug || typeof slug !== 'string') return '';
  return slug
    .replace(/_/g, ' ')
    .trim()
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/** Build a human-readable expected product name from a tire corpus entry. */
function tireExpectedName(entry) {
  const brand = humanizeSlug(entry.brand);
  const model = humanizeSlug(entry.model);
  const size = (entry.size || '').trim();
  return [brand, model, size].filter(Boolean).join(' ').trim();
}

function extractTireCodes() {
  const raw = JSON.parse(readFileSync(TIRE_CORPUS, 'utf8'));
  const index = raw.barcodeIndex || {};
  const keys = Object.keys(index);

  // Only codes with a clear identity: a real public barcode shape (upc/ean/
  // gtin), a non-empty brand, and a non-empty model. Skip vendor/internal
  // shapes so the oracle is a fair "corpus code should resolve" test.
  const eligible = keys.filter((code) => {
    const e = index[code];
    if (!e) return false;
    const bt = (e.barcode_type || '').toLowerCase();
    const publicShape = bt === 'upc' || bt === 'ean' || bt === 'gtin' || bt === 'ean13';
    return (
      publicShape &&
      /^\d{8,14}$/.test(code) &&
      String(e.brand || '').trim() !== '' &&
      String(e.model || '').trim() !== ''
    );
  });

  // Deterministic, spread-out sample: even stride across the eligible list so
  // we do not get 60 rows of the same brand that happen to sort together.
  const stride = Math.max(1, Math.floor(eligible.length / TIRE_SAMPLE_COUNT));
  const picked = [];
  const seenBarcodes = new Set();
  for (let i = 0; i < eligible.length && picked.length < TIRE_SAMPLE_COUNT; i += stride) {
    const code = eligible[i];
    if (seenBarcodes.has(code)) continue;
    seenBarcodes.add(code);
    const e = index[code];
    picked.push({
      code,
      expectedName: tireExpectedName(e),
      expectedBrand: humanizeSlug(e.brand),
      source: 'corpus',
    });
  }
  return picked;
}

/** Minimal CSV line splitter that respects double-quoted fields. */
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function extractPhase1Codes() {
  const text = readFileSync(PHASE1_CSV, 'utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]).map((h) => h.trim());
  const col = (name) => headers.indexOf(name);
  const iCode = col('code');
  const iName = col('expectedName');
  const iBrand = col('expectedBrand');
  const iSource = col('expectedSource');

  const rows = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const code = (cells[iCode] || '').trim();
    if (!code) continue;
    rows.push({
      code,
      expectedName: (cells[iName] || '').trim(),
      expectedBrand: (cells[iBrand] || '').trim(),
      source: (cells[iSource] || '').trim() || 'benchmark',
    });
  }
  return rows;
}

function main() {
  const tire = extractTireCodes();
  const phase1 = extractPhase1Codes();

  // Merge; de-dupe by code (corpus wins if a code somehow appears in both).
  const byCode = new Map();
  for (const row of tire) byCode.set(row.code, row);
  for (const row of phase1) {
    if (!byCode.has(row.code)) byCode.set(row.code, row);
  }
  const merged = [...byCode.values()];

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(merged, null, 2) + '\n', 'utf8');

  const bySource = merged.reduce((acc, r) => {
    acc[r.source] = (acc[r.source] || 0) + 1;
    return acc;
  }, {});
  console.log(`Wrote ${merged.length} oracle codes to ${OUT_PATH}`);
  console.log(`  tire corpus rows: ${tire.length}`);
  console.log(`  phase1 benchmark rows: ${phase1.length}`);
  console.log(`  by source:`, bySource);
}

main();
