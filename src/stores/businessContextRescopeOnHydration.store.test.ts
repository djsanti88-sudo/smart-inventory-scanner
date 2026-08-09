import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { DEMO_BUSINESS_ID } from "@/seed/seedData";
import type { SyncTarget } from "@/services/db/syncTarget";
import type { SyncResult, IncrementPayload } from "@/services/mockDb";
import type { InventoryCount, InventorySession, PendingSyncItem, UnknownCodeReview } from "@/types";

// Fix #41 (data-loss shaped, intermittent race): if a scan is processed on the SIGN-IN path before the
// real business context finishes hydrating, the scan store keeps the placeholder businessId
// (DEMO_BUSINESS_ID) for those scans. Scans count locally (TOP LAW held) but their pendingSyncQueue
// items are permanently stamped with the placeholder tenant id. The tenant-aware cloud drain only
// matches queue items whose businessId equals the CURRENT tenant (scanStore.ts drainCloudOnce), and the
// placeholder tenant never becomes "current" again once the real business resolves - so those items were
// stranded forever: never synced, and (recomputeSyncStatus filters the SAME way) misreported as already
// "synced" in the UI ("pending shows 0").

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

describe("setBusinessContext re-scopes placeholder-tenant work on sign-in hydration (fix #41)", () => {
  it("re-scopes and drains scans processed before hydration onto the real business, instead of stranding them under the placeholder forever", async () => {
    const target = new RecordingTarget();
    const store = createTestScanStore({ db: target, cloudBackend: true, loadBusinessData: emptyLoader });

    // Cloud mode, sign-in bootstrap not yet resolved: businessId is still the placeholder, userId null.
    expect(store.getState().businessId).toBe(DEMO_BUSINESS_ID);
    expect(store.getState().userId).toBeNull();
    expect(store.getState().businessContextReady).toBe(false);

    // Three scans race ahead of hydration and get counted + queued under the placeholder tenant.
    store.getState().processScan("049000050103");
    store.getState().processScan("6419440485331");
    store.getState().processScan("111111111111");
    await flush();

    const beforeQueue = store.getState().pendingSyncQueue;
    expect(beforeQueue.length).toBeGreaterThan(0);
    expect(beforeQueue.every((item) => item.businessId === DEMO_BUSINESS_ID)).toBe(true);
    // Nothing synced yet: businessContextReady is false, so the cloud drain paused everything.
    expect(target.applied).toEqual([]);

    // NOW the real business context resolves (the sign-in bootstrap chain finishes).
    store.getState().setBusinessContext("biz-real", "user-real");
    await flush();

    // FIX: the earlier scans/queue items must be RE-SCOPED onto the real business, and drained -
    // never left permanently tagged with the placeholder id, and never dropped.
    const afterQueue = store.getState().pendingSyncQueue;
    expect(afterQueue.some((item) => item.businessId === DEMO_BUSINESS_ID)).toBe(false);
    expect(store.getState().scanFeed.some((e) => e.businessId === DEMO_BUSINESS_ID)).toBe(false);
    expect(store.getState().scanFeed).toHaveLength(3);
    // The rescoped items actually reached the (real-business) sync target - not stranded.
    expect(target.applied.length).toBeGreaterThan(0);
    expect(target.applied.every((item) => item.businessId === "biz-real")).toBe(true);
    // Idempotency identity is preserved (never regenerated) apart from the businessId segment, so a
    // retry of a rescoped item still dedupes against the exact same key going forward.
    for (const item of afterQueue) {
      expect(item.idempotencyKey.startsWith("biz-real:")).toBe(true);
    }
  });

  it("rewrites the EMBEDDED payload.idempotencyKey (and payload.businessId) to match the rescoped outer idempotencyKey, not just the outer key (bug proven live 2026-08-09: server rejects payload_idempotency_mismatch when only the outer key is rescoped)", async () => {
    const target = new RecordingTarget();
    const store = createTestScanStore({ db: target, cloudBackend: true, loadBusinessData: emptyLoader });

    expect(store.getState().businessId).toBe(DEMO_BUSINESS_ID);

    // A scan races ahead of hydration under the placeholder tenant, queuing an INCREMENT_COUNT whose
    // payload embeds its OWN idempotencyKey (IncrementPayload.idempotencyKey), separate from the
    // queue item's own outer idempotencyKey field.
    store.getState().processScan("049000050103");
    await flush();

    const beforeQueue = store.getState().pendingSyncQueue;
    const beforeIncrement = beforeQueue.find((item) => item.operation === "INCREMENT_COUNT");
    expect(beforeIncrement).toBeDefined();
    // Sanity: before rescoping, outer and embedded payload key already agree (this is the invariant
    // the fix must preserve after rescoping too).
    const beforeIncPayload = beforeIncrement!.payload as IncrementPayload;
    expect(beforeIncPayload.idempotencyKey).toBe(beforeIncrement!.idempotencyKey);
    expect(beforeIncrement!.idempotencyKey.startsWith(`${DEMO_BUSINESS_ID}:`)).toBe(true);

    // Adoption: the real business context resolves and re-scopes the placeholder work.
    store.getState().setBusinessContext("biz-real", "user-real");
    await flush();

    // The rescoped item is drained (synced) immediately by the same setBusinessContext call, so by the
    // time we look, it may already be gone from pendingSyncQueue and present in target.applied instead -
    // that IS the exact payload the (mock/real) server-side validator receives, which is what matters.
    const afterQueue = store.getState().pendingSyncQueue;
    const afterIncrement =
      afterQueue.find((item) => item.operation === "INCREMENT_COUNT" && item.entityId === beforeIncrement!.entityId) ??
      target.applied.find((item) => item.operation === "INCREMENT_COUNT" && item.entityId === beforeIncrement!.entityId);
    expect(afterIncrement).toBeDefined();
    const afterIncPayload = afterIncrement!.payload as IncrementPayload;

    // No queue item was lost across the rescope: it is either still queued or was successfully applied.
    expect(afterQueue.length + target.applied.length).toBeGreaterThanOrEqual(beforeQueue.length);

    // THE BUG: the outer idempotencyKey gets rewritten onto the real business, but the embedded
    // payload.idempotencyKey must match it exactly (server-side firebaseSyncSafety.validatePendingSyncItem
    // rejects INCREMENT_COUNT with payload_idempotency_mismatch whenever they disagree).
    expect(afterIncrement!.idempotencyKey.startsWith("biz-real:")).toBe(true);
    expect(afterIncPayload.idempotencyKey).toBe(afterIncrement!.idempotencyKey);
    expect(afterIncPayload.businessId).toBe("biz-real");
  });

  it("does not disturb the ordinary fresh-store sign-up/cloud-init path (no placeholder activity to rescope)", async () => {
    const target = new RecordingTarget();
    const store = createTestScanStore({ db: target, cloudBackend: true, loadBusinessData: emptyLoader });

    // No scans yet: a brand new cloud session's first ever setBusinessContext call must behave exactly
    // like the existing wipe-to-clean-slate branch (many existing tests pin this).
    store.getState().setBusinessContext("biz-new", "user-new");
    await flush();

    expect(store.getState().businessId).toBe("biz-new");
    expect(store.getState().scanFeed).toEqual([]);
    expect(store.getState().pendingSyncQueue).toEqual([]);
    expect(store.getState().businessDataLoaded).toBe(true);
  });

  it("rewrites the EMBEDDED UnknownCodeReview.idempotencyKey (SAVE_UNKNOWN_SCAN payload) to match the rescoped outer idempotencyKey, mirroring the INCREMENT_COUNT fix above (firebaseSyncSafety validates payload_idempotency_mismatch identically for this operation shape, ~196-201)", async () => {
    const target = new RecordingTarget();
    const store = createTestScanStore({ db: target, cloudBackend: true, loadBusinessData: emptyLoader });

    // Unknown code races ahead of hydration under the placeholder tenant -> a SAVE_UNKNOWN_SCAN queue
    // item whose payload embeds its OWN idempotencyKey (UnknownCodeReview.idempotencyKey), separate
    // from the queue item's own outer idempotencyKey field.
    store.getState().processScan("222333444555");
    await flush();

    const beforeQueue = store.getState().pendingSyncQueue;
    const beforeReview = beforeQueue.find((item) => item.operation === "SAVE_UNKNOWN_SCAN");
    expect(beforeReview).toBeDefined();
    const beforeReviewPayload = beforeReview!.payload as UnknownCodeReview;
    // Sanity: before rescoping, outer and embedded payload key already agree.
    expect(beforeReviewPayload.idempotencyKey).toBe(beforeReview!.idempotencyKey);
    expect(beforeReview!.idempotencyKey.startsWith(`${DEMO_BUSINESS_ID}:`)).toBe(true);

    store.getState().setBusinessContext("biz-real", "user-real");
    await flush();

    const afterQueue = store.getState().pendingSyncQueue;
    const afterReview =
      afterQueue.find((item) => item.operation === "SAVE_UNKNOWN_SCAN" && item.entityId === beforeReview!.entityId) ??
      target.applied.find((item) => item.operation === "SAVE_UNKNOWN_SCAN" && item.entityId === beforeReview!.entityId);
    expect(afterReview).toBeDefined();
    const afterReviewPayload = afterReview!.payload as UnknownCodeReview;

    // Same-shape assertion as the INCREMENT_COUNT case: outer === embedded, both real-business-prefixed.
    expect(afterReview!.idempotencyKey.startsWith("biz-real:")).toBe(true);
    expect(afterReviewPayload.idempotencyKey).toBe(afterReview!.idempotencyKey);
    expect(afterReviewPayload.businessId).toBe("biz-real");
  });

  it("class closure (F-5): after rescope, the full persisted-shape state contains zero references to the placeholder tenant across every embedded identity field - scanFeed/needsReviewQueue idempotencyKey, finalCounts.appliedIdempotencyKeys, and aiLookupLogs.businessId - and no row/count is lost or duplicated", async () => {
    const target = new RecordingTarget();
    const store = createTestScanStore({ db: target, cloudBackend: true, loadBusinessData: emptyLoader });

    store.getState().processScan("049000050103"); // known code -> counted
    store.getState().processScan("222333444555"); // unknown code -> SAVE_UNKNOWN_SCAN + UnknownCodeReview
    await flush();

    // aiLookupLogs is not driven by processScan in this mock config (aiLookupEnabled is off by
    // default in tests), so inject an entry the way the live-decode call sites do, via the store's
    // own public setState - this is the collection the F-5 fix newly adds to the rescoped set.
    store.setState((state) => ({
      aiLookupLogs: [
        {
          id: "log-1",
          businessId: DEMO_BUSINESS_ID,
          rawCode: "222333444555",
          cleanCode: "222333444555",
          providerName: "mock",
          status: "success" as const,
          confidence: 0.9,
          estimatedInputTokens: 0,
          estimatedOutputTokens: 0,
          estimatedCost: 0,
          cacheHit: false,
          circuitBreakerState: "closed" as const,
          createdAt: new Date().toISOString(),
        },
        ...state.aiLookupLogs,
      ],
    }));

    const beforeQueueLength = store.getState().pendingSyncQueue.length;
    const beforeScanFeedLength = store.getState().scanFeed.length;
    const beforeTotalQty = store.getState().finalCounts.reduce((sum, c) => sum + c.quantity, 0);
    expect(store.getState().needsReviewQueue.length).toBeGreaterThan(0);

    store.getState().setBusinessContext("biz-real", "user-real");
    await flush();

    const afterState = store.getState();
    // Deep-serialize the whole persisted-shape state and assert the placeholder tenant id appears
    // NOWHERE - this single assertion is the permanent guard against the whole class of "one more
    // embedded businessId-derived field forgot to be rescoped" bugs.
    const serialized = JSON.stringify(afterState);
    expect(serialized.includes(DEMO_BUSINESS_ID)).toBe(false);

    // No queue item lost across the rescope (still queued, or already applied to the target).
    expect(afterState.pendingSyncQueue.length + target.applied.length).toBeGreaterThanOrEqual(beforeQueueLength);
    // Every scan row survives the rescope: no row dropped or duplicated.
    expect(afterState.scanFeed.length).toBe(beforeScanFeedLength);
    // Counted quantity is preserved exactly (TOP-LEVEL LAW).
    const afterTotalQty = afterState.finalCounts.reduce((sum, c) => sum + c.quantity, 0);
    expect(afterTotalQty).toBe(beforeTotalQty);
  });
});
