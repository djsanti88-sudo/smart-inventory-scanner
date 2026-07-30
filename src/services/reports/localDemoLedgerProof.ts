import type { InventoryCount, ScanEvent } from "@/types";
import { replayLedgerCounts } from "@/services/inventory.replay";

export type LocalDemoLockedBatchRow = {
  barcode: string;
  canonicalProductUid: string;
};

export type LocalDemoLockedBatch = {
  schemaVersion: 1;
  gitSha: string;
  databaseSha256: string;
  manifestSha256: string;
  seed: string;
  batch: number;
  batchSha256: string;
  expectedBarcodesSha256: string;
  expectedCanonicalProductUidsSha256: string;
  rows: LocalDemoLockedBatchRow[];
};

export type LocalDemoLedgerProof = {
  schemaVersion: 1;
  manifest: Omit<LocalDemoLockedBatch, "rows">;
  sessionId: string;
  generatedAt: string;
  expected: { rows: number; barcodes: string[] };
  events: Array<{
    eventId: string;
    cleanCode: string;
    matchedProductId: string | null;
    canonicalProductUid: string | null;
    quantityDelta: number;
    quantityAfterScan: number;
    status: string;
    decodeStatus?: string;
  }>;
  finalCounts: Array<{ productId: string; quantity: number; scanEventIds: string[] }>;
  replayedCounts: Array<{ productId: string; quantity: number; scanEventIds: string[] }>;
  assertions: {
    allExpectedBarcodesSeenExactlyOnce: boolean;
    unexpectedBarcodeCount: number;
    duplicateEventIdCount: number;
    missingEventIdCount: number;
    unmatchedEventCount: number;
    canonicalIdentityMismatchCount: number;
    finalEqualsReplay: boolean;
    countEventIdsEqualReplayEventIds: boolean;
    everyCountEventIdExistsInFeed: boolean;
    expectedQuantity: 100;
    finalQuantity: number;
    replayedQuantity: number;
    noDrops: boolean;
    noDuplicates: boolean;
    passed: boolean;
  };
};

export type LocalDemoLedgerProofInput = {
  batch: LocalDemoLockedBatch;
  sessionId: string;
  scanFeed: ScanEvent[];
  finalCounts: InventoryCount[];
  generatedAt: string;
};

type CountShape = { productId: string; quantity: number; scanEventIds: string[] };

function compareText(left: string, right: string): number {
  return left.localeCompare(right, "en", { numeric: true });
}

function stableCounts(counts: InventoryCount[]): CountShape[] {
  return counts
    .map((count) => ({
      productId: count.productId,
      quantity: count.quantity,
      scanEventIds: [...count.scanEventIds].sort(compareText),
    }))
    .sort((left, right) => compareText(left.productId, right.productId));
}

function countMembershipEqual(left: CountShape[], right: CountShape[], includeQuantity: boolean): boolean {
  if (left.length !== right.length) return false;
  return left.every((count, index) => {
    const other = right[index];
    return count.productId === other.productId &&
      (!includeQuantity || count.quantity === other.quantity) &&
      count.scanEventIds.length === other.scanEventIds.length &&
      count.scanEventIds.every((eventId, eventIndex) => eventId === other.scanEventIds[eventIndex]);
  });
}

function sumQuantity(counts: CountShape[]): number {
  return counts.reduce((total, count) => total + count.quantity, 0);
}

function duplicateCount(values: string[]): number {
  return values.length - new Set(values).size;
}

/**
 * Builds an audit artifact from in-memory store facts only. The batch is already verified by the
 * caller; this function deliberately does not fetch, mutate state, or infer corpus identity from
 * app-local product IDs.
 */
