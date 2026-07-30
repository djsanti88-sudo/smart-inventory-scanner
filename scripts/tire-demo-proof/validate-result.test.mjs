import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { validateBatchResult } from "./validate-result.mjs";

const hash = "a".repeat(64); const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const expectedRows = Array.from({ length: 100 }, (_, index) => ({ barcode: `code-${index}`, canonicalProductUid: `uid-${index}`, brand: "Brand", model: "Model", size: "225/65R17" }));
const batch = { schemaVersion: 1, seed: "scanbin-local-tire-demo-v1", gitSha: "abc", databaseSha256: hash, batch: 1, batchSha256: digest(expectedRows), expectedBarcodesSha256: digest(expectedRows.map((row) => row.barcode)), expectedCanonicalProductUidsSha256: digest(expectedRows.map((row) => row.canonicalProductUid)), rows: expectedRows };
function good() {
  const events = expectedRows.map((row, index) => ({ eventId: `event-${index}`, cleanCode: row.barcode, matchedProductId: `product-${index}`, canonicalProductUid: row.canonicalProductUid, quantityDelta: 1, quantityAfterScan: 1, status: "verified" }));
  const counts = events.map((event) => ({ productId: event.matchedProductId, quantity: 1, scanEventIds: [event.eventId] }));
  return { observations: expectedRows.map((row, index) => ({ ...row, eventId: `event-${index}`, matchedProductId: `product-${index}`, feedVisible: true, status: "verified", latencyMs: index, consoleErrors: [], nonLocalRequests: [] })), ledgerProof: { schemaVersion: 1, sessionId: "session", generatedAt: "2026-07-29T00:00:00.000Z", manifest: { schemaVersion: 1, gitSha: "abc", databaseSha256: hash, seed: batch.seed, batch: 1, batchSha256: batch.batchSha256, expectedBarcodesSha256: batch.expectedBarcodesSha256, expectedCanonicalProductUidsSha256: batch.expectedCanonicalProductUidsSha256 }, expected: { rows: 100, barcodes: expectedRows.map((row) => row.barcode) }, events, finalCounts: counts, replayedCounts: counts, assertions: { allExpectedBarcodesSeenExactlyOnce:true, unexpectedBarcodeCount:0, duplicateEventIdCount:0, missingEventIdCount:0, unmatchedEventCount:0, finalEqualsReplay:true, countEventIdsEqualReplayEventIds:true, everyCountEventIdExistsInFeed:true, expectedQuantity:100, finalQuantity:100, replayedQuantity:100, noDrops:true, noDuplicates:true, passed:true } }, serverEgressAttempts: [] };
}
test("accepts an exact hash-bound 100-event proof and uses nearest-rank percentiles", () => { const result = validateBatchResult(batch, good()); assert.equal(result.passed, true); assert.equal(result.countedQuantity, 100); assert.equal(result.p95Ms, 94); });
test("rejects observation, identity, feed, proof, count, console, and egress violations", () => {
  for (const mutate of [
    (x) => x.observations.pop(), (x) => { x.observations[0].brand = "Wrong"; }, (x) => { x.observations[0].feedVisible = false; },
    (x) => { x.observations[0].eventId = ""; }, (x) => { x.ledgerProof.manifest.batch = 2; },
    (x) => { x.ledgerProof.finalCounts[0].scanEventIds = ["absent"]; }, (x) => { x.observations[0].consoleErrors = ["boom"]; }, (x) => { x.serverEgressAttempts = [{ host: "example.com" }]; },
    (x) => { x.observations[1].eventId = x.observations[0].eventId; }, (x) => { x.observations[0].matchedProductId = "wrong-product"; },
    (x) => { x.ledgerProof.events[0].canonicalProductUid = "wrong-uid"; }, (x) => { x.ledgerProof.events[0].quantityDelta = 2; },
    (x) => { x.ledgerProof.finalCounts[0].quantity = 2; }, (x) => { delete x.observations[0].consoleErrors; }, (x) => { delete x.serverEgressAttempts; },
  ]) { const value = good(); mutate(value); assert.equal(validateBatchResult(batch, value).passed, false); }
});

test("rejects a tampered locked batch hash", () => {
  const locked = { ...batch, batchSha256: "0".repeat(64) };
  const validation = validateBatchResult(locked, good());
  assert.equal(validation.passed, false);
  assert.ok(validation.failures.some((failure) => failure.rule === "locked_batch_hashes"));
});

test("rejects an incomplete ledger assertion schema", () => {
  const value = good();
  delete value.ledgerProof.assertions.noDuplicates;
  const validation = validateBatchResult(batch, value);
  assert.equal(validation.passed, false);
  assert.ok(validation.failures.some((failure) => failure.rule === "ledger_assertions_schema"));
});

test("rejects ledger events with missing, extraneous, and mistyped fields", () => {
  for (const mutate of [
    (event) => { delete event.quantityAfterScan; },
    (event) => { event.unexpected = true; },
    (event) => { event.quantityDelta = "1"; },
    (event) => { event.quantityAfterScan = Infinity; },
    (event) => { event.decodeStatus = 1; },
  ]) {
    const value = good();
    mutate(value.ledgerProof.events[0]);
    const validation = validateBatchResult(batch, value);
    assert.equal(validation.passed, false);
    assert.ok(validation.failures.some((failure) => failure.rule === "ledger_event_schema"));
  }
});

test("rejects every ledger assertion that disagrees with the independently recomputed proof", () => {
  const expectedValues = {
    allExpectedBarcodesSeenExactlyOnce: true,
    unexpectedBarcodeCount: 0,
    duplicateEventIdCount: 0,
    missingEventIdCount: 0,
    unmatchedEventCount: 0,
    finalEqualsReplay: true,
    countEventIdsEqualReplayEventIds: true,
    everyCountEventIdExistsInFeed: true,
    expectedQuantity: 100,
    finalQuantity: 100,
    replayedQuantity: 100,
    noDrops: true,
    noDuplicates: true,
    passed: true,
  };
  for (const [key, expected] of Object.entries(expectedValues)) {
    const value = good();
    value.ledgerProof.assertions[key] = typeof expected === "boolean" ? false : expected + 1;
    const validation = validateBatchResult(batch, value);
    assert.equal(validation.passed, false, key);
    assert.ok(validation.failures.some((failure) => failure.rule === "ledger_assertion_value"), key);
  }
});
