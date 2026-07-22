import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

// Task 1b (2026-07-22 follow-up to Task 1's SAVE_PRODUCT idempotency-key fix): resolveUnknown's
// create_new / orphan-merge path reuses the provisional placeholder's product id (`provOrphanId`,
// minted synchronously by ensureProvisionalCount at scan time - see scanStore.ts ~3667) and enqueues a
// SECOND, logically-distinct SAVE_PRODUCT for that SAME id. Both this write and the provisional's
// earlier write build the bare key `businessId:sessionId:<id>:SAVE_PRODUCT`
// (buildIdempotencyKey(state.businessId, state.sessionId, productId, "SAVE_PRODUCT")) with no
// distinguishing suffix, so MockDb/FirebaseSyncTarget's dedupe-by-key treats the resolved identity's
// write as "alreadyApplied" and silently drops it - only the original "Unidentified item" placeholder
// data ever reaches the backend, even though the local store correctly shows the resolved name.
//
// Fix (matching Task 1's recipe exactly, commit 024c849): fold a content fingerprint into the key at
// each of the two enqueue sites (ensureProvisionalCount ~3748, resolveUnknown's orphan-merge ~4791) so
// distinct writes to the same product id mint distinct keys, while a genuine retry (the drain loop
// replaying the SAME queued PendingSyncItem object) keeps the SAME key and stays a safe no-op.

const CODE = "111222333444";

describe("resolveUnknown orphan-merge sync (Task 1b: resolved identity must not be swallowed by the provisional's key)", () => {
  it("the RESOLVED product identity reaches MockDb, not just the provisional placeholder (fails before the fix)", async () => {
    const db = new MockDb();
    const store = createTestScanStore({ db });

    // Unknown scan -> ensureProvisionalCount mints+enqueues a provisional "Unidentified item" product
    // AND counts it synchronously (TOP-LEVEL LAW: scan appears + counts before any resolution).
    store.getState().processScan(CODE);
    await store.getState().syncPending();

    const review = store.getState().needsReviewQueue.at(-1)!;
    expect(review.status).toBe("open");
    const provisionalId = review.provisionalProductId!;
    expect(provisionalId, "provisional placeholder was minted and stamped on the review").toBeTruthy();

    const afterProvisional = db.snapshot().products[provisionalId];
    expect(afterProvisional?.name, "provisional placeholder reached MockDb first").toContain("Unidentified");

    // Human resolves: create_new with a real name. Because a provisional already exists for this code
    // (provOrphanId), resolveUnknown takes the orphan-merge path and REUSES provisionalId as productId.
    store.getState().resolveUnknown(review.id, "create_new", {
      applyToCount: true,
      origin: "human",
      newProduct: { name: "Michelin Defender T+H 225/65R17", brand: "Michelin" },
    });

    const resolvedLocal = store.getState().products.find((p) => p.id === provisionalId);
    expect(resolvedLocal?.id, "local store reuses the SAME product id (orphan-merge, not a fresh mint)").toBe(
      provisionalId,
    );
    expect(resolvedLocal?.name).toBe("Michelin Defender T+H 225/65R17");

    await store.getState().syncPending();

    const afterResolve = db.snapshot().products[provisionalId];
    expect(
      afterResolve?.name,
      "the RESOLVED name must reach MockDb - not stay stuck on the provisional placeholder's name",
    ).toBe("Michelin Defender T+H 225/65R17");

    // The local store must agree with what "synced" means: no pending SAVE_PRODUCT for this id.
    const stillPending = store
      .getState()
      .pendingSyncQueue.some((it) => it.operation === "SAVE_PRODUCT" && it.entityId === provisionalId);
    expect(stillPending, "no leftover pending SAVE_PRODUCT after both writes synced").toBe(false);
  });

  it("a genuine retry of the identical queued orphan-merge SAVE_PRODUCT item still no-ops (idempotency preserved)", async () => {
    const db = new MockDb();
    const store = createTestScanStore({ db });

    store.getState().setSimulateSyncFailure(true);
    store.getState().processScan(CODE);
    const review = store.getState().needsReviewQueue.at(-1)!;
    store.getState().resolveUnknown(review.id, "create_new", {
      applyToCount: true,
      origin: "human",
      newProduct: { name: "Michelin Defender T+H 225/65R17", brand: "Michelin" },
    });
    const provisionalId = review.provisionalProductId!;
    const queuedItem = store
      .getState()
      .pendingSyncQueue.find((it) => it.operation === "SAVE_PRODUCT" && it.entityId === provisionalId)!;
    expect(queuedItem, "the orphan-merge SAVE_PRODUCT item was enqueued").toBeDefined();

    store.getState().setSimulateSyncFailure(false);
    db.setFailure("none");

    const first = db.apply(queuedItem);
    expect(first.ok).toBe(true);

    const retry = db.apply(queuedItem);
    expect(retry.alreadyApplied, "retry of the identical queued item is a safe no-op").toBe(true);
  });
});
