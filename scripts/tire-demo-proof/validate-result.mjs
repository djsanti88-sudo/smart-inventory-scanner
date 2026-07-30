import { createHash } from "node:crypto";
function norm(value) { return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase(); }
function hash(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function same(left, right) { return norm(left) === norm(right); }
function percentile(values, percentage) { if (!values.length) return 0; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.ceil((percentage / 100) * sorted.length) - 1]; }
function fail(failures, barcode, rule, expected, observed) { failures.push({ barcode, rule, expected, observed }); }
function stable(value) { return JSON.stringify(value); }

export function validateBatchResult(batch, result, anchor) {
  const failures = [];
  const observations = Array.isArray(result?.observations) ? result.observations : [];
  const expected = Array.isArray(batch?.rows) ? batch.rows : [];
  if (batch?.batchSha256 !== hash(expected) || batch?.expectedBarcodesSha256 !== hash(expected.map((row) => row.barcode)) || batch?.expectedCanonicalProductUidsSha256 !== hash(expected.map((row) => row.canonicalProductUid))) fail(failures, "", "locked_batch_hashes", "generator-compatible SHA-256", "mismatch");
  if (expected.length !== 100) fail(failures, "", "locked_batch_rows", 100, expected.length);
  if (observations.length !== 100) fail(failures, "", "observation_count", 100, observations.length);
  const byBarcode = new Map();
  const observationEventIds = new Set();
  for (const observation of observations) {
    const key = norm(observation.barcode); if (byBarcode.has(key)) fail(failures, observation.barcode, "duplicate_barcode", "unique", observation.barcode); else byBarcode.set(key, observation);
    if (!observation.feedVisible) fail(failures, observation.barcode, "feed_visible", true, observation.feedVisible);
    if (!String(observation.eventId ?? "").trim() || observationEventIds.has(observation.eventId)) fail(failures, observation.barcode, "event_id", "unique non-blank", observation.eventId); observationEventIds.add(observation.eventId);
    if (!String(observation.matchedProductId ?? "").trim()) fail(failures, observation.barcode, "matched_product_id", "non-blank", observation.matchedProductId);
    if (!Array.isArray(observation.consoleErrors) || observation.consoleErrors.length) fail(failures, observation.barcode, "console_errors", [], observation.consoleErrors);
    if (!Array.isArray(observation.nonLocalRequests) || observation.nonLocalRequests.length) fail(failures, observation.barcode, "nonlocal_requests", [], observation.nonLocalRequests);
  }
  for (const row of expected) {
    const observation = byBarcode.get(norm(row.barcode));
    if (!observation) { fail(failures, row.barcode, "missing_barcode", row.barcode, undefined); continue; }
    for (const [key, expectedValue] of [["canonicalProductUid", row.canonicalProductUid], ["brand", row.brand], ["model", row.model], ["size", row.size]]) {
      if (String(expectedValue ?? "").trim() && !same(observation[key], expectedValue)) fail(failures, row.barcode, key, expectedValue, observation[key]);
    }
    if (norm(observation.status) !== "verified") fail(failures, row.barcode, "verified_status", "verified", observation.status);
  }
  for (const [key, observation] of byBarcode) if (!expected.some((row) => norm(row.barcode) === key)) fail(failures, observation.barcode, "extra_barcode", "locked batch barcode", observation.barcode);
  if (!Array.isArray(result?.serverEgressAttempts) || result.serverEgressAttempts.length) fail(failures, "", "server_egress", [], result?.serverEgressAttempts);
  const proof = result?.ledgerProof;
  const assertionKeys = ["allExpectedBarcodesSeenExactlyOnce", "unexpectedBarcodeCount", "duplicateEventIdCount", "missingEventIdCount", "unmatchedEventCount", "finalEqualsReplay", "countEventIdsEqualReplayEventIds", "everyCountEventIdExistsInFeed", "expectedQuantity", "finalQuantity", "replayedQuantity", "noDrops", "noDuplicates", "passed"];
  if (!proof?.assertions || Object.keys(proof.assertions).length !== assertionKeys.length || assertionKeys.some((key) => !Object.hasOwn(proof.assertions, key))) fail(failures, "", "ledger_assertions_schema", assertionKeys, proof?.assertions);
  const manifest = proof?.manifest;
  const manifestKeys = ["schemaVersion", "gitSha", "databaseSha256", "seed", "batch", "batchSha256", "expectedBarcodesSha256", "expectedCanonicalProductUidsSha256"];
  if (!manifest || Object.keys(manifest).length !== manifestKeys.length || manifestKeys.some((key) => manifest?.[key] !== batch?.[key])) fail(failures, "", "manifest_binding", batch, manifest);
  if (anchor && (batch?.batch !== anchor.batch || manifest?.batch !== anchor.batch || batch?.gitSha !== anchor.manifest?.gitSha || batch?.databaseSha256 !== anchor.manifest?.databaseSha256 || batch?.seed !== anchor.manifest?.seed)) fail(failures, "", "run_manifest_anchor", "positionally bound manifest batch", { batch: batch?.batch, ledgerBatch: manifest?.batch, anchor });
  if (typeof proof?.sessionId !== "string" || !proof.sessionId || Number.isNaN(Date.parse(proof?.generatedAt))) fail(failures, "", "ledger_metadata", "sessionId + ISO generatedAt", proof);
  const events = Array.isArray(proof?.events) ? proof.events : [];
  if (proof?.schemaVersion !== 1 || events.length !== 100 || proof?.expected?.rows !== 100 || proof?.assertions?.passed !== true) fail(failures, "", "ledger_shape", "100 passing events", events.length);
  const lockedBarcodes = expected.map((row) => norm(row.barcode)).sort();
  const proofBarcodes = Array.isArray(proof?.expected?.barcodes) ? proof.expected.barcodes.map(norm).sort() : [];
  if (proofBarcodes.join("|") !== lockedBarcodes.join("|")) fail(failures, "", "ledger_expected_barcodes", lockedBarcodes, proofBarcodes);
  const eventIds = new Set(); const eventById = new Map(); let duplicateEventIdCount = 0; let missingEventIdCount = 0; let unmatchedEventCount = 0;
  const eventBarcodes = [];
  const eventKeys = ["eventId", "cleanCode", "matchedProductId", "canonicalProductUid", "quantityDelta", "quantityAfterScan", "status"];
  for (const event of events) { const keys = event && typeof event === "object" ? Object.keys(event) : []; const eventSchemaValid = Boolean(event) && typeof event.eventId === "string" && typeof event.cleanCode === "string" && typeof event.matchedProductId === "string" && typeof event.canonicalProductUid === "string" && typeof event.quantityDelta === "number" && Number.isFinite(event.quantityAfterScan) && typeof event.status === "string" && (!Object.hasOwn(event, "decodeStatus") || typeof event.decodeStatus === "string") && keys.every((key) => eventKeys.includes(key) || key === "decodeStatus") && eventKeys.every((key) => Object.hasOwn(event, key)); if (!eventSchemaValid) fail(failures, event?.cleanCode ?? "", "ledger_event_schema", "exact required event fields with optional string decodeStatus", event); const locked = expected.find((row) => same(row.barcode, event?.cleanCode)); if (!event?.eventId) missingEventIdCount += 1; else if (eventIds.has(event.eventId)) duplicateEventIdCount += 1; if (!event?.eventId || eventIds.has(event.eventId)) fail(failures, event?.cleanCode ?? "", "ledger_event_id", "unique non-blank", event?.eventId); eventIds.add(event?.eventId); eventById.set(event?.eventId, event); eventBarcodes.push(norm(event?.cleanCode)); if (!event?.matchedProductId) { unmatchedEventCount += 1; fail(failures, event?.cleanCode ?? "", "ledger_matched_product", "non-blank", event?.matchedProductId); } if (!locked || !same(event?.canonicalProductUid, locked.canonicalProductUid) || norm(event?.status) !== "verified" || event?.quantityDelta !== 1) fail(failures, event?.cleanCode ?? "", "ledger_event_identity", "locked verified +1", event); }
  if (eventBarcodes.sort().join("|") !== lockedBarcodes.join("|")) fail(failures, "", "ledger_event_barcodes", lockedBarcodes, eventBarcodes);
  for (const observation of observations) { const event = eventById.get(observation.eventId); if (!event || !same(event.cleanCode, observation.barcode) || !same(event.matchedProductId, observation.matchedProductId) || !same(event.canonicalProductUid, observation.canonicalProductUid)) fail(failures, observation.barcode, "observation_ledger_link", "exact event/product/canonical link", event); }
  const countLists = [proof?.finalCounts, proof?.replayedCounts];
  const memberships = countLists.map((counts) => (Array.isArray(counts) ? counts : []).flatMap((count) => count.scanEventIds ?? []));
  for (const ids of memberships) for (const id of ids) if (!eventById.has(id)) fail(failures, "", "count_event_in_feed", "feed event", id);
  if (new Set(memberships[0]).size !== memberships[0].length || new Set(memberships[1]).size !== memberships[1].length || new Set(memberships[0]).size !== 100 || !same([...new Set(memberships[0])].sort().join("|"), [...new Set(memberships[1])].sort().join("|"))) fail(failures, "", "count_event_membership", "same 100 unique events", { final: memberships[0].length, replay: memberships[1].length });
  if (stable(proof?.finalCounts) !== stable(proof?.replayedCounts)) fail(failures, "", "final_replay_counts", "identical", "different");
  for (const counts of countLists) for (const count of Array.isArray(counts) ? counts : []) { if (Number(count.quantity) !== new Set(count.scanEventIds ?? []).size) fail(failures, "", "count_quantity_membership", "quantity equals unique event ids", count); for (const id of count.scanEventIds ?? []) if (eventById.get(id)?.matchedProductId !== count.productId) fail(failures, "", "count_product_membership", count.productId, eventById.get(id)?.matchedProductId); }
  const countedQuantity = (Array.isArray(proof?.finalCounts) ? proof.finalCounts : []).reduce((sum, count) => sum + Number(count.quantity || 0), 0);
  const replayedQuantity = (Array.isArray(proof?.replayedCounts) ? proof.replayedCounts : []).reduce((sum, count) => sum + Number(count.quantity || 0), 0);
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
    finalEqualsReplay,
    countEventIdsEqualReplayEventIds: sameCountEventIdSets,
    everyCountEventIdExistsInFeed,
    expectedQuantity: expected.length,
    finalQuantity: countedQuantity,
    replayedQuantity,
    noDrops,
    noDuplicates,
    passed: allExpectedBarcodesSeenExactlyOnce && unexpectedBarcodeCount === 0 && duplicateEventIdCount === 0 && missingEventIdCount === 0 && unmatchedEventCount === 0 && finalEqualsReplay && sameCountEventIdSets && everyCountEventIdExistsInFeed && expected.length === countedQuantity && countedQuantity === replayedQuantity && noDrops && noDuplicates,
  };
  for (const [key, computed] of Object.entries(expectedAssertions)) if (proof?.assertions?.[key] !== computed) fail(failures, "", "ledger_assertion_value", { key, computed }, proof?.assertions?.[key]);
  const latencies = observations.map((row) => Number(row.latencyMs));
  if (latencies.length !== 100 || latencies.some((value) => !Number.isFinite(value) || value < 0)) fail(failures, "", "latencies", "100 finite nonnegative values", latencies.length);
  return { passed: failures.length === 0, inputCount: observations.length, terminalCount: observations.filter((row) => Boolean(row.status)).length, correctVerified: observations.filter((row) => norm(row.status) === "verified").length - failures.filter((x) => ["canonicalProductUid", "brand", "model", "size", "verified_status"].includes(x.rule)).length, wrongVerified: failures.filter((x) => ["canonicalProductUid", "brand", "model", "size", "verified_status"].includes(x.rule)).length, feedMissing: failures.filter((x) => x.rule === "feed_visible").length, countedQuantity, consoleErrorCount: observations.reduce((sum, row) => sum + (row.consoleErrors?.length || 0), 0), nonLocalRequestCount: observations.reduce((sum, row) => sum + (row.nonLocalRequests?.length || 0), 0) + (result?.serverEgressAttempts?.length || 0), p50Ms: percentile(latencies, 50), p95Ms: percentile(latencies, 95), p99Ms: percentile(latencies, 99), failures };
}
