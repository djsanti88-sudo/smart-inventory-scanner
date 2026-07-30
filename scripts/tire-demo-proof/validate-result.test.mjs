import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { validateBatchResult } from "./validate-result.mjs";

const hash = "a".repeat(64); const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const expectedRows = Array.from({ length: 100 }, (_, index) => ({ barcode: `code-${index}`, canonicalProductUid: `uid-${index}`, brand: "Brand", model: "Model", size: "225/65R17" }));
const manifestSha256 = "b".repeat(64);
const batch = { schemaVersion: 1, seed: "scanbin-local-tire-demo-v1", gitSha: "abc", databaseSha256: hash, batch: 1, batchSha256: digest(expectedRows), expectedBarcodesSha256: digest(expectedRows.map((row) => row.barcode)), expectedCanonicalProductUidsSha256: digest(expectedRows.map((row) => row.canonicalProductUid)), rows: expectedRows };
function good() {
  const events = expectedRows.map((row, index) => ({ eventId: `event-${index}`, cleanCode: row.barcode, matchedProductId: `product-${index}`, canonicalProductUid: row.canonicalProductUid, quantityDelta: 1, quantityAfterScan: 1, status: "verified" }));
  const counts = events.map((event) => ({ productId: event.matchedProductId, quantity: 1, scanEventIds: [event.eventId] }));
  return { observations: expectedRows.map((row, index) => ({ ...row, eventId: `event-${index}`, matchedProductId: `product-${index}`, feedVisible: true, status: "verified", latencyMs: index, consoleErrors: [], nonLocalRequests: [] })), ledgerProof: { schemaVersion: 1, sessionId: "session", generatedAt: "2026-07-29T00:00:00.000Z", manifest: { schemaVersion: 1, gitSha: "abc", databaseSha256: hash, manifestSha256, seed: batch.seed, batch: 1, batchSha256: batch.batchSha256, expectedBarcodesSha256: batch.expectedBarcodesSha256, expectedCanonicalProductUidsSha256: batch.expectedCanonicalProductUidsSha256 }, expected: { rows: 100, barcodes: expectedRows.map((row) => row.barcode) }, events, finalCounts: counts, replayedCounts: counts, assertions: { allExpectedBarcodesSeenExactlyOnce:true, unexpectedBarcodeCount:0, duplicateEventIdCount:0, missingEventIdCount:0, unmatchedEventCount:0, canonicalIdentityMismatchCount:0, distinctExpectedCanonicalProductUidCount:100, distinctMatchedProductIdCount:100, distinctFinalCountProductIdCount:100, distinctReplayedCountProductIdCount:100, canonicalProductMatchedProductBijection:true, finalEqualsReplay:true, countEventIdsEqualReplayEventIds:true, everyCountEventIdExistsInFeed:true, expectedQuantity:100, finalQuantity:100, replayedQuantity:100, noDrops:true, noDuplicates:true, passed:true } }, serverEgressAttempts: [] };
}
test("accepts an exact hash-bound 100-event proof and uses nearest-rank percentiles", () => { const result = validateBatchResult(batch, good()); assert.equal(result.passed, true); assert.equal(result.countedQuantity, 100); assert.equal(result.p95Ms, 94); });
test("accepts model display variants that differ only by case or explicit delimiters", () => {
  for (const observedModel of ["su318ht", "SU318_H_T", "SU318/H/T", "SU318-H-T", " SU318   H\tT "]) {
    const locked = structuredClone(batch);
    locked.rows[0].model = "SU318 H T";
    locked.batchSha256 = digest(locked.rows);
    locked.expectedBarcodesSha256 = digest(locked.rows.map((row) => row.barcode));
    locked.expectedCanonicalProductUidsSha256 = digest(locked.rows.map((row) => row.canonicalProductUid));
    const value = good();
    Object.assign(value.ledgerProof.manifest, { batchSha256: locked.batchSha256, expectedBarcodesSha256: locked.expectedBarcodesSha256, expectedCanonicalProductUidsSha256: locked.expectedCanonicalProductUidsSha256 });
    value.observations[0].model = observedModel;
    assert.equal(validateBatchResult(locked, value).passed, true, observedModel);
  }
});
test("rejects model changes that are not explicit display delimiters", () => {
  for (const [expectedModel, observedModel] of [["SU318 H T", "SU T"], ["RP18", "RP8"], ["AT3", "AT"], ["A/S+", "A/S"]]) {
    const locked = structuredClone(batch);
    locked.rows[0].model = expectedModel;
    locked.batchSha256 = digest(locked.rows);
    locked.expectedBarcodesSha256 = digest(locked.rows.map((row) => row.barcode));
    locked.expectedCanonicalProductUidsSha256 = digest(locked.rows.map((row) => row.canonicalProductUid));
    const value = good();
    Object.assign(value.ledgerProof.manifest, { batchSha256: locked.batchSha256, expectedBarcodesSha256: locked.expectedBarcodesSha256, expectedCanonicalProductUidsSha256: locked.expectedCanonicalProductUidsSha256 });
    value.observations[0].model = observedModel;
    const validation = validateBatchResult(locked, value);
    assert.equal(validation.passed, false, `${expectedModel} vs ${observedModel}`);
    assert.ok(validation.failures.some((failure) => failure.rule === "model"), `${expectedModel} vs ${observedModel}`);
  }
});
test("rejects case- and whitespace-changed canonical UIDs across every proof identity boundary", () => {
  for (const [name, mutate, rule] of [
    ["observation vs manifest case", (value) => { value.observations[0].canonicalProductUid = "UID-0"; }, "canonicalProductUid"],
    ["observation vs manifest whitespace", (value) => { value.observations[0].canonicalProductUid = " uid-0 "; }, "canonicalProductUid"],
    ["ledger event vs manifest case", (value) => { value.ledgerProof.events[0].canonicalProductUid = "UID-0"; }, "ledger_event_identity"],
    ["ledger event vs manifest whitespace", (value) => { value.ledgerProof.events[0].canonicalProductUid = " uid-0 "; }, "ledger_event_identity"],
    ["observation vs ledger case", (value) => { value.ledgerProof.events[0].canonicalProductUid = "UID-0"; }, "observation_ledger_link"],
    ["observation vs ledger whitespace", (value) => { value.ledgerProof.events[0].canonicalProductUid = " uid-0 "; }, "observation_ledger_link"],
  ]) {
    const value = good();
    mutate(value);
    const validation = validateBatchResult(batch, value);
    assert.equal(validation.passed, false, name);
    assert.ok(validation.failures.some((failure) => failure.rule === rule), name);
  }
});
test("rejects case- and whitespace-changed opaque product IDs at the observation-ledger boundary", () => {
  for (const [name, changedProductId] of [["case", "Product-0"], ["whitespace", " product-0 "]]) {
    const value = good();
    value.ledgerProof.events[0].matchedProductId = changedProductId;
    value.ledgerProof.finalCounts[0].productId = changedProductId;
    const validation = validateBatchResult(batch, value);
    assert.equal(validation.passed, false, name);
    assert.ok(validation.failures.some((failure) => failure.rule === "observation_ledger_link"), name);
  }
});

