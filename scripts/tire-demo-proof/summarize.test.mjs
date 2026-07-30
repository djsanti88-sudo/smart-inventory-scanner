import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import * as summarizeModule from "./summarize.mjs";
const { summarizeDirectory, summarizeResults } = summarizeModule;
import { createHash } from "node:crypto";
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function fixture(batchNumber) { const rows = Array.from({ length: 100 }, (_, i) => ({ barcode:`${batchNumber}-${i}`, barcodeType:"upc", canonicalProductUid:`u-${batchNumber}-${i}`, brand:"B", model:"M", size:"S", loadIndex:"", speedRating:"", manufacturerPartNumber:"", type:"", season:"", sourceCount:1, confidence:"verified", currentStatus:"active_retail", usableFor:"auto_count_candidate", fieldCompletenessScore:100, angle:"test", stratum:"test", ordinal:(batchNumber - 1) * 100 + i + 1, batch:batchNumber, agent:Math.ceil(batchNumber / 3) })); const batch={schemaVersion:1,seed:"s",gitSha:"abcdef1",databaseSha256:"a".repeat(64),batch:batchNumber,agent:Math.ceil(batchNumber / 3),rowCount:100,rows}; batch.batchSha256=digest(rows); batch.expectedBarcodesSha256=digest(rows.map(r=>r.barcode)); batch.expectedCanonicalProductUidsSha256=digest(rows.map(r=>r.canonicalProductUid)); const events=rows.map((r)=>({eventId:`e-${r.barcode}`,cleanCode:r.barcode,matchedProductId:`p-${r.barcode}`,canonicalProductUid:r.canonicalProductUid,quantityDelta:1,quantityAfterScan:1,status:"verified"})); const counts=events.map(e=>({productId:e.matchedProductId,quantity:1,scanEventIds:[e.eventId]})); return {batch,result:{observations:rows.map((r,i)=>({...r,eventId:`e-${r.barcode}`,matchedProductId:`p-${r.barcode}`,feedVisible:true,status:"verified",rawStatus:"Verified (app-confirmed)",latencyMs:(batchNumber-1)*100+i,consoleErrors:[],nonLocalRequests:[]})),serverEgressAttempts:[],runtimeSessionNonce:"c".repeat(32),ledgerProof:{schemaVersion:1,sessionId:"s",generatedAt:"2026-07-29T00:00:00.000Z",manifest:{schemaVersion:1,gitSha:"abcdef1",databaseSha256:"a".repeat(64),manifestSha256:"b".repeat(64),seed:"s",batch:batchNumber,batchSha256:batch.batchSha256,expectedBarcodesSha256:batch.expectedBarcodesSha256,expectedCanonicalProductUidsSha256:batch.expectedCanonicalProductUidsSha256},expected:{rows:100,barcodes:rows.map(r=>r.barcode)},events,finalCounts:counts,replayedCounts:counts,assertions:{allExpectedBarcodesSeenExactlyOnce:true,unexpectedBarcodeCount:0,duplicateEventIdCount:0,missingEventIdCount:0,unmatchedEventCount:0,canonicalIdentityMismatchCount:0,distinctExpectedCanonicalProductUidCount:100,distinctMatchedProductIdCount:100,distinctFinalCountProductIdCount:100,distinctReplayedCountProductIdCount:100,canonicalProductMatchedProductBijection:true,finalEqualsReplay:true,countEventIdsEqualReplayEventIds:true,everyCountEventIdExistsInFeed:true,expectedQuantity:100,finalQuantity:100,replayedQuantity:100,noDrops:true,noDuplicates:true,passed:true}}}}; }
test("summary refuses green without exactly 30 passing batches", () => { assert.throws(() => summarizeResults([]), /exactly 30/i); });
test("summary rejects duplicate internal batch numbers before accepting a 30-batch result", () => { const entries = Array.from({ length: 30 }, (_, index) => ({ batch: { batch: index ? 1 : 1 }, result: {} })); assert.throws(() => summarizeResults(entries), /batch numbers/i); });
test("summary aggregates all 3000 raw observations with nearest-rank percentiles and zero safety metrics", () => { const summary=summarizeResults(Array.from({length:30},(_,i)=>fixture(i+1))); assert.equal(summary.total,3000); assert.equal(summary.countedQuantity,3000); assert.equal(summary.p50Ms,1499); assert.equal(summary.p95Ms,2849); assert.equal(summary.p99Ms,2969); assert.equal(summary.nonLocalRequestCount,0); assert.equal(summary.serverEgressAttemptCount,0); });

