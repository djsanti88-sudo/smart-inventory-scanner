import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { DEMO_BUSINESS_ID } from "@/seed/seedData";
import type { SyncTarget } from "@/services/db/syncTarget";
import type { SyncResult } from "@/services/mockDb";
import type { InventoryCount, InventorySession, PendingSyncItem } from "@/types";

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
});