test("rejects two distinct canonical products collapsed onto one matched product and count row", () => {
  const value = good();
  value.observations[1].matchedProductId = "product-0";
  value.ledgerProof.events[1].matchedProductId = "product-0";
  value.ledgerProof.events[1].quantityAfterScan = 2;
  value.ledgerProof.finalCounts[0] = {
    productId: "product-0",
    quantity: 2,
    scanEventIds: ["event-0", "event-1"],
  };
  value.ledgerProof.finalCounts.splice(1, 1);
  value.ledgerProof.replayedCounts = structuredClone(value.ledgerProof.finalCounts);

  const validation = validateBatchResult(batch, value);

  assert.equal(validation.passed, false);
  assert.ok(validation.failures.some((failure) => failure.rule === "canonical_product_bijection"));
});

test("rejects one canonical product fanned out to multiple matched products", () => {
  const locked = structuredClone(batch);
  locked.rows[1].canonicalProductUid = locked.rows[0].canonicalProductUid;
  locked.batchSha256 = digest(locked.rows);
  locked.expectedBarcodesSha256 = digest(locked.rows.map((row) => row.barcode));
  locked.expectedCanonicalProductUidsSha256 = digest(locked.rows.map((row) => row.canonicalProductUid));
  const value = good();
  value.observations[1].canonicalProductUid = "uid-0";
  value.ledgerProof.events[1].canonicalProductUid = "uid-0";
  Object.assign(value.ledgerProof.manifest, {
    batchSha256: locked.batchSha256,
    expectedBarcodesSha256: locked.expectedBarcodesSha256,
    expectedCanonicalProductUidsSha256: locked.expectedCanonicalProductUidsSha256,
  });

  const validation = validateBatchResult(locked, value);

  assert.equal(validation.passed, false);
  assert.ok(validation.failures.some((failure) => failure.rule === "canonical_product_bijection"));
});