export function buildLocalDemoLedgerProof(input: LocalDemoLedgerProofInput): LocalDemoLedgerProof {
  const expectedRows = input.batch.rows;
  const expectedBarcodes = expectedRows.map((row) => row.barcode);
  const expectedCounts = new Map<string, number>();
  const lockedCanonicalUidByBarcode = new Map<string, string>();
  const duplicateManifestBarcode = new Set<string>();
  for (const row of expectedRows) {
    expectedCounts.set(row.barcode, (expectedCounts.get(row.barcode) ?? 0) + 1);
    if (lockedCanonicalUidByBarcode.has(row.barcode)) duplicateManifestBarcode.add(row.barcode);
    else lockedCanonicalUidByBarcode.set(row.barcode, row.canonicalProductUid);
  }

  const sessionEvents = input.scanFeed
    .filter((event) => event.sessionId === input.sessionId)
    .slice()
    .sort((left, right) => compareText(left.id, right.id));
  const observedCounts = new Map<string, number>();
  for (const event of sessionEvents) {
    observedCounts.set(event.cleanCode, (observedCounts.get(event.cleanCode) ?? 0) + 1);
  }

  const events = sessionEvents.map((event) => ({
    eventId: event.id,
    cleanCode: event.cleanCode,
    matchedProductId: event.matchedProductId,
    canonicalProductUid: event.localDemoCanonicalProductUid ?? null,
    quantityDelta: event.quantityDelta,
    quantityAfterScan: event.quantityAfterScan,
    // The batch validator's ledger contract is terminal verification, while ScanEvent.status
    // remains the resolver state (usually "known") after app evidence verification.
    status: event.decodeStatus ?? event.status,
    ...(event.decodeStatus ? { decodeStatus: event.decodeStatus } : {}),
  }));
  const unexpectedBarcodeCount = sessionEvents.filter((event) => !expectedCounts.has(event.cleanCode)).length;
  const allExpectedBarcodesSeenExactlyOnce = expectedRows.length === 100 &&
    duplicateManifestBarcode.size === 0 &&
    expectedCounts.size === 100 &&
    expectedBarcodes.every((barcode) => observedCounts.get(barcode) === 1) &&
    unexpectedBarcodeCount === 0;
  const eventIds = sessionEvents.map((event) => event.id);
  const missingEventIdCount = eventIds.filter((eventId) => !eventId).length;
  const duplicateEventIdCount = duplicateCount(eventIds.filter(Boolean));
  const unmatchedEventCount = sessionEvents.filter((event) => !event.matchedProductId).length;
  const canonicalIdentityMismatchCount = sessionEvents.filter((event) => {
    const lockedCanonicalUid = lockedCanonicalUidByBarcode.get(event.cleanCode);
    return duplicateManifestBarcode.has(event.cleanCode) ||
      !lockedCanonicalUid ||
      event.localDemoCanonicalProductUid !== lockedCanonicalUid;
  }).length;
  const everyEventIsOneFiniteScan = sessionEvents.every((event) =>
    event.quantityDelta === 1 && Number.isFinite(event.quantityAfterScan),
  );

  const finalCounts = stableCounts(input.finalCounts.filter((count) => count.sessionId === input.sessionId));
  const replayedCounts = stableCounts(replayLedgerCounts(sessionEvents, input.sessionId));
  const finalQuantity = sumQuantity(finalCounts);
  const replayedQuantity = sumQuantity(replayedCounts);
  const finalEqualsReplay = countMembershipEqual(finalCounts, replayedCounts, true);
  const countEventIdsEqualReplayEventIds = countMembershipEqual(finalCounts, replayedCounts, false);
  const feedEventIds = new Set(eventIds.filter(Boolean));
  const countReferences = [...finalCounts, ...replayedCounts].flatMap((count) => count.scanEventIds);
  const everyCountEventIdExistsInFeed = countReferences.every((eventId) => feedEventIds.has(eventId));
  const noDrops = everyEventIsOneFiniteScan && allExpectedBarcodesSeenExactlyOnce && finalQuantity === 100 && replayedQuantity === 100;
  const noDuplicates = duplicateEventIdCount === 0 && missingEventIdCount === 0 &&
    everyEventIsOneFiniteScan && sessionEvents.length === 100 && finalQuantity === 100 && replayedQuantity === 100;
  const passed = allExpectedBarcodesSeenExactlyOnce && unexpectedBarcodeCount === 0 &&
    duplicateEventIdCount === 0 && missingEventIdCount === 0 && unmatchedEventCount === 0 &&
    canonicalIdentityMismatchCount === 0 &&
    finalEqualsReplay && countEventIdsEqualReplayEventIds && everyCountEventIdExistsInFeed &&
    everyEventIsOneFiniteScan && noDrops && noDuplicates;

  return {
    schemaVersion: 1,
    manifest: {
      schemaVersion: input.batch.schemaVersion,
      gitSha: input.batch.gitSha,
      databaseSha256: input.batch.databaseSha256,
      manifestSha256: input.batch.manifestSha256,
      seed: input.batch.seed,
      batch: input.batch.batch,
      batchSha256: input.batch.batchSha256,
      expectedBarcodesSha256: input.batch.expectedBarcodesSha256,
      expectedCanonicalProductUidsSha256: input.batch.expectedCanonicalProductUidsSha256,
    },
    sessionId: input.sessionId,
    generatedAt: input.generatedAt,
    expected: { rows: expectedRows.length, barcodes: [...expectedBarcodes].sort(compareText) },
    events,
    finalCounts,
    replayedCounts,
    assertions: {
      allExpectedBarcodesSeenExactlyOnce,
      unexpectedBarcodeCount,
      duplicateEventIdCount,
      missingEventIdCount,
      unmatchedEventCount,
      canonicalIdentityMismatchCount,
      finalEqualsReplay,
      countEventIdsEqualReplayEventIds,
      everyCountEventIdExistsInFeed,
      expectedQuantity: 100,
      finalQuantity,
      replayedQuantity,
      noDrops,
      noDuplicates,
      passed,
    },
  };
}
