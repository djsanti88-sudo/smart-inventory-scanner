import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { summarizeDirectory, summarizeResults } from "./summarize.mjs";
import { createHash } from "node:crypto";
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function fixture(batchNumber) { const rows = Array.from({ length: 100 }, (_, i) => ({ barcode:`${batchNumber}-${i}`, barcodeType:"upc", canonicalProductUid:`u-${batchNumber}-${i}`, brand:"B", model:"M", size:"S", loadIndex:"", speedRating:"", manufacturerPartNumber:"", type:"", season:"", sourceCount:1, confidence:"verified", currentStatus:"active_retail", usableFor:"auto_count_candidate", fieldCompletenessScore:100, angle:"test", stratum:"test", ordinal:(batchNumber - 1) * 100 + i + 1, batch:batchNumber, agent:Math.ceil(batchNumber / 3) })); const batch={schemaVersion:1,seed:"s",gitSha:"abcdef1",databaseSha256:"a".repeat(64),batch:batchNumber,agent:Math.ceil(batchNumber / 3),rowCount:100,rows}; batch.batchSha256=digest(rows); batch.expectedBarcodesSha256=digest(rows.map(r=>r.barcode)); batch.expectedCanonicalProductUidsSha256=digest(rows.map(r=>r.canonicalProductUid)); const events=rows.map((r)=>({eventId:`e-${r.barcode}`,cleanCode:r.barcode,matchedProductId:`p-${r.barcode}`,canonicalProductUid:r.canonicalProductUid,quantityDelta:1,quantityAfterScan:1,status:"verified"})); const counts=events.map(e=>({productId:e.matchedProductId,quantity:1,scanEventIds:[e.eventId]})); return {batch,result:{observations:rows.map((r,i)=>({...r,eventId:`e-${r.barcode}`,matchedProductId:`p-${r.barcode}`,feedVisible:true,status:"verified",latencyMs:(batchNumber-1)*100+i,consoleErrors:[],nonLocalRequests:[]})),serverEgressAttempts:[],ledgerProof:{schemaVersion:1,sessionId:"s",generatedAt:"2026-07-29T00:00:00.000Z",manifest:{schemaVersion:1,gitSha:"abcdef1",databaseSha256:"a".repeat(64),seed:"s",batch:batchNumber,batchSha256:batch.batchSha256,expectedBarcodesSha256:batch.expectedBarcodesSha256,expectedCanonicalProductUidsSha256:batch.expectedCanonicalProductUidsSha256},expected:{rows:100,barcodes:rows.map(r=>r.barcode)},events,finalCounts:counts,replayedCounts:counts,assertions:{allExpectedBarcodesSeenExactlyOnce:true,unexpectedBarcodeCount:0,duplicateEventIdCount:0,missingEventIdCount:0,unmatchedEventCount:0,finalEqualsReplay:true,countEventIdsEqualReplayEventIds:true,everyCountEventIdExistsInFeed:true,expectedQuantity:100,finalQuantity:100,replayedQuantity:100,noDrops:true,noDuplicates:true,passed:true}}}}; }
test("summary refuses green without exactly 30 passing batches", () => { assert.throws(() => summarizeResults([]), /exactly 30/i); });
test("summary rejects duplicate internal batch numbers before accepting a 30-batch result", () => { const entries = Array.from({ length: 30 }, (_, index) => ({ batch: { batch: index ? 1 : 1 }, result: {} })); assert.throws(() => summarizeResults(entries), /batch numbers/i); });
test("summary aggregates all 3000 raw observations with nearest-rank percentiles and zero safety metrics", () => { const summary=summarizeResults(Array.from({length:30},(_,i)=>fixture(i+1))); assert.equal(summary.total,3000); assert.equal(summary.countedQuantity,3000); assert.equal(summary.p50Ms,1499); assert.equal(summary.p95Ms,2849); assert.equal(summary.p99Ms,2969); assert.equal(summary.nonLocalRequestCount,0); assert.equal(summary.serverEgressAttemptCount,0); });

