#!/usr/bin/env node
// scripts/refresh-tire-meta.mjs
//
// F-16 (Task 13, docs/superpowers/plans/2026-07-29-audit-remediation.md): a
// METADATA-ONLY provenance refresh for the tire-knowledge corpus.
//
// DANGER -- this script NEVER rewrites the generated payload
// (tireKnowledge.generated.json). It only READS the payload's bytes (to hash
// them and count its indexes) and updates the sibling *.meta.json file so
// its hash/date/index-counts describe the payload that ALREADY ships.
// Do NOT run the full generator (`npm run build:tire-knowledge`) as a
// substitute for this script -- that rebuilds the payload from an OLDER
// source snapshot and would DISCARD later enrichment (shrinking the corpus
// 78,437 -> ~76,173 barcode keys). Pattern: read/transform/verify/write,
// like scripts/tmp-fix-source-count.mjs, but this one touches ONLY the meta.
//
// Lineage rule (do not conflate -- see 04-corpus-provenance.md):
//   - payload_sha256 / payload_barcode_count / payload_generated_at describe
//     the CURRENT shipped payload and are computed FRESH every run by
//     reading tireKnowledge.generated.json.
//   - base_source_sha256 / base_source_row_count describe the ORIGINAL
//     source snapshot the generator actually consumed to build this
//     payload. They are COPIED FORWARD from the existing meta file's
//     source_file_hash / source_row_count fields -- NEVER recomputed from
//     whatever CSV happens to be on disk today (a later, unrelated
//     snapshot that was never run through the generator).
//   - metadata_refreshed_at is the ONLY "now" field this script writes.
//     The legacy top-level generated_at is repointed to the payload's own
//     internal generated_at, never restamped to "now".
//
// Usage:
//   node scripts/refresh-tire-meta.mjs [--payload <path>] [--meta <path>]
//   (defaults to the real committed payload/meta paths when no flags given)
//
// Programmatic usage (used by the guard test to run only on temp fixtures):
//   import { refreshTireMeta } from "./refresh-tire-meta.mjs";
//   refreshTireMeta({ payloadPath, metaPath });

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_PAYLOAD_PATH = join(
  process.cwd(),
  "src",
  "server",
  "tire-knowledge",
  "tireKnowledge.generated.json",
);
const DEFAULT_META_PATH = join(
  process.cwd(),
  "src",
  "server",
  "tire-knowledge",
  "tireKnowledge.generated.meta.json",
);

function sha256OfFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function countKeys(obj, key) {
  return Object.keys(obj[key] ?? {}).length;
}

/**
 * Refresh a tire-knowledge meta.json so it truthfully describes the payload
 * it points at. Reads the payload (never writes it). Writes ONLY the meta
 * file at metaPath.
 *
 * @param {{ payloadPath?: string, metaPath?: string }} [options]
 * @returns {object} the updated meta object that was written to disk
 */
export function refreshTireMeta(options = {}) {
  const payloadPath = options.payloadPath ?? DEFAULT_PAYLOAD_PATH;
  const metaPath = options.metaPath ?? DEFAULT_META_PATH;

  // --- Read the payload (bytes for hashing, parsed for counts). Never write it. ---
  const payloadSha256 = sha256OfFile(payloadPath);
  const payload = JSON.parse(readFileSync(payloadPath, "utf8"));

  const payloadBarcodeCount = countKeys(payload, "barcodeIndex");
  const payloadPartNumberCount = countKeys(payload, "partNumberIndex");
  const payloadIdentityCount = countKeys(payload, "identityIndex");
  const payloadGeneratedAt = payload.generated_at;

  if (!payloadGeneratedAt) {
    throw new Error(`Payload at ${payloadPath} has no top-level "generated_at" field`);
  }

  // --- Read the EXISTING meta to copy base-source lineage forward. ---
  const existingMeta = JSON.parse(readFileSync(metaPath, "utf8"));

  const baseSourceSha256 = existingMeta.source_file_hash;
  const baseSourceRowCount = existingMeta.source_row_count;

  if (!baseSourceSha256 || baseSourceRowCount === undefined) {
    throw new Error(
      `Existing meta at ${metaPath} is missing source_file_hash / source_row_count -- ` +
        "refusing to guess base-source lineage",
    );
  }

  // --- Build the updated meta: preserve every existing field, update only ---
  // --- the payload-derived counts + top-level generated_at, then ADD the ---
  // --- six new lineage fields. ---
  const updatedMeta = {
    ...existingMeta,
    generated_at: payloadGeneratedAt,
    // source_file_hash / source_row_count are intentionally NOT reassigned
    // here -- the spread above already carried their existing values forward
    // untouched, per the lineage rule (never recompute base-source facts).
    barcode_index_count: payloadBarcodeCount,
    part_number_index_count: payloadPartNumberCount,
    identity_index_count: payloadIdentityCount,
    payload_sha256: payloadSha256,
    payload_barcode_count: payloadBarcodeCount,
    base_source_sha256: baseSourceSha256,
    base_source_row_count: baseSourceRowCount,
    payload_generated_at: payloadGeneratedAt,
    metadata_refreshed_at: new Date().toISOString(),
  };

  writeFileSync(metaPath, `${JSON.stringify(updatedMeta, null, 2)}\n`);

  return updatedMeta;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--payload") args.payloadPath = argv[++i];
    else if (argv[i] === "--meta") args.metaPath = argv[++i];
  }
  return args;
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const payloadPath = args.payloadPath ?? DEFAULT_PAYLOAD_PATH;
  const metaPath = args.metaPath ?? DEFAULT_META_PATH;

  console.log(`Reading payload: ${payloadPath}`);
  console.log(`Refreshing meta: ${metaPath}`);

  const updated = refreshTireMeta({ payloadPath, metaPath });

  console.log("Updated meta fields:");
  console.log(`  generated_at            = ${updated.generated_at}`);
  console.log(`  barcode_index_count     = ${updated.barcode_index_count}`);
  console.log(`  part_number_index_count = ${updated.part_number_index_count}`);
  console.log(`  identity_index_count    = ${updated.identity_index_count}`);
  console.log(`  payload_sha256          = ${updated.payload_sha256}`);
  console.log(`  payload_barcode_count   = ${updated.payload_barcode_count}`);
  console.log(`  base_source_sha256      = ${updated.base_source_sha256}`);
  console.log(`  base_source_row_count   = ${updated.base_source_row_count}`);
  console.log(`  payload_generated_at    = ${updated.payload_generated_at}`);
  console.log(`  metadata_refreshed_at   = ${updated.metadata_refreshed_at}`);
}
