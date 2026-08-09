import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { DEMO_BUSINESS_ID } from "@/seed/seedData";
import type { SyncTarget } from "@/services/db/syncTarget";
import type { SyncResult, IncrementPayload } from "@/services/mockDb";
import type { InventoryCount, InventorySession, PendingSyncItem } from "@/types";

// VERIFIED DEFECT (live Firebase emulator spot-check, 2026-08-09, e2e/proof/adopt-emulator-spotcheck/):
// an anonymous (pre-account) session runs against the MOCK backend, which marks every local write
// "synced" immediately and empties pendingSyncQueue. When that blob is later ADOPTED into a signed-in
// live-Firebase account, setBusinessContext's bootstrap-resolution branch re-scopes the rows onto the
// real business but there is NOTHING LEFT IN THE QUEUE to re-scope - the adopted rows still carry the
// mock phase's "synced" flag. The real cloud sync engine therefore never pushes them: local total 4,
// Firestore holds only the 1 post-sign-in scan, and the UI honestly reports "All saved: 0" - a SILENT
// local-vs-cloud divergence for the entire pre-auth migration cohort.
//
// FIX: adoption re-enqueues the sync work those adopted entities would have enqueued had they been
// scanned under the live tenant (SAVE_SCAN_EVENT + INCREMENT_COUNT + SAVE_UNKNOWN_SCAN + the
// provisional SAVE_PRODUCT), reusing each entity's OWN already-rescoped idempotencyKey - never a
// regenerated key. Server-side `_appliedKeys` idempotency dedupes anything that genuinely HAD synced
// to this live backend before, so re-enqueueing is safe against double-counting BY DESIGN.

class RecordingTarget implements SyncTarget {
  applied: PendingSyncItem[] = [];
  async apply(item: PendingSyncItem): Promise<SyncResult> {
    await Promise.resolve();
    this.applied.push(item);
    return { ok: true, alreadyApplied: false };
  }
  setFailure() {}
  reset() {}
}

const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};
const emptyLoader = async () => ({
  products: [],
  aliases: [],
  sessions: [] as InventorySession[],
  counts: [] as InventoryCount[],
});

/**
 * Reproduce EXACTLY the persisted shape the mock backend leaves behind after an anonymous session:
 * every queued write already applied (queue empty) and every row flagged syncStatus "synced".
 * That state - not the queue - is what adoption actually inherits from the pre-auth cohort.
 */
function simulateMockBackendPhaseSettled(store: ReturnType<typeof createTestScanStore>) {
  store.setState((s) => ({
    pendingSyncQueue: [],
    scanFeed: s.scanFeed.map((e) => ({ ...e, syncStatus: "synced" as const })),
    finalCounts: s.finalCounts.map((c) => ({ ...c, syncStatus: "synced" as const })),
    needsReviewQueue: s.needsReviewQueue.map((r) => ({ ...r, syncStatus: "synced" as const })),
  }));
}