test("current-run verification applies the same seed-shadow countability filter as manifest generation", () => {
  assert.equal(typeof summarizeModule.prepareCurrentSourceRows, "function");
  const base = {
    barcode_type: "upc",
    brand: "brand",
    model: "trail_model",
    model_display: "",
    size: "215/70R15",
    load_index: "102",
    speed_rating: "H",
    current_status: "active_retail",
    usable_for: "auto_count_candidate",
    source_count: 2,
  };
  const rows = summarizeModule.prepareCurrentSourceRows([
    { ...base, barcode: "848983012906", canonical_product_uid: "TIRE_SEED_SHADOW" },
    { ...base, barcode: "700000000009", canonical_product_uid: "TIRE_COUNTABLE" },
  ]);
  assert.deepEqual(rows.map((row) => row.canonical_product_uid), ["TIRE_COUNTABLE"]);
});

function writeRun(entries) {
  const parent = mkdtempSync(join(tmpdir(), "scanbin-proof-parent-"));
  const root = join(parent, "run-abcdef1");
  mkdirSync(root);
  mkdirSync(join(root, "batches"));
  mkdirSync(join(root, "results"));
  const manifest = { schemaVersion:1, seed:"s", gitSha:"abcdef1", databaseSha256:"a".repeat(64), generatedAt:"2026-07-29T00:00:00.000Z", total:3000, batchSize:100, batchCount:30, agentCount:10, manifestSha256:"", rows:entries.flatMap((entry) => entry.batch.rows) };
  const unsigned = { ...manifest }; delete unsigned.manifestSha256; manifest.manifestSha256 = digest(unsigned);
  for (const [index, entry] of entries.entries()) {
    const name = `batch-${String(index + 1).padStart(2, "0")}.json`;
    entry.result.ledgerProof.manifest.manifestSha256 = manifest.manifestSha256;
    writeFileSync(join(root, "batches", name), JSON.stringify(entry.batch));
    writeFileSync(join(root, "results", name), JSON.stringify(entry.result));
  }
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dirname(root), "active-run.json"), JSON.stringify({ schemaVersion:1, runDirectory:basename(root), gitSha:manifest.gitSha, databaseSha256:manifest.databaseSha256, manifestSha256:manifest.manifestSha256, generatedAt:manifest.generatedAt }));
  const runtime = join(dirname(root), "runtime");
  mkdirSync(runtime);
  const ledger = join(runtime, "egress-proof.jsonl");
  writeFileSync(ledger, "");
  writeFileSync(join(root, "runtime-session.json"), JSON.stringify({ schemaVersion:1, gitSha:manifest.gitSha, databaseSha256:manifest.databaseSha256, manifestSha256:manifest.manifestSha256, runDirectory:basename(root), ledgerPath:ledger, nonce:"c".repeat(32), startedAt:manifest.generatedAt }));
  return root;
}

function fixtureEnvironment(manifest) {
  return () => {
    assert.equal(manifest.gitSha, "abcdef1");
    assert.equal(manifest.databaseSha256, "a".repeat(64));
  };
}

function completeEntries() { return Array.from({ length: 30 }, (_, index) => fixture(index + 1)); }

test("summarizeDirectory writes a 30-row green matrix with explicit 30/30 ledger and zero-egress proof", () => {
  const root = writeRun(completeEntries());
  try {
    const summary = summarizeDirectory(root, { verifyCurrentRun: fixtureEnvironment });
    const report = readFileSync(join(root, "REPORT.md"), "utf8");
    assert.equal(summary.batchCount, 30);
    assert.equal(JSON.parse(readFileSync(join(root, "summary.json"), "utf8")).total, 3000);
    assert.match(report, /30\/30 ledger/i);
    assert.match(report, /zero egress/i);
    assert.equal(report.split("\n").filter((line) => /^\| \d+ \|/.test(line)).length, 30);
  } finally { rmSync(dirname(root), { recursive: true, force: true }); }
});

test("summarizeDirectory refuses a result-only egress claim without a live bound runtime ledger anchor", () => {
  const root = writeRun(completeEntries());
  try {
    rmSync(join(root, "runtime-session.json"));
    assert.throws(() => summarizeDirectory(root, { verifyCurrentRun: fixtureEnvironment }), /runtime|egress/i);
  } finally { rmSync(dirname(root), { recursive: true, force: true }); }
});

test("summarizeDirectory refuses a stale manifest before trusting mutable artifacts", () => {
  const root = writeRun(completeEntries());
  try {
    assert.throws(() => summarizeDirectory(root), /current git HEAD/i);
  } finally { rmSync(dirname(root), { recursive: true, force: true }); }
});

test("summarizeDirectory rejects a batch result whose runtime nonce does not match the active session", () => {
  const entries = completeEntries();
  entries[12].result.runtimeSessionNonce = "d".repeat(32);
  const root = writeRun(entries);
  try {
    assert.throws(() => summarizeDirectory(root, { verifyCurrentRun: fixtureEnvironment }), /every batch|nonce/i);
  } finally { rmSync(dirname(root), { recursive: true, force: true }); }
});

