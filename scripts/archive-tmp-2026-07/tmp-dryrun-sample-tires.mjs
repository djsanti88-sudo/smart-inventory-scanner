#!/usr/bin/env node
// Samples tire barcodes + part numbers WITH known truth from the local tire-knowledge data.
// Discovery-based: finds JSON/CSV files under data/tire-knowledge, detects barcode/part fields
// and (since the real corpus has no single "name" column) builds a truth string from
// brand + model + size when a direct name field isn't present. Prints diverse candidates
// (owner keeps ~20 tire_barcode + some tire_part after manual verification in Task 5).
//
// Adapted from the original brief script: the real corpus is CSV (not JSON) with columns
// brand/model/size_canonical/barcode/manufacturer_part_number - JSON.parse-first discovery
// found 0 rows against real data, so this version parses CSV properly (csv-parse/sync, same
// lib already used by scripts/build-tire-knowledge.mjs) and derives truth compositionally.
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "data", "tire-knowledge");

const SKIP_DIRS = new Set(["__pycache__", ".pytest_cache"]);
const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    if (SKIP_DIRS.has(e)) continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (/\.(json|csv|ndjson)$/i.test(e) && st.size > 200) files.push(p);
  }
})(ROOT);
// Prefer the canonical live snapshot (data/tire-knowledge/tire_corpus_flat.csv, the same file
// build-tire-knowledge.mjs treats as source of truth) over old partial exports/backups, so the
// seen-code dedup below keeps the freshest row when the same barcode appears in more than one file.
files.sort((a, b) => {
  const rank = (p) => (/[\\/]exports[\\/]|[\\/]outputs[\\/]|backup_corpus/i.test(p) ? 1 : 0);
  return rank(a) - rank(b);
});
console.log("data files found:", files.length);

const CODE_KEYS = ["barcode", "upc", "ean", "gtin", "code"];
const PART_KEYS = ["manufacturer_part_number", "partNumber", "part_number", "mpn", "sku", "part"];
const NAME_KEYS = ["name", "productName", "product_name", "title"];
// Real corpus has no single "name" field - compose one from brand/model/size when needed.
const BRAND_KEYS = ["brand", "brand_normalized"];
const MODEL_KEYS = ["model", "model_normalized"];
const SIZE_KEYS = ["size_canonical", "size", "raw_size_text", "size_compact"];

const pick = (row, keys) => {
  for (const k of keys) {
    const v = row?.[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
};

function buildTruth(row) {
  const direct = pick(row, NAME_KEYS);
  if (direct) return direct;
  const brand = pick(row, BRAND_KEYS);
  const model = pick(row, MODEL_KEYS).replace(/_/g, " ");
  const size = pick(row, SIZE_KEYS);
  return [brand, model, size].filter(Boolean).join(" ").trim();
}

function readRows(f) {
  const text = readFileSync(f, "utf8");
  if (/\.csv$/i.test(f)) {
    try {
      return parse(text, { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true, bom: true });
    } catch {
      return [];
    }
  }
  try {
    const j = JSON.parse(text);
    return Array.isArray(j) ? j : Object.values(j).find(Array.isArray) ?? [];
  } catch {
    // ndjson fallback: try one JSON object per line
    return text
      .split(/\r?\n/)
      .slice(0, 500)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }
}

const out = [];
for (const f of files) {
  const rows = readRows(f);
  const source = f.split(/[\\/]/).slice(-2).join("/");
  for (const row of rows) {
    const truth = buildTruth(row);
    if (!truth) continue;
    const code = pick(row, CODE_KEYS);
    const part = pick(row, PART_KEYS);
    if (code) out.push({ code, kind: "tire_barcode", truth, source });
    if (part) out.push({ code: part, kind: "tire_part", truth, source });
    if (out.length >= 200_000) break; // sanity ceiling only, real corpus is ~76K rows
  }
  if (out.length >= 200_000) break;
}
console.log("raw candidate rows collected:", out.length);

// diversity: unique by code, spread across the corpus (which is grouped/harvested by brand,
// so a strided sample naturally spans many brands), alternate barcode/part.
const seen = new Set();
const barcodes = out.filter((r) => r.kind === "tire_barcode" && !seen.has(r.code) && seen.add(r.code));
const parts = out.filter((r) => r.kind === "tire_part" && !seen.has(r.code) && seen.add(r.code));
const every = (arr, n) => arr.filter((_, i) => i % Math.max(1, Math.floor(arr.length / n)) === 0).slice(0, n);
const sample = [...every(barcodes, 25), ...every(parts, 15)];
writeFileSync(join(HERE, "dryrun-candidates-tires.json"), JSON.stringify(sample, null, 2));
console.log(`wrote ${sample.length} tire candidates (barcodes ${Math.min(25, barcodes.length)}, parts ${Math.min(15, parts.length)})`);
