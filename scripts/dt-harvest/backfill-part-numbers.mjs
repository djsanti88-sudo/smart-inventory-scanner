#!/usr/bin/env node
// scripts/dt-harvest/backfill-part-numbers.mjs (Task 1, Phase 1 core) — thin CLI wrapper around
// lib/backfill.mjs's applyBackfill(). Reads state/harvested*.jsonl + the real tire corpus,
// fills blank manufacturer_part_number fields, writes the updated corpus + state/pn-conflicts.json,
// and prints the report. Does NOT run against the real corpus as part of Task 1 (that is Task 3);
// use --dry-run for any local check in the meantime.
//
// Usage:
//   node scripts/dt-harvest/backfill-part-numbers.mjs                run for real: write corpus + conflicts
//   node scripts/dt-harvest/backfill-part-numbers.mjs --dry-run       print the report only, write nothing
//   node scripts/dt-harvest/backfill-part-numbers.mjs --input=path    read a single explicit jsonl file
//   node scripts/dt-harvest/backfill-part-numbers.mjs --corpus=path   override the corpus JSON path (tests)

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { applyBackfill } from "./lib/backfill.mjs";
import { jsonlLinesToRows } from "./lib/applyTransform.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = process.cwd();

const DEFAULT_CORPUS_PATH = join(ROOT, "src", "server", "tire-knowledge", "tireKnowledge.generated.json");
const BRAND_PREFIX_MAP_PATH = join(ROOT, "src", "services", "catalog", "brandPrefixMap.json");
const STATE_DIR = join(__dirname, "state");
const DEFAULT_GLOB_PREFIX = "harvested"; // matches state/harvested.jsonl and state/harvested*.jsonl
const DEFAULT_CONFLICTS_PATH = join(STATE_DIR, "pn-conflicts.json");

function parseArgs(argv) {
  const args = { dryRun: false, input: null, corpusPath: DEFAULT_CORPUS_PATH, conflictsPath: DEFAULT_CONFLICTS_PATH };
  for (const raw of argv) {
    if (raw === "--dry-run") args.dryRun = true;
    else if (raw.startsWith("--input=")) args.input = raw.slice("--input=".length);
    else if (raw.startsWith("--corpus=")) args.corpusPath = raw.slice("--corpus=".length);
    else if (raw.startsWith("--conflicts-out=")) args.conflictsPath = raw.slice("--conflicts-out=".length);
  }
  return args;
}

function findHarvestFiles(inputOverride) {
  if (inputOverride) {
    return existsSync(inputOverride) ? [inputOverride] : [];
  }
  if (!existsSync(STATE_DIR)) return [];
  return readdirSync(STATE_DIR)
    .filter((f) => f.startsWith(DEFAULT_GLOB_PREFIX) && f.endsWith(".jsonl"))
    .sort()
    .map((f) => join(STATE_DIR, f));
}

function readAllLines(files) {
  const lines = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const line of text.split(/\r?\n/)) lines.push(line);
  }
  return lines;
}

function loadPrefixMap() {
  if (!existsSync(BRAND_PREFIX_MAP_PATH)) return {};
  try {
    return JSON.parse(readFileSync(BRAND_PREFIX_MAP_PATH, "utf8"));
  } catch {
    return {};
  }
}

function loadCorpus(corpusPath) {
  return JSON.parse(readFileSync(corpusPath, "utf8"));
}

function writeCorpus(corpusPath, corpus) {
  // Pretty-print with 2-space indent to match the committed formatting convention (see apply.mjs).
  writeFileSync(corpusPath, JSON.stringify(corpus, null, 2) + "\n", "utf8");
}

function printReport(report) {
  console.log("\n[backfill-part-numbers] Report");
  console.log(`  Filled:               ${report.filled}`);
  console.log(`  Agreed (unchanged):   ${report.agreed}`);
  console.log(`  Conflicts:            ${report.conflicts.length}`);
  console.log(`  Guard-rejected:       ${report.guardRejected}`);
  console.log(`  Junk fills unindexed: ${report.junkFillsNotIndexed}`);
  console.log(`  Junk keys dropped:    ${report.junkKeysDropped}`);
  console.log(`  No corpus row:        ${report.noCorpusRow}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const files = findHarvestFiles(args.input);
  if (!files.length) {
    console.log(`[backfill-part-numbers] No harvest files found (looked for ${args.input || "state/harvested*.jsonl"}). Nothing to do.`);
    return;
  }
  console.log(`[backfill-part-numbers] Reading ${files.length} harvest file(s):`);
  for (const f of files) console.log(`  ${f}`);

  const lines = readAllLines(files);
  const harvestRows = jsonlLinesToRows(lines);
  console.log(`[backfill-part-numbers] ${harvestRows.length} guard-ok row(s) with a gtin after batch dedupe.`);

  const prefixMap = loadPrefixMap();
  const corpus = loadCorpus(args.corpusPath);

  const { corpus: nextCorpus, report } = applyBackfill(corpus, harvestRows, { prefixMap });
  printReport(report);

  if (args.dryRun) {
    console.log("\n[backfill-part-numbers] --dry-run: not writing the corpus or conflicts file.");
    return;
  }

  writeCorpus(args.corpusPath, nextCorpus);
  writeFileSync(args.conflictsPath, JSON.stringify(report.conflicts, null, 2) + "\n", "utf8");
  console.log(`\n[backfill-part-numbers] Wrote corpus: ${args.corpusPath}`);
  console.log(`[backfill-part-numbers] Wrote conflicts: ${args.conflictsPath} (${report.conflicts.length} entries)`);
}

main().catch((e) => {
  console.error("[backfill-part-numbers] ERROR:", e?.stack || e?.message || e);
  process.exit(1);
});
