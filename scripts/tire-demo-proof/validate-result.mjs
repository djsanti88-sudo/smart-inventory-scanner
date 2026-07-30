import { createHash } from "node:crypto";
function norm(value) { return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase(); }
function hash(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function sameDisplay(left, right) { return norm(left) === norm(right); }
function modelDisplayKey(value) { return String(value ?? "").toLowerCase().replace(/[\s_./-]/g, ""); }
function sameModelDisplay(left, right) { return modelDisplayKey(left) === modelDisplayKey(right); }
function sameCanonicalProductUid(left, right) { return left === right; }
function percentile(values, percentage) { if (!values.length) return 0; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.ceil((percentage / 100) * sorted.length) - 1]; }
function fail(failures, barcode, rule, expected, observed) { failures.push({ barcode, rule, expected, observed }); }
function stable(value) { return JSON.stringify(value); }
const OBSERVATION_KEYS = [
  "barcode", "barcodeType", "canonicalProductUid", "brand", "model", "size",
  "loadIndex", "speedRating", "manufacturerPartNumber", "type", "season",
  "sourceCount", "confidence", "currentStatus", "usableFor",
  "fieldCompletenessScore", "angle", "stratum", "ordinal", "batch", "agent",
  "eventId", "matchedProductId", "feedVisible", "status", "rawStatus",
  "latencyMs", "consoleErrors", "nonLocalRequests",
];
const OBSERVATION_STRING_KEYS = [
  "barcode", "barcodeType", "canonicalProductUid", "brand", "model", "size",
  "loadIndex", "speedRating", "manufacturerPartNumber", "type", "season",
  "confidence", "currentStatus", "usableFor", "angle", "stratum", "eventId",
  "matchedProductId", "status", "rawStatus",
];
function hasExactKeys(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}
function hasCanonicalProductBijection(pairs) {
  const canonicalToProduct = new Map();
  const productToCanonical = new Map();
  for (const { canonicalProductUid, matchedProductId } of pairs) {
    if (!canonicalProductUid || !matchedProductId) return false;
    const mappedProduct = canonicalToProduct.get(canonicalProductUid);
    const mappedCanonical = productToCanonical.get(matchedProductId);
    if ((mappedProduct && mappedProduct !== matchedProductId) || (mappedCanonical && mappedCanonical !== canonicalProductUid)) return false;
    canonicalToProduct.set(canonicalProductUid, matchedProductId);
    productToCanonical.set(matchedProductId, canonicalProductUid);
  }
  return true;
}

