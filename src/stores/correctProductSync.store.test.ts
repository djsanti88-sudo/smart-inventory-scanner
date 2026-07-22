import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

// Task 1 (2026-07-22 sync-truth plan): a second correctProduct edit to the SAME product in the SAME
// session previously minted an idempotency key identical to the first edit's
// (businessId:sessionId:productId:SAVE_PRODUCT), so MockDb/FirebaseSyncTarget's dedupe-by-key treated
// edit #2 as "alreadyApplied" and silently dropped it - the drain loop marks that "ok" and removes the
// queue item, so the second edit never reaches the backend even though the local store shows it.
//
// Fix requirement: distinct edits (different payload content) must produce distinct idempotency keys so
// each one actually syncs, while a genuine RETRY of the exact same queued item (same id, same content,
// e.g. after a transient sync failure) must keep the SAME key so it stays a safe no-op on replay.

// Uses the seed product "prod-nokian" directly (present in every fresh store's local `products` from
// getSeed()) rather than a scan-created provisional, to isolate the correctProduct key-collision bug
// from the store's OTHER pre-existing SAVE_PRODUCT idempotency-key call sites (out of this task's
// strict scope - see the implementer report for the sibling collision found at resolveUnknown's
// create_new upgrade path, scanStore.ts ~4781, which reuses the provisional product's id and therefore
// also collides with ensureProvisionalCount's own SAVE_PRODUCT key for that same id).
describe("correctProduct sync (Task 1: second edit must not be swallowed by key collision)", () => {
  it("two sequential edits to the same product BOTH land in MockDb (fails before the fix: edit #2 dropped)", async () => {
    const db = new MockDb();
    const store = createTestScanStore({ db });
    const productId = "prod-nokian";
    expect(store.getState().products.find((p) => p.id === productId), "seed product exists locally").toBeDefined();

    // First edit.
    store.getState().correctProduct(productId, { name: "Edited Once" });
    await store.getState().syncPending();
    const afterFirst = db.snapshot().products[productId];
    expect(afterFirst?.name, "first edit reached MockDb").toBe("Edited Once");

    // Second, DIFFERENT edit to the same product in the same session.
    store.getState().correctProduct(productId, { name: "Edited Twice" });
    await store.getState().syncPending();
    const afterSecond = db.snapshot().products[productId];
    expect(afterSecond?.name, "second edit must also reach MockDb, not be swallowed as alreadyApplied").toBe(
      "Edited Twice",
    );

    // The local store must agree with what "synced" means: no pending queue item left for this product.
    const stillPending = store
      .getState()
      .pendingSyncQueue.some((it) => it.operation === "SAVE_PRODUCT" && it.entityId === productId);
    expect(stillPending, "no leftover pending SAVE_PRODUCT item after both edits synced").toBe(false);
  });

  it("a genuine retry of the SAME queued edit (identical item, no new edit) still no-ops - no duplicate work, idempotency preserved", async () => {
    const db = new MockDb();
    const store = createTestScanStore({ db });
    const productId = "prod-falken";

    // Capture the queued item BEFORE the mock backend's synchronous auto-drain consumes it, by
    // simulating a transient failure so it stays in the queue for us to replay by hand. Must go through
    // the store's own setSimulateSyncFailure - syncPending() re-derives db's failure mode from that flag
    // on every call, so setting db.setFailure() directly would be overwritten.
    store.getState().setSimulateSyncFailure(true);
    store.getState().correctProduct(productId, { name: "Retry Edited" });
    const queuedItem = store
      .getState()
      .pendingSyncQueue.find((it) => it.operation === "SAVE_PRODUCT" && it.entityId === productId)!;
    expect(queuedItem, "edit was enqueued").toBeDefined();
    store.getState().setSimulateSyncFailure(false);
    db.setFailure("none"); // the store only re-derives db's failure mode on its NEXT syncPending() call

    // First apply (simulating the drain's retry now that the network is back).
    const first = db.apply(queuedItem);
    expect(first.ok, "first real apply succeeds").toBe(true);
    expect(first.alreadyApplied).toBe(false);

    // Retry: SAME item object/key (as the real retry path does - never regenerated), applied again.
    const retry = db.apply(queuedItem);
    expect(retry.alreadyApplied, "retry of the identical queued item is a safe no-op").toBe(true);
    expect(db.snapshot().products[productId]?.name).toBe("Retry Edited");
  });
});
