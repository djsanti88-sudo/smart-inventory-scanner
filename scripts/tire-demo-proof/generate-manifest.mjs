#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { buildSync } from "esbuild";
import { assertLocalDemoDatabase } from "../local-demo-preflight.mjs";
import {
  LOCAL_DEMO_AGENT_COUNT,
  LOCAL_DEMO_BATCH_SIZE,
  LOCAL_DEMO_SAMPLE_SEED,
  LOCAL_DEMO_SAMPLE_TOTAL,
  paddingEquivalenceKey,
  localDemoSamplingContext,
  sampleTireRows,
} from "../local-demo-sampler.mjs";
import { isTrustedLocalDemoTireRow } from "../../src/server/tire-knowledge/localDemoTrust.mjs";

const ROOT = process.cwd();
const DEFAULT_DATABASE_PATH = resolve(ROOT, "src/server/knowledge.generated.db");
const DEFAULT_REPORTS_ROOT = resolve(ROOT, "reports/local-tire-demo");
const MANIFEST_ROW_KEYS = [
  "barcode", "barcodeType", "canonicalProductUid", "brand", "model", "size",
  "loadIndex", "speedRating", "manufacturerPartNumber", "type", "season",
  "sourceCount", "confidence", "currentStatus", "usableFor",
  "fieldCompletenessScore", "angle", "stratum", "ordinal", "batch", "agent",
];
const MANIFEST_KEYS = [
  "schemaVersion", "seed", "gitSha", "databaseSha256", "generatedAt", "total",
  "batchSize", "batchCount", "agentCount", "manifestSha256", "rows",
];
const BATCH_KEYS = [
  "schemaVersion", "gitSha", "databaseSha256", "seed", "batch", "agent",
  "rowCount", "batchSha256", "expectedBarcodesSha256",
  "expectedCanonicalProductUidsSha256", "rows",
];

function loadCountability() {
  const helper = resolve(ROOT, "scripts", "local-demo-countability.ts");
  const result = buildSync({
    entryPoints: [helper],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    write: false,
  });
  const source = result.outputFiles?.[0]?.text;
  if (!source) throw new Error("Unable to bundle the local demo countability helper.");
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

const { countableLocalDemoRowIndexes } = await loadCountability();

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  return JSON.stringify(value);
}

function fileJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function batchHashes(rows) {
  return {
    batchSha256: sha256(canonicalJson(rows)),
    expectedBarcodesSha256: sha256(canonicalJson(rows.map((row) => row.barcode))),
    expectedCanonicalProductUidsSha256: sha256(canonicalJson(rows.map((row) => row.canonicalProductUid))),
  };
}

function manifestHash(manifest) {
  const unsigned = { ...manifest };
  delete unsigned.manifestSha256;
  return sha256(canonicalJson(unsigned));
}

function requiredGitSha(gitSha) {
  const value = String(gitSha ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim()).trim();
  if (!/^[a-f0-9]{7,64}$/i.test(value)) throw new Error("A valid git revision is required for the local tire manifest.");
  return value.toLowerCase();
}

function assertContained(root, path) {
  const within = relative(root, path);
  if (!within || within.startsWith("..") || isAbsolute(within)) throw new Error("Local tire manifest path escaped the report root.");
  return path;
}