export function validateBatchResult(batch, result, anchor) {
  const failures = [];
  if (!hasExactKeys(result, ["observations", "ledgerProof", "serverEgressAttempts", "runtimeSessionNonce"])) fail(failures, "", "result_schema", "exact result JSON schema", result);
  if (typeof result?.runtimeSessionNonce !== "string" || !/^[a-f0-9]{32,}$/i.test(result.runtimeSessionNonce)) fail(failures, "", "runtime_session_nonce", "32+ hexadecimal characters", result?.runtimeSessionNonce);
  if (anchor?.runtimeSessionNonce && result?.runtimeSessionNonce !== anchor.runtimeSessionNonce) fail(failures, "", "runtime_session_nonce", anchor.runtimeSessionNonce, result?.runtimeSessionNonce);
  const observations = Array.isArray(result?.observations) ? result.observations : [];
  const expected = Array.isArray(batch?.rows) ? batch.rows : [];
  if (batch?.batchSha256 !== hash(expected) || batch?.expectedBarcodesSha256 !== hash(expected.map((row) => row.barcode)) || batch?.expectedCanonicalProductUidsSha256 !== hash(expected.map((row) => row.canonicalProductUid))) fail(failures, "", "locked_batch_hashes", "generator-compatible SHA-256", "mismatch");
  if (expected.length !== 100) fail(failures, "", "locked_batch_rows", 100, expected.length);
  if (observations.length !== 100) fail(failures, "", "observation_count", 100, observations.length);
  const byBarcode = new Map();
  const observationEventIds = new Set();
  for (const observation of observations) {
    const observationSchemaValid = hasExactKeys(observation, OBSERVATION_KEYS) &&
      OBSERVATION_STRING_KEYS.every((key) => typeof observation[key] === "string") &&
      Number.isFinite(observation.sourceCount) && Number.isFinite(observation.fieldCompletenessScore) &&
      Number.isSafeInteger(observation.ordinal) && Number.isSafeInteger(observation.batch) && Number.isSafeInteger(observation.agent) &&
      Number.isFinite(observation.latencyMs) && observation.latencyMs >= 0 && observation.feedVisible === true &&
      Array.isArray(observation.consoleErrors) && observation.consoleErrors.every((entry) => typeof entry === "string") &&
      Array.isArray(observation.nonLocalRequests) && observation.nonLocalRequests.every((entry) => typeof entry === "string");
    if (!observationSchemaValid) fail(failures, observation?.barcode ?? "", "observation_schema", "exact native observation fields", observation);
    const key = observation.barcode; if (byBarcode.has(key)) fail(failures, observation.barcode, "duplicate_barcode", "unique", observation.barcode); else byBarcode.set(key, observation);
    if (observation.feedVisible !== true) fail(failures, observation.barcode, "feed_visible", true, observation.feedVisible);
    if (!String(observation.eventId ?? "").trim() || observationEventIds.has(observation.eventId)) fail(failures, observation.barcode, "event_id", "unique non-blank", observation.eventId); observationEventIds.add(observation.eventId);
    if (!String(observation.matchedProductId ?? "").trim()) fail(failures, observation.barcode, "matched_product_id", "non-blank", observation.matchedProductId);
    if (!Array.isArray(observation.consoleErrors) || observation.consoleErrors.length) fail(failures, observation.barcode, "console_errors", [], observation.consoleErrors);
    if (!Array.isArray(observation.nonLocalRequests) || observation.nonLocalRequests.length) fail(failures, observation.barcode, "nonlocal_requests", [], observation.nonLocalRequests);
  }
  for (const row of expected) {
    const observation = byBarcode.get(row.barcode);
    if (!observation) { fail(failures, row.barcode, "missing_barcode", row.barcode, undefined); continue; }
    for (const [key, expectedValue] of [["canonicalProductUid", row.canonicalProductUid], ["brand", row.brand], ["model", row.model], ["size", row.size]]) {
      if (String(expectedValue ?? "").trim() && !(key === "canonicalProductUid" ? sameCanonicalProductUid(observation[key], expectedValue) : key === "model" ? sameModelDisplay(observation[key], expectedValue) : sameDisplay(observation[key], expectedValue))) fail(failures, row.barcode, key, expectedValue, observation[key]);
    }
    if (norm(observation.status) !== "verified") fail(failures, row.barcode, "verified_status", "verified", observation.status);
  }
  for (const [key, observation] of byBarcode) if (!expected.some((row) => row.barcode === key)) fail(failures, observation.barcode, "extra_barcode", "locked batch barcode", observation.barcode);
  if (!Array.isArray(result?.serverEgressAttempts) || result.serverEgressAttempts.length) fail(failures, "", "server_egress", [], result?.serverEgressAttempts);
  const proof = result?.ledgerProof;
  if (!hasExactKeys(proof, ["schemaVersion", "sessionId", "generatedAt", "manifest", "expected", "events", "finalCounts", "replayedCounts", "assertions"])) fail(failures, "", "ledger_proof_schema", "exact ledger proof JSON schema", proof);
  const assertionKeys = ["allExpectedBarcodesSeenExactlyOnce", "unexpectedBarcodeCount", "duplicateEventIdCount", "missingEventIdCount", "unmatchedEventCount", "canonicalIdentityMismatchCount", "distinctExpectedCanonicalProductUidCount", "distinctMatchedProductIdCount", "distinctFinalCountProductIdCount", "distinctReplayedCountProductIdCount", "canonicalProductMatchedProductBijection", "finalEqualsReplay", "countEventIdsEqualReplayEventIds", "everyCountEventIdExistsInFeed", "expectedQuantity", "finalQuantity", "replayedQuantity", "noDrops", "noDuplicates", "passed"];
  if (!proof?.assertions || Object.keys(proof.assertions).length !== assertionKeys.length || assertionKeys.some((key) => !Object.hasOwn(proof.assertions, key))) fail(failures, "", "ledger_assertions_schema", assertionKeys, proof?.assertions);
  const manifest = proof?.manifest;
  const batchManifestKeys = ["schemaVersion", "gitSha", "databaseSha256", "seed", "batch", "batchSha256", "expectedBarcodesSha256", "expectedCanonicalProductUidsSha256"];
  const manifestKeys = [...batchManifestKeys, "manifestSha256"];
  if (!manifest || Object.keys(manifest).length !== manifestKeys.length || manifestKeys.some((key) => !Object.hasOwn(manifest, key)) || batchManifestKeys.some((key) => manifest?.[key] !== batch?.[key]) || typeof manifest?.manifestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifest.manifestSha256)) fail(failures, "", "manifest_binding", batch, manifest);
  if (anchor && (batch?.batch !== anchor.batch || manifest?.batch !== anchor.batch || batch?.gitSha !== anchor.manifest?.gitSha || batch?.databaseSha256 !== anchor.manifest?.databaseSha256 || batch?.seed !== anchor.manifest?.seed || manifest?.manifestSha256 !== anchor.manifest?.manifestSha256)) fail(failures, "", "run_manifest_anchor", "positionally bound manifest batch", { batch: batch?.batch, ledgerBatch: manifest?.batch, anchor });
  if (typeof proof?.sessionId !== "string" || !proof.sessionId || typeof proof?.generatedAt !== "string" || Number.isNaN(Date.parse(proof.generatedAt)) || !hasExactKeys(proof?.expected, ["rows", "barcodes"]) || !Number.isSafeInteger(proof.expected.rows) || !Array.isArray(proof.expected.barcodes) || !proof.expected.barcodes.every((barcode) => typeof barcode === "string")) fail(failures, "", "ledger_metadata", "native session metadata and expected shape", proof);
  const events = Array.isArray(proof?.events) ? proof.events : [];
  if (proof?.schemaVersion !== 1 || events.length !== 100 || proof?.expected?.rows !== 100 || proof?.assertions?.passed !== true) fail(failures, "", "ledger_shape", "100 passing events", events.length);
  const lockedBarcodes = expected.map((row) => row.barcode).sort();
  const proofBarcodes = Array.isArray(proof?.expected?.barcodes) ? [...proof.expected.barcodes].sort() : [];
  if (proofBarcodes.join("|") !== lockedBarcodes.join("|")) fail(failures, "", "ledger_expected_barcodes", lockedBarcodes, proofBarcodes);
  const eventIds = new Set(); const eventById = new Map(); let duplicateEventIdCount = 0; let missingEventIdCount = 0; let unmatchedEventCount = 0;
  const eventBarcodes = [];
  const eventKeys = ["eventId", "cleanCode", "matchedProductId", "canonicalProductUid", "quantityDelta", "quantityAfterScan", "status"];
  for (const event of events) { const keys = event && typeof event === "object" ? Object.keys(event) : []; const eventSchemaValid = Boolean(event) && typeof event.eventId === "string" && typeof event.cleanCode === "string" && typeof event.matchedProductId === "string" && typeof event.canonicalProductUid === "string" && typeof event.quantityDelta === "number" && Number.isFinite(event.quantityDelta) && Number.isFinite(event.quantityAfterScan) && typeof event.status === "string" && (!Object.hasOwn(event, "decodeStatus") || typeof event.decodeStatus === "string") && keys.every((key) => eventKeys.includes(key) || key === "decodeStatus") && eventKeys.every((key) => Object.hasOwn(event, key)); if (!eventSchemaValid) fail(failures, event?.cleanCode ?? "", "ledger_event_schema", "exact required event fields with optional string decodeStatus", event); const locked = expected.find((row) => row.barcode === event?.cleanCode); if (!event?.eventId) missingEventIdCount += 1; else if (eventIds.has(event.eventId)) duplicateEventIdCount += 1; if (!event?.eventId || eventIds.has(event.eventId)) fail(failures, event?.cleanCode ?? "", "ledger_event_id", "unique non-blank", event?.eventId); eventIds.add(event?.eventId); eventById.set(event?.eventId, event); eventBarcodes.push(event?.cleanCode); if (!event?.matchedProductId) { unmatchedEventCount += 1; fail(failures, event?.cleanCode ?? "", "ledger_matched_product", "non-blank", event?.matchedProductId); } if (!locked || !sameCanonicalProductUid(event?.canonicalProductUid, locked.canonicalProductUid) || norm(event?.status) !== "verified" || event?.quantityDelta !== 1) fail(failures, event?.cleanCode ?? "", "ledger_event_identity", "locked verified +1", event); }
  const canonicalIdentityMismatchCount = events.filter((event) => {
    const locked = expected.find((row) => row.barcode === event?.cleanCode);
    return !locked || !sameCanonicalProductUid(event?.canonicalProductUid, locked.canonicalProductUid);
  }).length;
  const distinctExpectedCanonicalProductUidCount = new Set(expected.map((row) => row.canonicalProductUid).filter(Boolean)).size;
  const distinctMatchedProductIdCount = new Set(events.map((event) => event?.matchedProductId).filter(Boolean)).size;
  const canonicalProductMatchedProductBijection = hasCanonicalProductBijection(
    events.map((event) => ({
      canonicalProductUid: event?.canonicalProductUid,
      matchedProductId: event?.matchedProductId,
    })),
  );
  if (eventBarcodes.sort().join("|") !== lockedBarcodes.join("|")) fail(failures, "", "ledger_event_barcodes", lockedBarcodes, eventBarcodes);
  for (const observation of observations) { const event = eventById.get(observation.eventId); if (!event || event.cleanCode !== observation.barcode || event.matchedProductId !== observation.matchedProductId || !sameCanonicalProductUid(event.canonicalProductUid, observation.canonicalProductUid)) fail(failures, observation.barcode, "observation_ledger_link", "exact event/product/canonical link", event); }
  const countLists = [proof?.finalCounts, proof?.replayedCounts];
  const distinctFinalCountProductIdCount = new Set(
    (Array.isArray(proof?.finalCounts) ? proof.finalCounts : []).map((count) => count.productId).filter(Boolean),
  ).size;
  const distinctReplayedCountProductIdCount = new Set(
    (Array.isArray(proof?.replayedCounts) ? proof.replayedCounts : []).map((count) => count.productId).filter(Boolean),
  ).size;
  if (
    distinctExpectedCanonicalProductUidCount !== expected.length ||
    distinctMatchedProductIdCount !== expected.length ||
    distinctFinalCountProductIdCount !== expected.length ||
    distinctReplayedCountProductIdCount !== expected.length ||
    !canonicalProductMatchedProductBijection
  ) {
    fail(failures, "", "canonical_product_bijection", `${expected.length} one-to-one canonical and matched product IDs`, {
      distinctExpectedCanonicalProductUidCount,
      distinctMatchedProductIdCount,
      distinctFinalCountProductIdCount,
      distinctReplayedCountProductIdCount,
      canonicalProductMatchedProductBijection,
    });
  }
  const memberships = countLists.map((counts) => (Array.isArray(counts) ? counts : []).flatMap((count) => count.scanEventIds ?? []));
  for (const ids of memberships) for (const id of ids) if (!eventById.has(id)) fail(failures, "", "count_event_in_feed", "feed event", id);
  if (new Set(memberships[0]).size !== memberships[0].length || new Set(memberships[1]).size !== memberships[1].length || new Set(memberships[0]).size !== 100 || stable([...new Set(memberships[0])].sort()) !== stable([...new Set(memberships[1])].sort())) fail(failures, "", "count_event_membership", "same 100 unique events", { final: memberships[0].length, replay: memberships[1].length });
  if (stable(proof?.finalCounts) !== stable(proof?.replayedCounts)) fail(failures, "", "final_replay_counts", "identical", "different");
  for (const counts of countLists) for (const count of Array.isArray(counts) ? counts : []) { if (!hasExactKeys(count, ["productId", "quantity", "scanEventIds"]) || typeof count.productId !== "string" || !count.productId || !Number.isSafeInteger(count.quantity) || count.quantity < 1 || !Array.isArray(count.scanEventIds) || !count.scanEventIds.every((id) => typeof id === "string" && id)) fail(failures, "", "count_schema", "exact native count row schema", count); if (count.quantity !== new Set(count.scanEventIds ?? []).size) fail(failures, "", "count_quantity_membership", "quantity equals unique event ids", count); for (const id of count.scanEventIds ?? []) if (eventById.get(id)?.matchedProductId !== count.productId) fail(failures, "", "count_product_membership", count.productId, eventById.get(id)?.matchedProductId); }
  const countedQuantity = (Array.isArray(proof?.finalCounts) ? proof.finalCounts : []).reduce((sum, count) => sum + (typeof count?.quantity === "number" ? count.quantity : 0), 0);
  const replayedQuantity = (Array.isArray(proof?.replayedCounts) ? proof.replayedCounts : []).reduce((sum, count) => sum + (typeof count?.quantity === "number" ? count.quantity : 0), 0);
  if (countedQuantity !== 100 || replayedQuantity !== 100) fail(failures, "", "proof_quantity", 100, { final: countedQuantity, replay: replayedQuantity });
  const expectedBarcodeCounts = new Map(lockedBarcodes.map((barcode) => [barcode, 0]));
  for (const barcode of eventBarcodes) if (expectedBarcodeCounts.has(barcode)) expectedBarcodeCounts.set(barcode, expectedBarcodeCounts.get(barcode) + 1);
  const allExpectedBarcodesSeenExactlyOnce = [...expectedBarcodeCounts.values()].every((count) => count === 1);
  const unexpectedBarcodeCount = eventBarcodes.filter((barcode) => !expectedBarcodeCounts.has(barcode)).length;
  const finalEventIds = memberships[0] ?? [];
  const replayEventIds = memberships[1] ?? [];
  const finalEventIdSet = new Set(finalEventIds);
  const replayEventIdSet = new Set(replayEventIds);
  const sameCountEventIdSets = finalEventIdSet.size === replayEventIdSet.size && [...finalEventIdSet].every((id) => replayEventIdSet.has(id));
  const everyCountEventIdExistsInFeed = [...finalEventIds, ...replayEventIds].every((id) => eventById.has(id));
  const noDrops = allExpectedBarcodesSeenExactlyOnce && unexpectedBarcodeCount === 0;
  const noDuplicates = duplicateEventIdCount === 0 && new Set(finalEventIds).size === finalEventIds.length && new Set(replayEventIds).size === replayEventIds.length;
  const finalEqualsReplay = stable(proof?.finalCounts) === stable(proof?.replayedCounts);
  const expectedAssertions = {
    allExpectedBarcodesSeenExactlyOnce,
    unexpectedBarcodeCount,
    duplicateEventIdCount,
    missingEventIdCount,
    unmatchedEventCount,
    canonicalIdentityMismatchCount,
    distinctExpectedCanonicalProductUidCount,
    distinctMatchedProductIdCount,
    distinctFinalCountProductIdCount,
    distinctReplayedCountProductIdCount,
    canonicalProductMatchedProductBijection,
    finalEqualsReplay,
    countEventIdsEqualReplayEventIds: sameCountEventIdSets,
    everyCountEventIdExistsInFeed,
    expectedQuantity: expected.length,
    finalQuantity: countedQuantity,
    replayedQuantity,
    noDrops,
    noDuplicates,
    passed: allExpectedBarcodesSeenExactlyOnce && unexpectedBarcodeCount === 0 && duplicateEventIdCount === 0 && missingEventIdCount === 0 && unmatchedEventCount === 0 && canonicalIdentityMismatchCount === 0 && distinctExpectedCanonicalProductUidCount === expected.length && distinctMatchedProductIdCount === expected.length && distinctFinalCountProductIdCount === expected.length && distinctReplayedCountProductIdCount === expected.length && canonicalProductMatchedProductBijection && finalEqualsReplay && sameCountEventIdSets && everyCountEventIdExistsInFeed && expected.length === countedQuantity && countedQuantity === replayedQuantity && noDrops && noDuplicates,
  };
  for (const [key, computed] of Object.entries(expectedAssertions)) if (proof?.assertions?.[key] !== computed) fail(failures, "", "ledger_assertion_value", { key, computed }, proof?.assertions?.[key]);
  const latencies = observations.map((row) => row?.latencyMs);
  if (latencies.length !== 100 || latencies.some((value) => !Number.isFinite(value) || value < 0)) fail(failures, "", "latencies", "100 finite nonnegative values", latencies.length);
  return { passed: failures.length === 0, inputCount: observations.length, terminalCount: observations.filter((row) => Boolean(row.status)).length, correctVerified: observations.filter((row) => norm(row.status) === "verified").length - failures.filter((x) => ["canonicalProductUid", "brand", "model", "size", "verified_status"].includes(x.rule)).length, wrongVerified: failures.filter((x) => ["canonicalProductUid", "brand", "model", "size", "verified_status"].includes(x.rule)).length, feedMissing: failures.filter((x) => x.rule === "feed_visible").length, countedQuantity, consoleErrorCount: observations.reduce((sum, row) => sum + (row.consoleErrors?.length || 0), 0), nonLocalRequestCount: observations.reduce((sum, row) => sum + (row.nonLocalRequests?.length || 0), 0) + (result?.serverEgressAttempts?.length || 0), p50Ms: percentile(latencies, 50), p95Ms: percentile(latencies, 95), p99Ms: percentile(latencies, 99), failures };
}