function writeRun(entries) {
  const parent = mkdtempSync(join(tmpdir(), "scanbin-proof-parent-"));
  const root = join(parent, "run-abcdef1");
  mkdirSync(root);
  mkdirSync(join(root, "batches"));
  mkdirSync(join(root, "results"));
  for (const [index, entry] of entries.entries()) {
    const name = `batch-${String(index + 1).padStart(2, "0")}.json`;
    writeFileSync(join(root, "batches", name), JSON.stringify(entry.batch));
    writeFileSync(join(root, "results", name), JSON.stringify(entry.result));
  }
  const manifest = { schemaVersion:1, seed:"s", gitSha:"abcdef1", databaseSha256:"a".repeat(64), generatedAt:"2026-07-29T00:00:00.000Z", total:3000, batchSize:100, batchCount:30, agentCount:10, manifestSha256:"", rows:entries.flatMap((entry) => entry.batch.rows) };
  const unsigned = { ...manifest }; delete unsigned.manifestSha256; manifest.manifestSha256 = digest(unsigned);
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dirname(root), "active-run.json"), JSON.stringify({ schemaVersion:1, runDirectory:basename(root), gitSha:manifest.gitSha, databaseSha256:manifest.databaseSha256, manifestSha256:manifest.manifestSha256, generatedAt:manifest.generatedAt }));
  return root;
}

function completeEntries() { return Array.from({ length: 30 }, (_, index) => fixture(index + 1)); }

test("summarizeDirectory writes a 30-row green matrix with explicit 30/30 ledger and zero-egress proof", () => {
  const root = writeRun(completeEntries());
  try {
    const summary = summarizeDirectory(root);
    const report = readFileSync(join(root, "REPORT.md"), "utf8");
    assert.equal(summary.batchCount, 30);
    assert.equal(JSON.parse(readFileSync(join(root, "summary.json"), "utf8")).total, 3000);
    assert.match(report, /30\/30 ledger/i);
    assert.match(report, /zero egress/i);
    assert.equal(report.split("\n").filter((line) => /^\| \d+ \|/.test(line)).length, 30);
  } finally { rmSync(dirname(root), { recursive: true, force: true }); }
});

test("summarizeDirectory requires the parent active-run manifest anchor", () => {
  const root = writeRun(completeEntries());
  try {
    rmSync(join(dirname(root), "active-run.json"));
    assert.throws(() => summarizeDirectory(root), /manifest|active-run/i);
  } finally { rmSync(dirname(root), { recursive: true, force: true }); }
});

test("summarizeDirectory rejects an extra result file", () => {
  const root = writeRun(completeEntries());
  try {
    writeFileSync(join(root, "results", "batch-31.json"), "{}");
    assert.throws(() => summarizeDirectory(root), /exactly batch-01 through batch-30/i);
  } finally { rmSync(dirname(root), { recursive: true, force: true }); }
});

test("summarizeDirectory rejects an extra locked batch file", () => {
  const root = writeRun(completeEntries());
  try {
    writeFileSync(join(root, "batches", "batch-31.json"), "{}");
    assert.throws(() => summarizeDirectory(root), /exactly batch-01 through batch-30/i);
  } finally { rmSync(dirname(root), { recursive: true, force: true }); }
});

test("summarizeDirectory rejects a missing result file", () => {
  const root = writeRun(completeEntries());
  try {
    rmSync(join(root, "results", "batch-30.json"));
    assert.throws(() => summarizeDirectory(root), /exactly batch-01 through batch-30/i);
  } finally { rmSync(dirname(root), { recursive: true, force: true }); }
});

test("summarizeDirectory rejects a filename to internal batch mismatch", () => {
  const entries = completeEntries();
  entries[4].result.ledgerProof.manifest.batch = 6;
  const root = writeRun(entries);
  try {
    assert.throws(() => summarizeDirectory(root), /result batch-05 binding/i);
  } finally { rmSync(dirname(root), { recursive: true, force: true }); }
});

test("summarizeDirectory rejects a tampered batch even when its hashes are recomputed", () => {
  const root = writeRun(completeEntries());
  try {
    const path = join(root, "batches", "batch-01.json");
    const batch = JSON.parse(readFileSync(path, "utf8"));
    batch.rows[0].brand = "tampered";
    batch.batchSha256 = digest(batch.rows);
    batch.expectedBarcodesSha256 = digest(batch.rows.map((row) => row.barcode));
    batch.expectedCanonicalProductUidsSha256 = digest(batch.rows.map((row) => row.canonicalProductUid));
    writeFileSync(path, JSON.stringify(batch));
    assert.throws(() => summarizeDirectory(root), /batch-01 binding/i);
  } finally { rmSync(dirname(root), { recursive: true, force: true }); }
});

test("summarizeDirectory rejects swapped valid filename pairs", () => {
  const root = writeRun(completeEntries());
  try {
    for (const directory of ["batches", "results"]) {
      const first = join(root, directory, "batch-01.json");
      const second = join(root, directory, "batch-02.json");
      const firstContents = readFileSync(first, "utf8");
      writeFileSync(first, readFileSync(second, "utf8"));
      writeFileSync(second, firstContents);
    }
    assert.throws(() => summarizeDirectory(root), /batch-01 binding/i);
  } finally { rmSync(dirname(root), { recursive: true, force: true }); }
});
