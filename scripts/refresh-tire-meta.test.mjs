#!/usr/bin/env node
// Guard test for scripts/refresh-tire-meta.mjs (F-16, Task 13).
//
// This test NEVER touches the real committed payload/meta files. It copies
// them into a temporary directory and runs the updater only against those
// temp copies, then asserts:
//   1. the payload bytes are byte-for-byte unchanged (the updater never
//      writes the payload, only reads it),
//   2. the three payload-derived legacy counts in the meta now match the
//      REAL shipped payload (78437 / 27364 / 72321),
//   3. the base-source lineage fields are COPIED FORWARD from the existing
//      meta (never recomputed from whatever CSV happens to be on disk today),
//   4. metadata_refreshed_at and payload_generated_at are distinct fields
//      (no conflation of "now" with the payload's own generation time),
//   5. the real production files on disk are untouched by running this test.
//
// Run: node --test scripts/refresh-tire-meta.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, copyFileSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { refreshTireMeta } from "./refresh-tire-meta.mjs";

const REAL_PAYLOAD_PATH = join(
  process.cwd(),
  "src", "decoding", "server", "knowledge", "tire",
  "tireKnowledge.generated.json",
);
const REAL_META_PATH = join(
  process.cwd(),
  "src", "decoding", "server", "knowledge", "tire",
  "tireKnowledge.generated.meta.json",
);

// Recorded lineage constants from the existing committed meta.json (see
// master plan Task 13 / 04-corpus-provenance.md) -- these are the values the
// updater must COPY FORWARD, never recompute from the on-disk CSV.
const EXPECTED_BASE_SOURCE_SHA256 =
  "4390ed5885637a90413f60eb3f754abecaa19df1a2c2786f8bd304eae7091884";
const EXPECTED_BASE_SOURCE_ROW_COUNT = 76208;

// True counts in the actual shipped payload (verified directly against
// tireKnowledge.generated.json before writing this test).
//
// These are an INDEPENDENT oracle on purpose -- do NOT rewrite them to be derived
// from the payload at runtime. Deriving them would make the test compute its
// expectation the same way refreshTireMeta computes its answer, and it would pass
// vacuously. The intended cost is that a corpus change makes this test fail until a
// human consciously re-verifies and updates the numbers, which is the point.
//
// Updated 2026-08-12 for the 2026-08-10 corpus enrichment (commit 10332fa2,
// +671 barcodes / +653 part numbers / +635 identities, zero removals), and again
// 2026-08-19 for the 2026-08-17 regeneration restored from the pre-aws WIP stash
// (+281 barcodes / +258 part numbers / +246 identities). Counts below re-verified
// directly against src/decoding/server/knowledge/tire/tireKnowledge.generated.json
// (Object.keys of barcodeIndex / partNumberIndex / identityIndex).
const EXPECTED_BARCODE_COUNT = 79389;
const EXPECTED_PART_NUMBER_COUNT = 28275;
const EXPECTED_IDENTITY_COUNT = 73202;

function sha256OfFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

let tmpDir;
let tempPayloadPath;
let tempMetaPath;
let realPayloadHashBefore;
let realMetaRawBefore;
let realMetaMtimeBefore;

before(() => {
  // Snapshot the real files' state so we can prove this test never mutated
  // production paths, no matter what the updater does with temp paths.
  realPayloadHashBefore = sha256OfFile(REAL_PAYLOAD_PATH);
  realMetaRawBefore = readFileSync(REAL_META_PATH, "utf8");
  realMetaMtimeBefore = statSync(REAL_META_PATH).mtimeMs;

  tmpDir = mkdtempSync(join(tmpdir(), "refresh-tire-meta-test-"));
  tempPayloadPath = join(tmpDir, "tireKnowledge.generated.json");
  tempMetaPath = join(tmpDir, "tireKnowledge.generated.meta.json");
  copyFileSync(REAL_PAYLOAD_PATH, tempPayloadPath);
  copyFileSync(REAL_META_PATH, tempMetaPath);
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

test("updater changes ONLY the temp meta file: payload bytes are byte-for-byte unchanged", () => {
  const beforeHash = sha256OfFile(tempPayloadPath);

  refreshTireMeta({ payloadPath: tempPayloadPath, metaPath: tempMetaPath });

  const afterHash = sha256OfFile(tempPayloadPath);
  assert.equal(afterHash, beforeHash, "payload bytes must be byte-for-byte unchanged");
});

test("updated meta describes the real shipped payload counts", () => {
  const beforeHash = sha256OfFile(tempPayloadPath);
  refreshTireMeta({ payloadPath: tempPayloadPath, metaPath: tempMetaPath });

  const meta = JSON.parse(readFileSync(tempMetaPath, "utf8"));

  assert.equal(meta.payload_sha256, beforeHash);
  assert.equal(meta.payload_barcode_count, EXPECTED_BARCODE_COUNT);
  assert.equal(meta.barcode_index_count, EXPECTED_BARCODE_COUNT);
  assert.equal(meta.part_number_index_count, EXPECTED_PART_NUMBER_COUNT);
  assert.equal(meta.identity_index_count, EXPECTED_IDENTITY_COUNT);
});

test("base-source lineage is copied forward from existing meta, never recomputed from the on-disk CSV", () => {
  refreshTireMeta({ payloadPath: tempPayloadPath, metaPath: tempMetaPath });
  const meta = JSON.parse(readFileSync(tempMetaPath, "utf8"));

  assert.equal(meta.base_source_sha256, EXPECTED_BASE_SOURCE_SHA256);
  assert.equal(meta.base_source_row_count, EXPECTED_BASE_SOURCE_ROW_COUNT);
  // source_file_hash / source_row_count are the pre-existing field names and
  // must remain untouched (same values as base_source_*, but the field name
  // itself is the gated consumer read by corpusDrift.test.ts / tireKnowledge.test.ts).
  assert.equal(meta.source_file_hash, EXPECTED_BASE_SOURCE_SHA256);
  assert.equal(meta.source_row_count, EXPECTED_BASE_SOURCE_ROW_COUNT);
});

test("metadata_refreshed_at and payload_generated_at are distinct (no conflation of now vs payload generation time)", () => {
  refreshTireMeta({ payloadPath: tempPayloadPath, metaPath: tempMetaPath });
  const meta = JSON.parse(readFileSync(tempMetaPath, "utf8"));

  assert.ok(meta.payload_generated_at, "payload_generated_at must be set");
  assert.ok(meta.metadata_refreshed_at, "metadata_refreshed_at must be set");
  assert.notEqual(meta.metadata_refreshed_at, meta.payload_generated_at);
  // generated_at (the legacy top-level field, read by consumers) is repointed
  // to the payload's own internal generated_at -- never restamped to "now".
  assert.equal(meta.generated_at, meta.payload_generated_at);
});

test("running the updater against temp copies never touches the real production files", () => {
  refreshTireMeta({ payloadPath: tempPayloadPath, metaPath: tempMetaPath });

  const realPayloadHashAfter = sha256OfFile(REAL_PAYLOAD_PATH);
  const realMetaRawAfter = readFileSync(REAL_META_PATH, "utf8");
  const realMetaMtimeAfter = statSync(REAL_META_PATH).mtimeMs;

  assert.equal(realPayloadHashAfter, realPayloadHashBefore);
  assert.equal(realMetaRawAfter, realMetaRawBefore);
  assert.equal(realMetaMtimeAfter, realMetaMtimeBefore);
});
