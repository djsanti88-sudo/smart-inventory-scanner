import { describe, expect, it } from "vitest";
import { createMemoryAtomicLocalStorage } from "./atomicLocalStorage";
import { createLocalAtomicReviewCountedApply } from "./localAtomicReviewCountedApply";

describe("createLocalAtomicReviewCountedApply", () => {
  it("commits a review action and its one count event as one durable result", async () => {
    const storage = createMemoryAtomicLocalStorage();
    await storage.transaction(async (tx) => {
      await tx.set("identity-reviews", [{ reviewId: "review-1", businessId: "shop-a", importId: "import-1", rowId: "row-1", decision: { kind: "review", candidates: [], decisionFingerprint: "decision", decisionBasis: [], constraintOutcomes: [] } }]);
      await tx.set("identity-runs", [{ businessId: "shop-a", importId: "import-1", state: "completed" }]);
    });
    const apply = createLocalAtomicReviewCountedApply(storage);

    const first = await apply({
      businessId: "shop-a", reviewId: "review-1", actionId: "same-key", payloadFingerprint: "payload", action: "confirm_candidate", resolution: "confirmed", resolvedBy: "owner", targetProductId: "tire-a",
      count: { event: { kind: "aggregate_import", eventId: "event-1", idempotencyKey: "identity-review-count:review-1", fingerprint: "event-fingerprint", businessId: "shop-a", importId: "import-1", rowId: "review-count:review-1", sessionId: "session-1", productId: "tire-a", quantity: 3, unitOfMeasure: "each", sourceFileOrdinal: 0, sheetName: "Stock", sourceRowNumber: 2, createdAt: "2026-08-02T00:00:00.000Z" }, operationFingerprint: "operation", result: { row: { eventId: "event-1" } } },
    });
    expect(first).toMatchObject({ kind: "applied", action: { actionId: "same-key", targetProductId: "tire-a", countResult: { eventId: "event-1", quantity: 3 } } });

    const replay = await apply({
      businessId: "shop-a", reviewId: "review-1", actionId: "same-key", payloadFingerprint: "payload", action: "confirm_candidate", resolution: "confirmed", resolvedBy: "owner", targetProductId: "tire-a",
      count: { event: { kind: "aggregate_import", eventId: "different-event", idempotencyKey: "identity-review-count:review-1", fingerprint: "different", businessId: "shop-a", importId: "import-1", rowId: "review-count:review-1", sessionId: "session-1", productId: "tire-a", quantity: 99, unitOfMeasure: "each", sourceFileOrdinal: 0, sheetName: "Stock", sourceRowNumber: 2, createdAt: "2026-08-02T00:00:00.000Z" }, operationFingerprint: "different", result: {} },
    });
    expect(replay).toMatchObject({ kind: "replayed", action: { actionId: "same-key", countResult: { eventId: "event-1", quantity: 3 } } });
    await expect(storage.read!(async (tx) => tx.get<Record<string, { event: { eventId: string } }>>("aggregate-ledger"))).resolves.toMatchObject({ '["shop-a","identity-review-count:review-1"]': { event: { eventId: "event-1" } } });
  });

  it("rolls every staged record back when projection publication throws", async () => {
    const storage = createMemoryAtomicLocalStorage();
    await storage.transaction(async (tx) => {
      await tx.set("identity-reviews", [{ reviewId: "review-1", businessId: "shop-a", importId: "import-1", rowId: "row-1", decision: { kind: "review", candidates: [], decisionFingerprint: "decision", decisionBasis: [], constraintOutcomes: [] } }]);
      await tx.set("identity-runs", [{ businessId: "shop-a", importId: "import-1", state: "completed" }]);
    });
    const apply = createLocalAtomicReviewCountedApply(storage, { writeProjection: async () => { throw new Error("projection failed"); } });
    await expect(apply({ businessId: "shop-a", reviewId: "review-1", actionId: "key", payloadFingerprint: "payload", action: "confirm_candidate", resolution: "confirmed", resolvedBy: "owner", targetProductId: "tire-a", count: { event: { kind: "aggregate_import", eventId: "event-1", idempotencyKey: "identity-review-count:review-1", fingerprint: "fingerprint", businessId: "shop-a", importId: "import-1", rowId: "review-count:review-1", sessionId: "session", productId: "tire-a", quantity: 1, unitOfMeasure: "each", sourceFileOrdinal: 0, sheetName: "Stock", sourceRowNumber: 2, createdAt: "2026-08-02T00:00:00.000Z" }, operationFingerprint: "operation", result: {} } })).rejects.toThrow("projection failed");
    await expect(storage.read!(async (tx) => ({ reviews: await tx.get("identity-reviews"), ledger: await tx.get("aggregate-ledger"), operations: await tx.get("identity-operations") }))).resolves.toMatchObject({ reviews: [expect.not.objectContaining({ resolution: expect.anything() })], ledger: undefined, operations: undefined });
  });

});