test("rejects case- and whitespace-changed cleaned barcodes at every manifest-ledger boundary", () => {
  for (const [name, mutate, rule] of [
    ["observation case", (value) => { value.observations[0].barcode = "CODE-0"; }, "missing_barcode"],
    ["observation whitespace", (value) => { value.observations[0].barcode = " code-0 "; }, "missing_barcode"],
    ["ledger expected case", (value) => { value.ledgerProof.expected.barcodes[0] = "CODE-0"; }, "ledger_expected_barcodes"],
    ["ledger expected whitespace", (value) => { value.ledgerProof.expected.barcodes[0] = " code-0 "; }, "ledger_expected_barcodes"],
    ["ledger event case", (value) => { value.ledgerProof.events[0].cleanCode = "CODE-0"; }, "ledger_event_identity"],
    ["ledger event whitespace", (value) => { value.ledgerProof.events[0].cleanCode = " code-0 "; }, "ledger_event_identity"],
    ["observation-ledger case", (value) => { value.ledgerProof.events[0].cleanCode = "CODE-0"; }, "observation_ledger_link"],
    ["observation-ledger whitespace", (value) => { value.ledgerProof.events[0].cleanCode = " code-0 "; }, "observation_ledger_link"],
  ]) {
    const value = good();
    mutate(value);
    const validation = validateBatchResult(batch, value);
    assert.equal(validation.passed, false, name);
    assert.ok(validation.failures.some((failure) => failure.rule === rule), name);
  }
});
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

test("rejects a missing or malformed proof manifest hash", () => {
  for (const mutate of [
    (value) => { delete value.ledgerProof.manifest.manifestSha256; },
    (value) => { value.ledgerProof.manifest.manifestSha256 = "not-a-sha256"; },
  ]) {
    const value = good();
    mutate(value);
    const validation = validateBatchResult(batch, value);
    assert.equal(validation.passed, false);
    assert.ok(validation.failures.some((failure) => failure.rule === "manifest_binding"));
  }
});

test("rejects a proof manifest hash that mismatches the run anchor", () => {
  const value = good();
  value.ledgerProof.manifest.manifestSha256 = "0".repeat(64);
  const anchor = {
    batch: 1,
    manifest: {
      gitSha: batch.gitSha,
      databaseSha256: batch.databaseSha256,
      manifestSha256,
      seed: batch.seed,
    },
  };
  const validation = validateBatchResult(batch, value, anchor);
  assert.equal(validation.passed, false);
  assert.ok(validation.failures.some((failure) => failure.rule === "run_manifest_anchor"));
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
    canonicalIdentityMismatchCount: 0,
    distinctExpectedCanonicalProductUidCount: 100,
    distinctMatchedProductIdCount: 100,
    distinctFinalCountProductIdCount: 100,
    distinctReplayedCountProductIdCount: 100,
    canonicalProductMatchedProductBijection: true,
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