function hasExactKeys(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function asTrustedRow(row) {
  return {
    barcode: row.barcode,
    barcode_type: row.barcodeType,
    canonical_product_uid: row.canonicalProductUid,
    brand: row.brand,
    model_display: row.model,
    size: row.size,
    current_status: row.currentStatus,
    usable_for: row.usableFor,
    source_count: row.sourceCount,
  };
}

function assertCertifiedRows(rows, { firstOrdinal = 1, label = "Manifest" } = {}) {
  if (!Array.isArray(rows)) throw new Error(`${label} rows must be an array.`);
  const barcodes = new Set();
  const canonicalIds = new Set();
  const paddingKeys = new Set();
  for (const [index, row] of rows.entries()) {
    if (!hasExactKeys(row, MANIFEST_ROW_KEYS)) throw new Error(`${label} row ${index + 1} has an invalid schema.`);
    const stringFields = [
      "barcode", "barcodeType", "canonicalProductUid", "brand", "model", "size",
      "loadIndex", "speedRating", "manufacturerPartNumber", "type", "season",
      "confidence", "currentStatus", "usableFor", "angle", "stratum",
    ];
    if (!stringFields.every((field) => typeof row[field] === "string") ||
      !Number.isFinite(row.sourceCount) || !Number.isFinite(row.fieldCompletenessScore) ||
      !Number.isSafeInteger(row.ordinal) || !Number.isSafeInteger(row.batch) || !Number.isSafeInteger(row.agent)) {
      throw new Error(`${label} row ${index + 1} has invalid field types.`);
    }
    const expectedOrdinal = firstOrdinal + index;
    if (row.ordinal !== expectedOrdinal ||
      row.batch !== Math.floor((expectedOrdinal - 1) / LOCAL_DEMO_BATCH_SIZE) + 1 ||
      row.agent !== Math.floor((expectedOrdinal - 1) / (LOCAL_DEMO_BATCH_SIZE * 3)) + 1) {
      throw new Error(`${label} row ${index + 1} has an invalid fixed allocation.`);
    }
    if (!isTrustedLocalDemoTireRow(asTrustedRow(row))) {
      throw new Error(`${label} row ${index + 1} failed the trusted local tire predicate.`);
    }
    const paddingKey = paddingEquivalenceKey(row.barcode);
    if (barcodes.has(row.barcode) || canonicalIds.has(row.canonicalProductUid) || paddingKeys.has(paddingKey)) {
      throw new Error(`${label} rows must have unique barcode, canonical product, and padding-equivalence keys.`);
    }
    barcodes.add(row.barcode);
    canonicalIds.add(row.canonicalProductUid);
    paddingKeys.add(paddingKey);
  }
}

function assertSemanticStrata(manifestRows, sourceRows) {
  if (!Array.isArray(sourceRows)) throw new Error("Local tire manifest validation requires the eligible source pool.");
  const { rules } = localDemoSamplingContext(sourceRows);
  let offset = 0;
  for (const rule of rules) {
    for (const stratum of rule.strata) {
      const segment = manifestRows.slice(offset, offset + stratum.count);
      if (segment.length !== stratum.count || !segment.every((row) =>
        row.angle === rule.angle && row.stratum === stratum.stratum && stratum.test(row)
      )) {
        throw new Error(`Manifest stratum ${stratum.stratum} failed its semantic quota.`);
      }
      offset += stratum.count;
    }
  }
  if (offset !== LOCAL_DEMO_SAMPLE_TOTAL) throw new Error("Local tire manifest stratum layout is incomplete.");
}

function assertExactDeterministicSample(manifestRows, sourceRows) {
  if (!Array.isArray(sourceRows)) throw new Error("Local tire manifest validation requires the eligible source pool.");
  const expectedRows = sampleTireRows(sourceRows, { seed: LOCAL_DEMO_SAMPLE_SEED });
  if (canonicalJson(manifestRows) !== canonicalJson(expectedRows)) {
    throw new Error("Local tire manifest rows are not the exact deterministic sample from the source pool.");
  }
}

function verifyBatch(batch, manifest, batchIndex) {
  if (!hasExactKeys(batch, BATCH_KEYS) || batch.schemaVersion !== 1 ||
    batch.gitSha !== manifest.gitSha || batch.databaseSha256 !== manifest.databaseSha256 ||
    batch.seed !== manifest.seed || batch.batch !== batchIndex + 1 ||
    batch.agent !== Math.floor(batchIndex / 3) + 1 || batch.rowCount !== LOCAL_DEMO_BATCH_SIZE) {
    throw new Error(`Batch ${batchIndex + 1} has an invalid fixed schema.`);
  }
  if (!Array.isArray(batch.rows) || batch.rows.length !== LOCAL_DEMO_BATCH_SIZE) throw new Error(`Batch ${batch.batch} must contain exactly ${LOCAL_DEMO_BATCH_SIZE} rows.`);
  const expectedRows = manifest.rows.slice(batchIndex * LOCAL_DEMO_BATCH_SIZE, (batchIndex + 1) * LOCAL_DEMO_BATCH_SIZE);
  if (JSON.stringify(batch.rows) !== JSON.stringify(expectedRows)) throw new Error(`Batch ${batch.batch} is not bound to its contiguous manifest rows.`);
  assertCertifiedRows(batch.rows, { firstOrdinal: batchIndex * LOCAL_DEMO_BATCH_SIZE + 1, label: `Batch ${batch.batch}` });
  const hashes = batchHashes(batch.rows);
  for (const [key, value] of Object.entries(hashes)) {
    if (batch[key] !== value) throw new Error(`Batch ${batch.batch} ${key} did not verify after writing.`);
  }
}

export function validateManifest(manifest, batches, { sourceRows } = {}) {
  if (!hasExactKeys(manifest, MANIFEST_KEYS)) throw new Error("Local tire manifest has an invalid schema.");
  if (manifest.schemaVersion !== 1 || manifest.total !== LOCAL_DEMO_SAMPLE_TOTAL || manifest.batchSize !== LOCAL_DEMO_BATCH_SIZE || manifest.batchCount !== 30 || manifest.agentCount !== LOCAL_DEMO_AGENT_COUNT) {
    throw new Error("Local tire manifest has an invalid fixed certification shape.");
  }
  if (!Array.isArray(manifest.rows) || manifest.rows.length !== LOCAL_DEMO_SAMPLE_TOTAL || !Array.isArray(batches) || batches.length !== 30) throw new Error("Local tire manifest output is incomplete.");
  if (manifest.manifestSha256 !== manifestHash(manifest)) throw new Error("Local tire manifest hash did not verify after writing.");
  if (manifest.seed !== LOCAL_DEMO_SAMPLE_SEED ||
    !/^[a-f0-9]{7,64}$/i.test(manifest.gitSha) ||
    !/^[a-f0-9]{64}$/i.test(manifest.databaseSha256) ||
    typeof manifest.generatedAt !== "string" ||
    !Number.isFinite(Date.parse(manifest.generatedAt))) {
    throw new Error("Local tire manifest has invalid fixed metadata.");
  }
  assertCertifiedRows(manifest.rows);
  for (const [index, batch] of batches.entries()) verifyBatch(batch, manifest, index);
  assertSemanticStrata(manifest.rows, sourceRows);
  assertExactDeterministicSample(manifest.rows, sourceRows);
}

function databaseRows(databasePath) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare(`SELECT barcode, barcode_type, canonical_product_uid, brand, model, model_display,
      size, load_index, speed_rating, manufacturer_part_number, type, season, source_count, confidence,
      current_status, usable_for, field_completeness_score FROM tires`).all();
    if (!rows.length) throw new Error("Local tire database contains no rows.");
    return rows;
  } finally {
    db.close();
  }
}