describe("adoption re-enqueues mock-phase 'synced' rows so the live backend actually receives them", () => {
  it("rebuilds SAVE_SCAN_EVENT + INCREMENT_COUNT for every adopted scan event, reusing the event's own rescoped idempotencyKey, and flips the rows back to pending", async () => {
    const target = new RecordingTarget();
    const store = createTestScanStore({ db: target, cloudBackend: true, loadBusinessData: emptyLoader });

    // Anonymous phase: three scans under the placeholder tenant (a known/countable code, a repeat of
    // it, and an unknown code that opens a review).
    store.getState().processScan("049000050103");
    store.getState().processScan("049000050103");
    store.getState().processScan("222333444555");
    await flush();

    const scannedEvents = store.getState().scanFeed;
    expect(scannedEvents).toHaveLength(3);
    expect(scannedEvents.every((e) => e.businessId === DEMO_BUSINESS_ID)).toBe(true);
    const totalBefore = store.getState().finalCounts.reduce((sum, c) => sum + c.quantity, 0);
    expect(totalBefore).toBeGreaterThan(0);

    // ...and the mock backend settles everything: queue empty, all rows "synced".
    simulateMockBackendPhaseSettled(store);
    expect(store.getState().pendingSyncQueue).toEqual([]);

    // ADOPTION: the signed-in live-Firebase context resolves over the adopted anonymous state.
    store.getState().setBusinessContext("biz-real", "user-real");

    // Synchronously after adoption (BEFORE the drain awaits): the adopted work is queued again and the
    // rows honestly say "pending", instead of claiming a cloud save that never happened.
    const requeued = store.getState().pendingSyncQueue;
    expect(requeued.length).toBeGreaterThan(0);
    expect(requeued.every((item) => item.businessId === "biz-real")).toBe(true);
    expect(store.getState().scanFeed.every((e) => e.syncStatus === "pending")).toBe(true);
    expect(store.getState().finalCounts.every((c) => c.syncStatus === "pending")).toBe(true);

    const adoptedFeed = store.getState().scanFeed;
    for (const event of adoptedFeed) {
      // The event's OWN key (rescoped only in its leading businessId segment) is reused verbatim as the
      // INCREMENT_COUNT identity - never regenerated - so the server's _appliedKeys dedupe still
      // recognises this exact event if it somehow HAD reached this backend already.
      expect(event.idempotencyKey.startsWith("biz-real:")).toBe(true);
      const saveEvent = requeued.find(
        (item) => item.operation === "SAVE_SCAN_EVENT" && item.entityId === event.id,
      );
      expect(saveEvent, `SAVE_SCAN_EVENT missing for ${event.id}`).toBeDefined();
      expect(saveEvent!.scanEventId).toBe(event.id);
      if (event.quantityDelta > 0 && event.matchedProductId) {
        const increment = requeued.find(
          (item) => item.operation === "INCREMENT_COUNT" && item.scanEventId === event.id,
        );
        expect(increment, `INCREMENT_COUNT missing for ${event.id}`).toBeDefined();
        expect(increment!.idempotencyKey).toBe(event.idempotencyKey);
        const payload = increment!.payload as IncrementPayload;
        expect(payload.idempotencyKey).toBe(increment!.idempotencyKey);
        expect(payload.businessId).toBe("biz-real");
        expect(payload.sessionId).toBe(increment!.sessionId);
        expect(payload.scanEventId).toBe(event.id);
        expect(payload.quantityDelta).toBe(event.quantityDelta);
      }
    }

    // The open review is re-enqueued too, with its own rescoped key.
    const review = store.getState().needsReviewQueue[0];
    expect(review).toBeDefined();
    const savedReview = requeued.find(
      (item) => item.operation === "SAVE_UNKNOWN_SCAN" && item.entityId === review.id,
    );
    expect(savedReview).toBeDefined();
    expect(savedReview!.idempotencyKey).toBe(review.idempotencyKey);

    // TOP LAW: counting is untouched by any of this - scan N still equals count N.
    expect(store.getState().scanFeed).toHaveLength(3);
    expect(store.getState().finalCounts.reduce((sum, c) => sum + c.quantity, 0)).toBe(totalBefore);

    // And it really reaches the live target once the drain runs.
    await flush();
    expect(target.applied.length).toBeGreaterThan(0);
    expect(target.applied.every((item) => item.businessId === "biz-real")).toBe(true);
    expect(
      target.applied.some((item) => item.operation === "INCREMENT_COUNT"),
    ).toBe(true);
  });

  it("does not duplicate a queue item that already exists for the same idempotencyKey (queue still full at adoption time)", async () => {
    const target = new RecordingTarget();
    const store = createTestScanStore({ db: target, cloudBackend: true, loadBusinessData: emptyLoader });

    store.getState().processScan("049000050103");
    store.getState().processScan("222333444555");
    await flush();

    // The ordinary fix-#41 shape: nothing drained yet, so every write is STILL queued under the
    // placeholder tenant. Adoption must only re-scope those items, never add a second copy.
    const beforeKeys = store.getState().pendingSyncQueue.map((i) => i.idempotencyKey);
    expect(beforeKeys.length).toBeGreaterThan(0);

    store.getState().setBusinessContext("biz-real", "user-real");

    const afterKeys = store.getState().pendingSyncQueue.map((i) => i.idempotencyKey);
    expect(new Set(afterKeys).size).toBe(afterKeys.length); // no duplicate keys
    expect(afterKeys.length).toBe(beforeKeys.length); // nothing added on top of the rescoped items
  });

  it("re-enqueues the adopted PROVISIONAL product for an unknown scan (a count in the cloud must not point at a product doc that was never written)", async () => {
    const target = new RecordingTarget();
    const store = createTestScanStore({ db: target, cloudBackend: true, loadBusinessData: emptyLoader });

    store.getState().processScan("222333444555");
    store.getState().ensureProvisionalCount("222333444555", "Unidentified item");
    await flush();

    const provisional = store.getState().products.find((p) => p.provisional === true);
    expect(provisional).toBeDefined();

    simulateMockBackendPhaseSettled(store);
    store.getState().setBusinessContext("biz-real", "user-real");

    const requeued = store.getState().pendingSyncQueue;
    const productItem = requeued.find(
      (item) => item.operation === "SAVE_PRODUCT" && item.entityId === provisional!.id,
    );
    expect(productItem).toBeDefined();
    expect(productItem!.businessId).toBe("biz-real");
    // Seed catalog products are NOT pushed: only provisional products minted during the adopted
    // session (the ones that exist nowhere but this device) are re-enqueued.
    const seedProductItems = requeued.filter(
      (item) => item.operation === "SAVE_PRODUCT" && item.entityId !== provisional!.id,
    );
    expect(seedProductItems).toEqual([]);
  });
});
