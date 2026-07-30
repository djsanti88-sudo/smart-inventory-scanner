import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { InventoryCount, ScanEvent } from "@/types";
import { buildLocalDemoLedgerProof } from "./localDemoLedgerProof";
import { validateBatchResult } from "../../../scripts/tire-demo-proof/validate-result.mjs";

const SESSION = "local-proof-session";

function batch() {
  const rows = Array.from({ length: 100 }, (_, index) => ({
    barcode: `code-${index + 1}`,
    canonicalProductUid: `canonical-${index + 1}`,
  }));
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return {
    schemaVersion: 1 as const,
    gitSha: "a".repeat(40),
    databaseSha256: "b".repeat(64),
    manifestSha256: "c".repeat(64),
    seed: "scanbin-local-tire-demo-v1",
    batch: 1,
    batchSha256: digest(rows),
    expectedBarcodesSha256: digest(rows.map((row) => row.barcode)),
    expectedCanonicalProductUidsSha256: digest(rows.map((row) => row.canonicalProductUid)),
    rows,
  };
}

function event(index: number, patch: Partial<ScanEvent> = {}): ScanEvent {
  return {
    id: `event-${index + 1}`,
    businessId: "local-demo",
    sessionId: SESSION,
    rawCode: `code-${index + 1}`,
    cleanCode: `code-${index + 1}`,
    normalizedCandidates: [],
    matchedProductId: `product-${index + 1}`,
    matchType: "unknown",
    status: "known",
    resolverStatus: "known",
    codeType: "upc_a",
    reason: "Local tire corpus",
    decodeStatus: "verified",
    quantityDelta: 1,
    quantityAfterScan: 1,
    createdAt: `2026-07-29T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
    source: "scan",
    notes: "",
    syncStatus: "synced",
    syncError: null,
    idempotencyKey: `key-${index + 1}`,
    localDemoCanonicalProductUid: `canonical-${index + 1}`,
    ...patch,
  };
}

function count(index: number, eventId = `event-${index + 1}`): InventoryCount {
  return {
    id: `count-${index + 1}`,
    businessId: "local-demo",
    sessionId: SESSION,
    productId: `product-${index + 1}`,
    quantity: 1,
    lastScannedAt: "2026-07-29T00:00:00.000Z",
    aliasesSeen: [],
    scanEventIds: [eventId],
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
    syncStatus: "synced",
    syncError: null,
    appliedIdempotencyKeys: [],
  };
}

function validInput() {
  const scanFeed = Array.from({ length: 100 }, (_, index) => event(index));
  return {
    batch: batch(),
    sessionId: SESSION,
    scanFeed,
    finalCounts: Array.from({ length: 100 }, (_, index) => count(index)),
    generatedAt: "2026-07-29T12:00:00.000Z",
  };
}

describe("buildLocalDemoLedgerProof", () => {
  it("rebuilds a stable, passing 100-event proof from direct event canonical IDs", () => {
    const input = validInput();
    const proof = buildLocalDemoLedgerProof({ ...input, scanFeed: [...input.scanFeed].reverse() });

    expect(proof.assertions.passed).toBe(true);
    expect(proof.assertions).toMatchObject({
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
    });
    expect(proof.events[0]).toMatchObject({ eventId: "event-1", canonicalProductUid: "canonical-1" });
    expect(proof.manifest.manifestSha256).toBe(input.batch.manifestSha256);
    expect(proof.events[0]?.status).toBe("verified");
    expect(proof.events.map((row) => row.eventId)).toEqual(Array.from({ length: 100 }, (_, index) => `event-${index + 1}`));

    const validation = validateBatchResult(input.batch, {
      observations: input.batch.rows.map((row, index) => ({
        barcode: row.barcode,
        canonicalProductUid: row.canonicalProductUid,
        eventId: `event-${index + 1}`,
        matchedProductId: `product-${index + 1}`,
        feedVisible: true,
        status: "verified",
        latencyMs: index,
        consoleErrors: [],
        nonLocalRequests: [],
      })),
      serverEgressAttempts: [],
      ledgerProof: proof,
    });
    expect(validation.passed).toBe(true);
  });

  it("fails closed when an event canonical UID is missing or differs from its locked barcode UID", () => {
    const input = validInput();
    const missingUid = input.scanFeed.map((row, index) =>
      index === 0 ? { ...row, localDemoCanonicalProductUid: undefined } : row,
    );
    const wrongUid = input.scanFeed.map((row, index) =>
      index === 0 ? { ...row, localDemoCanonicalProductUid: "canonical-2" } : row,
    );

    for (const scanFeed of [missingUid, wrongUid]) {
      const proof = buildLocalDemoLedgerProof({ ...input, scanFeed });
      expect(proof.assertions.canonicalIdentityMismatchCount).toBe(1);
      expect(proof.assertions.passed).toBe(false);
    }
    expect(buildLocalDemoLedgerProof({ ...input, scanFeed: wrongUid }).events[0]?.canonicalProductUid).toBe("canonical-2");
  });

  it("fails when two distinct canonical products collapse onto one matched product and count row", () => {
    const input = validInput();
    const scanFeed = input.scanFeed.map((row, index) =>
      index === 1
        ? { ...row, matchedProductId: "product-1", quantityAfterScan: 2 }
        : row,
    );
    const finalCounts = input.finalCounts
      .filter((_, index) => index !== 1)
      .map((row, index) =>
        index === 0
          ? { ...row, quantity: 2, scanEventIds: ["event-1", "event-2"] }
          : row,
      );

    const proof = buildLocalDemoLedgerProof({ ...input, scanFeed, finalCounts });

    expect(proof.assertions.finalEqualsReplay).toBe(true);
    expect(proof.assertions.finalQuantity).toBe(100);
    expect(proof.assertions.canonicalProductMatchedProductBijection).toBe(false);
    expect(proof.assertions.distinctMatchedProductIdCount).toBe(99);
    expect(proof.assertions.distinctFinalCountProductIdCount).toBe(99);
    expect(proof.assertions.passed).toBe(false);
  });

  it("fails when one canonical product fans out to multiple matched products", () => {
    const input = validInput();
    input.batch.rows[1] = {
      ...input.batch.rows[1],
      canonicalProductUid: input.batch.rows[0].canonicalProductUid,
    };
    const scanFeed = input.scanFeed.map((row, index) =>
      index === 1
        ? { ...row, localDemoCanonicalProductUid: "canonical-1" }
        : row,
    );

    const proof = buildLocalDemoLedgerProof({ ...input, scanFeed });

    expect(proof.assertions.canonicalIdentityMismatchCount).toBe(0);
    expect(proof.assertions.canonicalProductMatchedProductBijection).toBe(false);
    expect(proof.assertions.passed).toBe(false);
  });

  it("fails closed for missing, extra, duplicate, unmatched, and malformed event facts", () => {
    const input = validInput();
    const corrupted = [
      input.scanFeed.slice(1),
      [...input.scanFeed, event(101, { cleanCode: "extra-code" })],
      [...input.scanFeed.slice(0, 99), event(99, { id: "event-99" })],
      [...input.scanFeed.slice(0, 99), event(99, { matchedProductId: null })],
      [...input.scanFeed.slice(0, 99), event(99, { id: "" })],
    ];
    for (const scanFeed of corrupted) {
      expect(buildLocalDemoLedgerProof({ ...input, scanFeed }).assertions.passed).toBe(false);
    }
  });

  it("fails closed for final/replay disagreements and count references absent from the feed", () => {
    const input = validInput();
    const alteredQuantity = input.finalCounts.map((row, index) => index === 0 ? { ...row, quantity: 2 } : row);
    const missingReference = input.finalCounts.map((row, index) => index === 0 ? { ...row, scanEventIds: ["not-in-feed"] } : row);

    const quantityProof = buildLocalDemoLedgerProof({ ...input, finalCounts: alteredQuantity });
    expect(quantityProof.assertions.finalEqualsReplay).toBe(false);
    expect(quantityProof.assertions.passed).toBe(false);

    const referenceProof = buildLocalDemoLedgerProof({ ...input, finalCounts: missingReference });
    expect(referenceProof.assertions.everyCountEventIdExistsInFeed).toBe(false);
    expect(referenceProof.assertions.passed).toBe(false);
  });

  it("fails closed for offsetting plus-two/zero scan facts even when totals appear correct", () => {
    const input = validInput();
    const scanFeed = input.scanFeed.map((row, index) => {
      if (index === 0) return { ...row, quantityDelta: 2, quantityAfterScan: 2 };
      if (index === 1) return { ...row, quantityDelta: 0, quantityAfterScan: 0 };
      return row;
    });
    const proof = buildLocalDemoLedgerProof({ ...input, scanFeed });
    expect(proof.assertions.noDrops).toBe(false);
    expect(proof.assertions.noDuplicates).toBe(false);
    expect(proof.assertions.passed).toBe(false);
  });
});