test("summarizeDirectory reads the live anchored ledger instead of trusting empty result self-reports", () => {
  const root = writeRun(completeEntries());
  try {
    writeFileSync(join(dirname(root), "runtime", "egress-proof.jsonl"), '{"pid":1,"timestamp":"2026-07-29T00:00:00.000Z","method":"GET","protocol":"https:","host":"example.com","path":"/"}\n');
    assert.throws(() => summarizeDirectory(root, { verifyCurrentRun: fixtureEnvironment }), /blocked attempt/i);
  } finally { rmSync(dirname(root), { recursive: true, force: true }); }
});

test("summarizeDirectory refuses a runtime ledger path outside the active run runtime root", () => {
  const root = writeRun(completeEntries());
  try {
    const sessionPath = join(root, "runtime-session.json");
    const session = JSON.parse(readFileSync(sessionPath, "utf8"));
    session.ledgerPath = join(dirname(root), "active-run.json");
    writeFileSync(sessionPath, JSON.stringify(session));
    assert.throws(() => summarizeDirectory(root, { verifyCurrentRun: fixtureEnvironment }), /runtime egress ledger path/i);
  } finally { rmSync(dirname(root), { recursive: true, force: true }); }
});

test("summarizeDirectory rejects a symlink or junctioned runtime ledger that escapes the canonical runtime root", (t) => {
  const root = writeRun(completeEntries());
  try {
    const outsideRuntime = join(dirname(root), "outside-runtime");
    mkdirSync(outsideRuntime);
    writeFileSync(join(outsideRuntime, "egress.jsonl"), "");
    const linkedRuntime = join(dirname(root), "runtime", "linked-runtime");
    try {
      symlinkSync(outsideRuntime, linkedRuntime, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (error && typeof error === "object" && ["EPERM", "EACCES"].includes(error.code)) {
        t.skip("Windows denied local symlink creation for this process");
        return;
      }
      throw error;
    }
    const sessionPath = join(root, "runtime-session.json");
    const session = JSON.parse(readFileSync(sessionPath, "utf8"));
    session.ledgerPath = join(linkedRuntime, "egress.jsonl");
    writeFileSync(sessionPath, JSON.stringify(session));
    assert.throws(() => summarizeDirectory(root, { verifyCurrentRun: fixtureEnvironment }), /runtime egress ledger path/i);
  } finally { rmSync(dirname(root), { recursive: true, force: true }); }
});

test("summarizeDirectory requires the parent active-run manifest anchor", () => {
  const root = writeRun(completeEntries());
  try {
    rmSync(join(dirname(root), "active-run.json"));
    assert.throws(() => summarizeDirectory(root, { verifyCurrentRun: fixtureEnvironment }), /manifest|active-run/i);
  } finally { rmSync(dirname(root), { recursive: true, force: true }); }
});

test("summarizeDirectory rejects an extra result file", () => {
  const root = writeRun(completeEntries());
  try {
    writeFileSync(join(root, "results", "batch-31.json"), "{}");
    assert.throws(() => summarizeDirectory(root, { verifyCurrentRun: fixtureEnvironment }), /exactly batch-01 through batch-30/i);
  } finally { rmSync(dirname(root), { recursive: true, force: true }); }
});

test("summarizeDirectory rejects an extra locked batch file", () => {
  const root = writeRun(completeEntries());
  try {
    writeFileSync(join(root, "batches", "batch-31.json"), "{}");
    assert.throws(() => summarizeDirectory(root, { verifyCurrentRun: fixtureEnvironment }), /exactly batch-01 through batch-30/i);
  } finally { rmSync(dirname(root), { recursive: true, force: true }); }
});

test("summarizeDirectory rejects a missing result file", () => {
  const root = writeRun(completeEntries());
  try {
    rmSync(join(root, "results", "batch-30.json"));
    assert.throws(() => summarizeDirectory(root, { verifyCurrentRun: fixtureEnvironment }), /exactly batch-01 through batch-30/i);
  } finally { rmSync(dirname(root), { recursive: true, force: true }); }
});

test("summarizeDirectory rejects a filename to internal batch mismatch", () => {
  const entries = completeEntries();
  entries[4].result.ledgerProof.manifest.batch = 6;
  const root = writeRun(entries);
  try {
    assert.throws(() => summarizeDirectory(root, { verifyCurrentRun: fixtureEnvironment }), /result batch-05 binding/i);
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
    assert.throws(() => summarizeDirectory(root, { verifyCurrentRun: fixtureEnvironment }), /batch-01 binding/i);
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
    assert.throws(() => summarizeDirectory(root, { verifyCurrentRun: fixtureEnvironment }), /batch-01 binding/i);
  } finally { rmSync(dirname(root), { recursive: true, force: true }); }
});