function countableSourceRows(rows) {
  const indexes = countableLocalDemoRowIndexes(rows);
  if (!Array.isArray(indexes) || !indexes.every((index) => Number.isSafeInteger(index) && index >= 0 && index < rows.length)) {
    throw new Error("Local demo countability helper returned invalid row indexes.");
  }
  return indexes.map((index) => rows[index]);
}

export function generateLocalDemoManifest({
  databasePath = DEFAULT_DATABASE_PATH,
  reportsRoot = DEFAULT_REPORTS_ROOT,
  gitSha,
  generatedAt = new Date().toISOString(),
  seed = LOCAL_DEMO_SAMPLE_SEED,
  beforePostRead,
} = {}) {
  const databaseInfo = assertLocalDemoDatabase(databasePath);
  const resolvedDatabase = resolve(databasePath);
  if (databaseInfo.databasePath !== resolvedDatabase) throw new Error("Local tire database preflight path mismatch.");
  const revision = requiredGitSha(gitSha);
  const root = resolve(reportsRoot);
  const sourceRows = countableSourceRows(databaseRows(resolvedDatabase));
  const rows = sampleTireRows(sourceRows, { seed });
  if (seed !== LOCAL_DEMO_SAMPLE_SEED) throw new Error("Local tire manifest requires the fixed certification seed.");
  if (!/^[a-f0-9]{64}$/i.test(databaseInfo.databaseSha256) || !Number.isFinite(Date.parse(generatedAt))) {
    throw new Error("Local tire manifest requires valid database metadata.");
  }
  if (typeof beforePostRead === "function") beforePostRead();
  const postReadInfo = assertLocalDemoDatabase(resolvedDatabase);
  if (postReadInfo.databaseSha256 !== databaseInfo.databaseSha256 || postReadInfo.tireCount !== databaseInfo.tireCount || postReadInfo.eligibleTireCount !== databaseInfo.eligibleTireCount) {
    throw new Error("Local tire database changed while generating the manifest; refusing to activate a mixed run.");
  }
  const manifest = {
    schemaVersion: 1,
    seed,
    gitSha: revision,
    databaseSha256: databaseInfo.databaseSha256,
    generatedAt,
    total: LOCAL_DEMO_SAMPLE_TOTAL,
    batchSize: LOCAL_DEMO_BATCH_SIZE,
    batchCount: 30,
    agentCount: LOCAL_DEMO_AGENT_COUNT,
    manifestSha256: "",
    rows,
  };
  manifest.manifestSha256 = manifestHash(manifest);
  const runName = `${revision}-${databaseInfo.databaseSha256}`;
  if (!/^[a-f0-9-]+$/i.test(runName)) throw new Error("Invalid local tire manifest run directory.");
  const finalRunDirectory = assertContained(root, join(root, runName));
  const temporaryRunDirectory = assertContained(root, join(root, `.${runName}.tmp-${process.pid}-${Date.now()}`));
  const activePointer = join(root, "active-run.json");
  if (existsSync(finalRunDirectory)) throw new Error(`Local tire manifest run already exists: ${runName}.`);

  mkdirSync(join(temporaryRunDirectory, "batches"), { recursive: true });
  try {
    const batches = [];
    fileJson(join(temporaryRunDirectory, "manifest.json"), manifest);
    for (let batchNumber = 1; batchNumber <= 30; batchNumber += 1) {
      const batchRows = rows.slice((batchNumber - 1) * LOCAL_DEMO_BATCH_SIZE, batchNumber * LOCAL_DEMO_BATCH_SIZE);
      const batch = {
        schemaVersion: 1,
        gitSha: revision,
        databaseSha256: databaseInfo.databaseSha256,
        seed,
        batch: batchNumber,
        agent: batchRows[0].agent,
        rowCount: batchRows.length,
        ...batchHashes(batchRows),
        rows: batchRows,
      };
      fileJson(join(temporaryRunDirectory, "batches", `batch-${String(batchNumber).padStart(2, "0")}.json`), batch);
      batches.push(batch);
    }
    const reopenedManifest = readJson(join(temporaryRunDirectory, "manifest.json"));
    const reopenedBatches = batches.map((_, index) => readJson(join(temporaryRunDirectory, "batches", `batch-${String(index + 1).padStart(2, "0")}.json`)));
    validateManifest(reopenedManifest, reopenedBatches, { sourceRows });
    renameSync(temporaryRunDirectory, finalRunDirectory);
    const pointer = {
      schemaVersion: 1,
      runDirectory: runName,
      gitSha: revision,
      databaseSha256: databaseInfo.databaseSha256,
      manifestSha256: manifest.manifestSha256,
      generatedAt,
    };
    const temporaryPointer = assertContained(root, join(root, `.active-run.tmp-${process.pid}-${Date.now()}.json`));
    fileJson(temporaryPointer, pointer);
    renameSync(temporaryPointer, activePointer);
    return { runDirectory: finalRunDirectory, manifest, batches: reopenedBatches, pointer };
  } catch (error) {
    rmSync(temporaryRunDirectory, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const result = generateLocalDemoManifest();
  console.log(JSON.stringify({
    total: result.manifest.total,
    batches: result.batches.length,
    databaseSha256: result.manifest.databaseSha256,
    manifestSha256: result.manifest.manifestSha256,
    runDirectory: result.pointer.runDirectory,
  }, null, 2));
}
