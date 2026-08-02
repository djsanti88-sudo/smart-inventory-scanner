import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createFileAtomicLocalStorage, createMemoryAtomicLocalStorage } from "./atomicLocalStorage";
import { createLocalAtomicReviewCountedApply } from "./localAtomicReviewCountedApply";
import { createAggregateImportEvent } from "@/services/identity/importLedger";
import { canonicalSha256 } from "@/services/identity/canonical";

describe("createLocalAtomicReviewCountedApply", () => {
  it("commits a review action and its one count event as one durable result", async () => {
    const storage = createMemoryAtomicLocalStorage();
    await storage.transaction(async (tx) => {
      await tx.set("identity-reviews", [{ reviewId: "review-1", businessId: "shop-a", importId: "import-1", rowId: "row-1", scope: { sourceSystem: "demo", sourceSignature: "v1", vendorId: "vendor" }, signedRowContext: { mode: "physical_count", quantity: 3, unitOfMeasure: "each", sourceFileOrdinal: 0, sheetName: "Stock", sourceRowNumber: 2, sessionId: "session-1", eventCreatedAt: "2026-08-02T00:00:00.000Z", identifiers: [] }, decision: { kind: "review", candidates: [], decisionFingerprint: "decision", decisionBasis: [], constraintOutcomes: [] } }]);
      await tx.set("identity-runs", [{ businessId: "shop-a", importId: "import-1", state: "completed" }]);
    });
    const apply = createLocalAtomicReviewCountedApply(storage);
    const event = await createAggregateImportEvent({ businessId: "shop-a", importId: "import-1", rowId: "review-count:review-1", sessionId: "session-1", quantity: 3, sourceFileOrdinal: 0, sheetName: "Stock", sourceRowNumber: 2, createdAt: "2026-08-02T00:00:00.000Z", mode: "physical_count", decision: { kind: "review", approvedProductId: "tire-a" } });
    const operationFingerprint = await canonicalSha256({ reviewId: "review-1", payloadFingerprint: "payload", eventFingerprint: event.fingerprint });

    const first = await apply({
      businessId: "shop-a", reviewId: "review-1", actionId: "same-key", payloadFingerprint: "payload", action: "confirm_candidate", resolution: "confirmed", resolvedBy: "owner", targetProductId: "tire-a", link: { businessId: "shop-a", sourceSystem: "demo", sourceSignature: "v1", vendorId: "vendor", identifierType: "vendor_sku", namespace: "vendor", rawValue: "SKU", normalizedValue: "SKU", targetProductId: "tire-a", status: "approved", evidence: [], createdBy: "owner", createdAt: "2026-08-02T00:00:00.000Z", version: 0 },
      count: { event, operationFingerprint, operationIdempotencyKey: "identity-review-count:review-1", result: { row: { eventId: event.eventId } } },
    });
    expect(first).toMatchObject({ kind: "applied", action: { actionId: "same-key", targetProductId: "tire-a", countResult: { eventId: event.eventId, quantity: 3 } } });

    const replay = await apply({
      businessId: "shop-a", reviewId: "review-1", actionId: "same-key", payloadFingerprint: "payload", action: "confirm_candidate", resolution: "confirmed", resolvedBy: "owner", targetProductId: "tire-a", link: { businessId: "shop-a", sourceSystem: "demo", sourceSignature: "v1", vendorId: "vendor", identifierType: "vendor_sku", namespace: "vendor", rawValue: "SKU", normalizedValue: "SKU", targetProductId: "tire-a", status: "approved", evidence: [], createdBy: "owner", createdAt: "2026-08-02T00:00:00.000Z", version: 0 },
      count: { event: { kind: "aggregate_import", eventId: "different-event", idempotencyKey: "identity-review-count:review-1", fingerprint: "different", businessId: "shop-a", importId: "import-1", rowId: "review-count:review-1", sessionId: "session-1", productId: "tire-a", quantity: 99, unitOfMeasure: "each", sourceFileOrdinal: 0, sheetName: "Stock", sourceRowNumber: 2, createdAt: "2026-08-02T00:00:00.000Z" }, operationFingerprint: "different", operationIdempotencyKey: "identity-review-count:review-1", result: {} },
    });
    expect(replay).toMatchObject({ kind: "replayed", action: { actionId: "same-key", countResult: { eventId: event.eventId, quantity: 3 } } });
    await expect(storage.read!(async (tx) => tx.get<Record<string, { event: { eventId: string } }>>("aggregate-ledger"))).resolves.toMatchObject({ [JSON.stringify(["shop-a", event.idempotencyKey])]: { event: { eventId: event.eventId } } });
  });

  it("rolls every staged record back when projection publication throws", async () => {
    const storage = createMemoryAtomicLocalStorage();
    await storage.transaction(async (tx) => {
      await tx.set("identity-reviews", [{ reviewId: "review-1", businessId: "shop-a", importId: "import-1", rowId: "row-1", scope: { sourceSystem: "demo", sourceSignature: "v1", vendorId: "vendor" }, signedRowContext: { mode: "physical_count", quantity: 1, unitOfMeasure: "each", sourceFileOrdinal: 0, sheetName: "Stock", sourceRowNumber: 2, sessionId: "session", eventCreatedAt: "2026-08-02T00:00:00.000Z", identifiers: [] }, decision: { kind: "review", candidates: [], decisionFingerprint: "decision", decisionBasis: [], constraintOutcomes: [] } }]);
      await tx.set("identity-runs", [{ businessId: "shop-a", importId: "import-1", state: "completed" }]);
    });
    const apply = createLocalAtomicReviewCountedApply(storage, { writeProjection: async () => { throw new Error("projection failed"); } });
    await expect(apply({ businessId: "shop-a", reviewId: "review-1", actionId: "key", payloadFingerprint: "payload", action: "confirm_candidate", resolution: "confirmed", resolvedBy: "owner", targetProductId: "tire-a", link: { businessId: "shop-a", sourceSystem: "demo", sourceSignature: "v1", vendorId: "vendor", identifierType: "vendor_sku", namespace: "vendor", rawValue: "SKU", normalizedValue: "SKU", targetProductId: "tire-a", status: "approved", evidence: [], createdBy: "owner", createdAt: "2026-08-02T00:00:00.000Z", version: 0 }, count: { event: { kind: "aggregate_import", eventId: "event-1", idempotencyKey: "identity-review-count:review-1", fingerprint: "fingerprint", businessId: "shop-a", importId: "import-1", rowId: "review-count:review-1", sessionId: "session", productId: "tire-a", quantity: 1, unitOfMeasure: "each", sourceFileOrdinal: 0, sheetName: "Stock", sourceRowNumber: 2, createdAt: "2026-08-02T00:00:00.000Z" }, operationFingerprint: "operation", operationIdempotencyKey: "identity-review-count:review-1", result: {} } })).rejects.toThrow("projection failed");
    await expect(storage.read!(async (tx) => ({ reviews: await tx.get("identity-reviews"), ledger: await tx.get("aggregate-ledger"), operations: await tx.get("identity-operations") }))).resolves.toMatchObject({ reviews: [expect.not.objectContaining({ resolution: expect.anything() })], ledger: undefined, operations: undefined });
  });

  it("rejects a cross-tenant staged product before mutating the review or ledger", async () => {
    const storage = createMemoryAtomicLocalStorage();
    await storage.transaction(async (tx) => {
      await tx.set("identity-reviews", [{ reviewId: "review-tenant", businessId: "shop-a", importId: "import-1", rowId: "row-1", decision: { kind: "review", candidates: [], decisionFingerprint: "decision", decisionBasis: [], constraintOutcomes: [] } }]);
    });
    const apply = createLocalAtomicReviewCountedApply(storage);

    await expect(apply({ businessId: "shop-a", reviewId: "review-tenant", actionId: "tenant-key", payloadFingerprint: "payload", action: "create_tenant_product", resolution: "create_product", resolvedBy: "owner", targetProductId: "tenant:other", product: { productId: "tenant:other", businessId: "shop-b", name: "Other shop tire", createdBy: "owner", createdAt: "2026-08-02T00:00:00.000Z" } })).resolves.toEqual({ kind: "idempotency_conflict" });
    await expect(storage.read!(async (tx) => ({ reviews: await tx.get("identity-reviews"), products: await tx.get("identity-tenant-products"), ledger: await tx.get("aggregate-ledger") }))).resolves.toMatchObject({ reviews: [expect.not.objectContaining({ resolution: expect.anything() })], products: undefined, ledger: undefined });
  });

  it("reopens an indeterminate file commit and replays the exact stored review result without freshness", async () => {
    const root = path.join(process.cwd(), ".tmp", "identity-import", `atomic-review-${randomUUID()}`);
    const seed = createFileAtomicLocalStorage({ root });
    const review = { reviewId: "review-file", businessId: "shop-a", importId: "import-1", rowId: "row-1", scope: { sourceSystem: "demo", sourceSignature: "v1", vendorId: "vendor" }, signedRowContext: { mode: "physical_count" as const, quantity: 2, unitOfMeasure: "each" as const, sourceFileOrdinal: 0, sheetName: "Stock", sourceRowNumber: 2, sessionId: "session-file", eventCreatedAt: "2026-08-02T00:00:00.000Z", identifiers: [] }, decision: { kind: "review" as const, candidates: [], decisionFingerprint: "decision", decisionBasis: [], constraintOutcomes: [] } };
    await seed.transaction(async (tx) => { await tx.set("identity-reviews", [review]); await tx.set("identity-runs", [{ businessId: "shop-a", importId: "import-1", state: "completed" }]); });
    const event = await createAggregateImportEvent({ businessId: "shop-a", importId: "import-1", rowId: "review-count:review-file", sessionId: "session-file", quantity: 2, sourceFileOrdinal: 0, sheetName: "Stock", sourceRowNumber: 2, createdAt: "2026-08-02T00:00:00.000Z", mode: "physical_count", decision: { kind: "review", approvedProductId: "tire-a" } });
    const input = { businessId: "shop-a", reviewId: review.reviewId, actionId: "file-key", payloadFingerprint: "file-payload", action: "confirm_candidate" as const, resolution: "confirmed" as const, resolvedBy: "owner", targetProductId: "tire-a", link: { businessId: "shop-a", sourceSystem: "demo", sourceSignature: "v1", vendorId: "vendor", identifierType: "vendor_sku" as const, namespace: "vendor", rawValue: "SKU", normalizedValue: "SKU", targetProductId: "tire-a", status: "approved" as const, evidence: [], createdBy: "owner", createdAt: "2026-08-02T00:00:00.000Z", version: 0 }, count: { event, operationFingerprint: await canonicalSha256({ reviewId: review.reviewId, payloadFingerprint: "file-payload", eventFingerprint: event.fingerprint }), operationIdempotencyKey: "identity-review-count:review-file", result: { row: { rowId: "row-1", status: "counted", eventId: event.eventId } } } };
    let syncs = 0;
    const interrupted = createLocalAtomicReviewCountedApply(createFileAtomicLocalStorage({ root, io: { syncDirectory: async () => { syncs += 1; if (syncs === 2) throw new Error("post-swap disk I/O failed"); } } }), { writeProjection: async () => {} });
    await expect(interrupted(input)).rejects.toThrow(/identity_storage_commit_indeterminate/);

    const freshness = vi.fn(async () => true);
    const replay = await createLocalAtomicReviewCountedApply(createFileAtomicLocalStorage({ root }), { writeProjection: async () => {} })({ ...input, revalidate: freshness });
    expect(replay).toMatchObject({ kind: "replayed", action: { actionId: "file-key", countResult: { eventId: event.eventId, quantity: 2, result: input.count.result } } });
    expect(freshness).not.toHaveBeenCalled();
    await expect(createFileAtomicLocalStorage({ root }).read!(async (tx) => tx.get<Record<string, unknown>>("aggregate-ledger"))).resolves.toSatisfy((ledger) => Object.keys(ledger ?? {}).length === 1);
  });

  it("fails closed when a counted replay has no matching durable ledger and operation", async () => {
    const storage = createMemoryAtomicLocalStorage();
    const action = { actionId: "corrupt-key", payloadFingerprint: "payload", action: "confirm_candidate" as const, targetProductId: "tire-a", outcome: "confirmed" as const, resolvedBy: "owner", resolvedAt: "2026-08-02T00:00:00.000Z", countResult: { kind: "applied" as const, eventId: "event-1", quantity: 2, result: { row: { eventId: "event-1" } }, eventFingerprint: "event-fingerprint", operationFingerprint: "operation-fingerprint", eventIdempotencyKey: "event-key", operationIdempotencyKey: "identity-review-count:review-corrupt" } };
    await storage.transaction((tx) => tx.set("identity-reviews", [{ reviewId: "review-corrupt", businessId: "shop-a", importId: "import-1", rowId: "row-1", resolution: "confirmed", reviewAction: action, decision: { kind: "review", candidates: [], decisionFingerprint: "decision", decisionBasis: [], constraintOutcomes: [] } } ]));

    const replay = await createLocalAtomicReviewCountedApply(storage)({ businessId: "shop-a", reviewId: "review-corrupt", actionId: "corrupt-key", payloadFingerprint: "payload", action: "confirm_candidate", resolution: "confirmed", resolvedBy: "owner" });

    expect(replay).toEqual({ kind: "idempotency_conflict" });
  });

  it.each([
    ["event fingerprint", (event: Record<string, unknown>) => ({ ...event, fingerprint: "tampered" })],
    ["event ID", (event: Record<string, unknown>) => ({ ...event, eventId: "tampered" })],
    ["business", (event: Record<string, unknown>) => ({ ...event, businessId: "shop-b" })],
    ["import", (event: Record<string, unknown>) => ({ ...event, importId: "import-other" })],
    ["review-count row", (event: Record<string, unknown>) => ({ ...event, rowId: "review-count:other" })],
    ["target", (event: Record<string, unknown>) => ({ ...event, productId: "tire-b" })],
    ["session", (event: Record<string, unknown>) => ({ ...event, sessionId: "session-other" })],
    ["quantity", (event: Record<string, unknown>) => ({ ...event, quantity: 4 })],
    ["unit of measure", (event: Record<string, unknown>) => ({ ...event, unitOfMeasure: "case" })],
    ["source file ordinal", (event: Record<string, unknown>) => ({ ...event, sourceFileOrdinal: 1 })],
    ["sheet", (event: Record<string, unknown>) => ({ ...event, sheetName: "Other" })],
    ["source row", (event: Record<string, unknown>) => ({ ...event, sourceRowNumber: 3 })],
    ["created at", (event: Record<string, unknown>) => ({ ...event, createdAt: "2026-08-03T00:00:00.000Z" })],
  ])("rejects a replay whose stored aggregate event has a changed %s", async (_name, mutate) => {
    const storage = createMemoryAtomicLocalStorage();
    const context = { mode: "physical_count" as const, quantity: 3, unitOfMeasure: "each" as const, sourceFileOrdinal: 0, sheetName: "Stock", sourceRowNumber: 2, sessionId: "session-1", eventCreatedAt: "2026-08-02T00:00:00.000Z", identifiers: [] };
    await storage.transaction(async (tx) => {
      await tx.set("identity-reviews", [{ reviewId: "review-1", businessId: "shop-a", importId: "import-1", rowId: "row-1", scope: { sourceSystem: "demo", sourceSignature: "v1", vendorId: "vendor" }, signedRowContext: context, decision: { kind: "review", candidates: [], decisionFingerprint: "decision", decisionBasis: [], constraintOutcomes: [] } }]);
      await tx.set("identity-runs", [{ businessId: "shop-a", importId: "import-1", state: "completed" }]);
    });
    const event = await createAggregateImportEvent({ businessId: "shop-a", importId: "import-1", rowId: "review-count:review-1", sessionId: context.sessionId, quantity: context.quantity, sourceFileOrdinal: context.sourceFileOrdinal, sheetName: context.sheetName, sourceRowNumber: context.sourceRowNumber, createdAt: context.eventCreatedAt, mode: "physical_count", decision: { kind: "review", approvedProductId: "tire-a" } });
    const payloadFingerprint = "payload";
    const operationFingerprint = await canonicalSha256({ reviewId: "review-1", payloadFingerprint, eventFingerprint: event.fingerprint });
    const input = { businessId: "shop-a", reviewId: "review-1", actionId: "same-key", payloadFingerprint, action: "confirm_candidate" as const, resolution: "confirmed" as const, resolvedBy: "owner", targetProductId: "tire-a", link: { businessId: "shop-a", sourceSystem: "demo", sourceSignature: "v1", vendorId: "vendor", identifierType: "vendor_sku" as const, namespace: "vendor", rawValue: "SKU", normalizedValue: "SKU", targetProductId: "tire-a", status: "approved" as const, evidence: [], createdBy: "owner", createdAt: "2026-08-02T00:00:00.000Z", version: 0 }, count: { event, operationFingerprint, operationIdempotencyKey: "identity-review-count:review-1", result: { row: { eventId: event.eventId } } } };
    const apply = createLocalAtomicReviewCountedApply(storage);
    await expect(apply(input)).resolves.toMatchObject({ kind: "applied" });
    await storage.transaction(async (tx) => {
      const ledger = await tx.get<Record<string, { event: Record<string, unknown> }>>("aggregate-ledger");
      const key = JSON.stringify(["shop-a", event.idempotencyKey]);
      ledger![key]!.event = mutate(ledger![key]!.event);
      await tx.set("aggregate-ledger", ledger!);
    });
    await expect(apply(input)).resolves.toEqual({ kind: "idempotency_conflict" });
  });

  it("requires count plans exactly for physical confirm/create actions", async () => {
    const context = { mode: "physical_count" as const, quantity: 1, unitOfMeasure: "each" as const, sourceFileOrdinal: 0, sheetName: "Stock", sourceRowNumber: 2, sessionId: "session-1", eventCreatedAt: "2026-08-02T00:00:00.000Z", identifiers: [] };
    const createStorage = async () => {
      const storage = createMemoryAtomicLocalStorage();
      await storage.transaction((tx) => tx.set("identity-reviews", [{ reviewId: "review-1", businessId: "shop-a", importId: "import-1", rowId: "row-1", scope: { sourceSystem: "demo", sourceSignature: "v1", vendorId: "vendor" }, signedRowContext: context, decision: { kind: "review", candidates: [], decisionFingerprint: "decision", decisionBasis: [], constraintOutcomes: [] } }]));
      return storage;
    };
    const event = await createAggregateImportEvent({ businessId: "shop-a", importId: "import-1", rowId: "review-count:review-1", sessionId: context.sessionId, quantity: context.quantity, sourceFileOrdinal: context.sourceFileOrdinal, sheetName: context.sheetName, sourceRowNumber: context.sourceRowNumber, createdAt: context.eventCreatedAt, mode: "physical_count", decision: { kind: "review", approvedProductId: "tire-a" } });
    const count = { event, operationFingerprint: await canonicalSha256({ reviewId: "review-1", payloadFingerprint: "payload", eventFingerprint: event.fingerprint }), operationIdempotencyKey: "identity-review-count:review-1", result: {} };
    const link = { businessId: "shop-a", sourceSystem: "demo", sourceSignature: "v1", vendorId: "vendor", identifierType: "vendor_sku" as const, namespace: "vendor", rawValue: "SKU", normalizedValue: "SKU", targetProductId: "tire-a", status: "approved" as const, evidence: [], createdBy: "owner", createdAt: "2026-08-02T00:00:00.000Z", version: 0 };
    await expect(createLocalAtomicReviewCountedApply(await createStorage())({ businessId: "shop-a", reviewId: "review-1", actionId: "confirm", payloadFingerprint: "payload", action: "confirm_candidate", resolution: "confirmed", resolvedBy: "owner", targetProductId: "tire-a", link })).resolves.toEqual({ kind: "idempotency_conflict" });
    await expect(createLocalAtomicReviewCountedApply(await createStorage())({ businessId: "shop-a", reviewId: "review-1", actionId: "create", payloadFingerprint: "payload", action: "create_tenant_product", resolution: "create_product", resolvedBy: "owner", targetProductId: "tire-a", link, product: { productId: "tire-a", businessId: "shop-a", name: "Tire", createdBy: "owner", createdAt: "2026-08-02T00:00:00.000Z" } })).resolves.toEqual({ kind: "idempotency_conflict" });
    await expect(createLocalAtomicReviewCountedApply(await createStorage())({ businessId: "shop-a", reviewId: "review-1", actionId: "reject", payloadFingerprint: "payload", action: "reject", resolution: "rejected", resolvedBy: "owner", count })).resolves.toEqual({ kind: "idempotency_conflict" });
    await expect(createLocalAtomicReviewCountedApply(await createStorage())({ businessId: "shop-a", reviewId: "review-1", actionId: "revoke", payloadFingerprint: "payload", action: "revoke_link", resolution: "rejected", resolvedBy: "owner", targetProductId: "tire-a", link, count })).resolves.toEqual({ kind: "idempotency_conflict" });
  });

});
