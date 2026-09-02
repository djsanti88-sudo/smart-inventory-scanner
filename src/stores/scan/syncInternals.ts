import type { PendingSyncItem } from "@/types";
import type { SyncResult } from "@/sync-database/mock/mockDb";
import { planSyncBatch } from "@/sync-database/queue/syncBatchPlanner";
import { recomputeSyncStatus } from "@/stores/scan/persistShape";
import type { ScanState, ScanStoreDeps } from "@/stores/scanStore";

export function createSyncInternals(ctx: {
  set: (partial: Partial<ScanState> | ((s: ScanState) => Partial<ScanState>)) => void;
  get: () => ScanState;
  deps: ScanStoreDeps;
}) {
  const { set, get, deps } = ctx;
  const { db, now } = deps;

    // Serialize cloud drains: rapid scans each call syncPending, and overlapping async drains would
    // contend on the same _appliedKeys doc (self-inflicted "already-exists"). A promise-chain mutex runs
    // each drain after the previous completes; every enqueue still triggers a drain that picks up the
    // latest queue. Per-item idempotency (transaction + ledger) remains the guarantee against true retries.
    const CLOUD_APPLY_TIMEOUT_MS = 60_000;
    const STALE_DRAIN_MS = 75_000;
    // Every N successfully/unsuccessfully processed items, the in-flight pass durably commits its
    // progress (see flushProgress in drainCloudOnce below), instead of waiting for the whole batch to
    // finish. This is what lets a multi-minute real-network drain survive being superseded mid-flight.
    const PROGRESS_FLUSH_CHUNK = 10;
    let drainChain: Promise<void> = Promise.resolve();
    let drainStartedAt: number | null = null;
    // Tracks the last time ANY item in the current pass finished processing (success or error). A pass
    // that keeps landing items is healthy no matter how long it runs in total; only a pass with NO
    // completed item for STALE_DRAIN_MS is truly wedged. Using drainStartedAt alone (the pass's total
    // age) was the 2026-08-05 livelock bug: a large real-latency batch legitimately takes minutes, so
    // the "is old" check kept firing and cancelling healthy, actively-progressing passes.
    let lastProgressAt: number | null = null;
    let activeDrainToken = 0;
    const queueItemIdentity = (item: PendingSyncItem) =>
      `${item.businessId}\u0000${item.id}\u0000${item.idempotencyKey}`;
    const PRODUCT_DRAIN_CONCURRENCY = 4;
    const PHYSICAL_PRODUCT_APPLY_STOPPED = Symbol("physical-product-apply-stopped");
    type PhysicalProductApply = {
      result: Promise<SyncResult>;
      settlement: Promise<void>;
    };
    // Logical timeouts and watchdog supersession cannot cancel a Firestore transaction already handed
    // to db.apply. Keep physical ownership in this store closure so every drain pass observes the same
    // four-slot ceiling, and so retries join/wait for an unresolved same-item/same-product write instead
    // of overtaking it. Entries leave these registries only when the underlying promise truly settles.
    const physicalProductApplies = new Map<string, PhysicalProductApply>();
    const physicalProductApplyByEntity = new Map<string, PhysicalProductApply>();
    const physicalProductKey = (item: PendingSyncItem) => `${item.businessId}\u0000${item.entityId}`;
    const applyIndependentProductPhysically = async (
      item: PendingSyncItem,
      canStart: () => boolean,
    ): Promise<SyncResult | typeof PHYSICAL_PRODUCT_APPLY_STOPPED> => {
      const identity = queueItemIdentity(item);
      const productKey = physicalProductKey(item);
      while (true) {
        const sameItem = physicalProductApplies.get(identity);
        if (sameItem) return sameItem.result;

        const sameProduct = physicalProductApplyByEntity.get(productKey);
        if (sameProduct) {
          await sameProduct.settlement;
          if (!canStart()) return PHYSICAL_PRODUCT_APPLY_STOPPED;
          continue;
        }

        if (physicalProductApplies.size >= PRODUCT_DRAIN_CONCURRENCY) {
          await Promise.race([...physicalProductApplies.values()].map((entry) => entry.settlement));
          if (!canStart()) return PHYSICAL_PRODUCT_APPLY_STOPPED;
          continue;
        }

        if (!canStart()) return PHYSICAL_PRODUCT_APPLY_STOPPED;
        const result = Promise.resolve().then(() => db.apply(item));
        const settlement = result
          .then((logicalResult) => logicalResult.physicalSettlement)
          .then(() => undefined, () => undefined)
          .finally(() => {
            if (physicalProductApplies.get(identity)?.result === result) physicalProductApplies.delete(identity);
            if (physicalProductApplyByEntity.get(productKey)?.result === result) {
              physicalProductApplyByEntity.delete(productKey);
            }
          });
        const entry: PhysicalProductApply = { result, settlement };
        physicalProductApplies.set(identity, entry);
        physicalProductApplyByEntity.set(productKey, entry);
        // A logical timeout may stop awaiting this promise. Keep a rejection observer attached so a
        // later physical failure is never reported as an unhandled rejection while cleanup still runs.
        void result.catch(() => {});
        void settlement.catch(() => {});
        return result;
      }
    };
    const syncPendingCloud = (force: boolean): Promise<void> => {
      const state = get();
      if (
        drainStartedAt !== null &&
        Date.now() - (lastProgressAt ?? drainStartedAt) > STALE_DRAIN_MS &&
        state.pendingSyncQueue.length > 0
      ) {
        console.warn(`[sync] drain watchdog: force-reset after ${Date.now() - (lastProgressAt ?? drainStartedAt)}ms with no completed item, ${state.pendingSyncQueue.length} items pending`);
        activeDrainToken += 1;
        drainStartedAt = null;
        lastProgressAt = null;
        drainChain = Promise.resolve();
      }
      drainChain = drainChain.then(async () => {
        const token = ++activeDrainToken;
        drainStartedAt = Date.now();
        lastProgressAt = drainStartedAt;
        try {
          await drainCloudOnce(force, token);
        } finally {
          if (activeDrainToken === token) {
            drainStartedAt = null;
            lastProgressAt = null;
          }
        }
      }).catch(() => {});
      return drainChain;
    };

    // Cloud drain (one pass): async, awaits db.apply, and REQUIRES a real business context first (no
    // fake/default business writes). The mock/local path keeps the original SYNCHRONOUS syncPending below.
    const drainCloudOnce = async (force: boolean, token: number) => {
      const state = get();
      if (!state.online && !force) return;
      if (state.pendingSyncQueue.length === 0) return;
      if (!state.businessContextReady || !state.userId || !state.businessId) {
        set({ lastSyncError: "Select or create a business before syncing to the cloud." });
        return; // pause: keep everything pending, write nothing
      }
      // Snapshot the batch to process. We must NOT overwrite the whole queue at the end (items enqueued
      // by rapid scans DURING this async loop would be clobbered + silently lost). Instead, track this
      // batch's outcome by item id and reconcile against the LATEST queue, preserving anything new.
      const activeBusinessId = state.businessId;
      const activeUserId = state.userId;
      const batch = state.pendingSyncQueue.filter(
        (item) => item.businessId === activeBusinessId && item.status !== "quarantined",
      );
      if (batch.length === 0) return;
      const syncedIds = new Set(get().syncedScanEventIds);
      let appliedItems = new Set<string>();
      let erroredItems = new Map<string, PendingSyncItem>();
      let lastErr: string | null = null;
      let unflushedCount = 0;

      // Persist whatever has landed so far. Intentionally NOT gated on `activeDrainToken === token` when
      // there are real successes to save: those items already committed server-side (db.apply resolved
      // ok), so their bookkeeping (dequeue + syncedScanEventIds) must survive even if the watchdog
      // supersedes this pass moments later. This is the fix for the 2026-08-05 livelock: previously the
      // ONLY commit point was a single set() after the whole batch loop, gated on the token - so a
      // superseded multi-minute pass discarded 100% of its already-server-committed progress, and the
      // replacement pass re-sent the SAME starting batch forever.
      //
      // A superseded pass with NOTHING but errored/retry bookkeeping to report (no successes) still
      // discards that partial state rather than writing it - the replacement pass will naturally retry
      // those same still-pending items, and this preserves the existing stale-clobber guarantee that an
      // abandoned pass's late-arriving results never write into a queue/session it no longer represents.
      const flushProgress = () => {
        if (appliedItems.size === 0 && erroredItems.size === 0) return;
        if (activeDrainToken !== token && appliedItems.size === 0) {
          appliedItems = new Set<string>();
          erroredItems = new Map<string, PendingSyncItem>();
          unflushedCount = 0;
          return;
        }
        const appliedSnapshot = appliedItems;
        const erroredSnapshot = erroredItems;
        const syncedSnapshot = syncedIds;
        set((cur) => {
          // Reconcile against the CURRENT queue: drop applied items, replace errored with their updated
          // version, and KEEP any items enqueued while this pass was awaiting (a later pass drains them).
          const nextQueue = cur.pendingSyncQueue
            .filter((it) => !appliedSnapshot.has(queueItemIdentity(it)))
            .map((it) => erroredSnapshot.get(queueItemIdentity(it)) ?? it);
          const recomputed = recomputeSyncStatus({
            businessId: cur.businessId,
            scanFeed: cur.scanFeed,
            finalCounts: cur.finalCounts,
            needsReviewQueue: cur.needsReviewQueue,
            pendingSyncQueue: nextQueue,
          });
          const contextStillMatches =
            cur.businessContextReady &&
            cur.businessId === activeBusinessId &&
            cur.userId === activeUserId;
          // Merge, never replace: syncedSnapshot is this pass's own local accumulator, seeded once at
          // pass start and grown only in this closure. Overwriting cur.syncedScanEventIds with it would
          // silently drop ids a DIFFERENT (newer) pass already recorded, if this pass's trailing flush
          // runs after that - reintroducing, in this one field, the exact "a pass's flush clobbers
          // progress it doesn't own" defect this fix eliminates for pendingSyncQueue. The ledger is
          // documented monotonic (scanPersist.ts:55): synced ids only ever accumulate, never shrink.
          const mergedSyncedIds = Array.from(new Set([...cur.syncedScanEventIds, ...syncedSnapshot]));
          return {
            pendingSyncQueue: nextQueue,
            syncedScanEventIds: mergedSyncedIds,
            lastSyncError: contextStillMatches ? lastErr : cur.lastSyncError,
            ...recomputed,
          };
        });
        appliedItems = new Set<string>();
        erroredItems = new Map<string, PendingSyncItem>();
        unflushedCount = 0;
      };

      const contextStillActive = () => {
        if (activeDrainToken !== token) return false;
        const live = get();
        return (
          live.businessContextReady &&
          live.businessId === activeBusinessId &&
          live.userId === activeUserId
        );
      };

      const applySyncItem = async (
        item: PendingSyncItem,
        independentProductLane = false,
      ): Promise<"applied" | "failed" | "stopped"> => {
        // Token mismatch stops SENDING new applies; whatever already succeeded is saved by the flush
        // below regardless (see flushProgress comment).
        if (!contextStillActive()) return "stopped";
        const itemIdentity = queueItemIdentity(item);
        let res;
        let logicalAttemptOpen = true;
        try {
          let timeoutId: ReturnType<typeof setTimeout> | undefined;
          try {
            res = await Promise.race([
              independentProductLane
                ? applyIndependentProductPhysically(
                    item,
                    () => logicalAttemptOpen && contextStillActive(),
                  )
                : db.apply(item),
              new Promise<never>((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error(`cloud sync apply timed out after ${CLOUD_APPLY_TIMEOUT_MS}ms`)), CLOUD_APPLY_TIMEOUT_MS);
              }),
            ]);
          } finally {
            logicalAttemptOpen = false;
            if (timeoutId !== undefined) clearTimeout(timeoutId);
          }
        } catch (e) {
          res = {
            ok: false,
            alreadyApplied: false,
            error: e instanceof Error ? e.message : String(e),
            retryable: true,
          };
        }
        if (res === PHYSICAL_PRODUCT_APPLY_STOPPED) return "stopped";
        if (res.ok) {
          // A genuine successful apply is forward progress: the wedged-pass watchdog must not fire
          // regardless of total pass age as long as items keep actually landing. An error/timeout is NOT
          // counted as progress here - a pass that only ever times out (never lands anything) is exactly
          // the wedge this watchdog exists to catch, same as before this fix.
          lastProgressAt = Date.now();
          appliedItems.add(itemIdentity);
          if (item.scanEventId) syncedIds.add(item.scanEventId);
        } else {
          erroredItems.set(itemIdentity, {
            ...item,
            status: res.retryable === false ? "quarantined" : "error",
            retryCount: item.retryCount + 1,
            lastError: res.error ?? "sync failed",
            syncError: {
              code: res.errorCode ?? "sync_failed",
              message: res.error ?? "sync failed",
            },
            updatedAt: now(),
          });
          lastErr = res.error ?? "sync failed";
        }
        unflushedCount += 1;
        if (unflushedCount >= PROGRESS_FLUSH_CHUNK) flushProgress();
        return res.ok ? "applied" : "failed";
      };

      const { independentProductGroups, serialItems } = planSyncBatch(batch);
      if (independentProductGroups.length > 0) {
        let nextGroupIndex = 0;
        const runProductWorker = async () => {
          while (contextStillActive()) {
            const group = independentProductGroups[nextGroupIndex];
            nextGroupIndex += 1;
            if (!group) return;
            for (const item of group) {
              const result = await applySyncItem(item, true);
              if (result !== "applied") break;
            }
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(PRODUCT_DRAIN_CONCURRENCY, independentProductGroups.length) }, () =>
            runProductWorker(),
          ),
        );
      }

      const blockedSerialProductIds = new Set<string>();
      for (const item of serialItems) {
        if (item.operation === "SAVE_PRODUCT" && blockedSerialProductIds.has(item.entityId)) continue;
        const result = await applySyncItem(item);
        if (result === "stopped") break;
        if (result === "failed" && item.operation === "SAVE_PRODUCT") {
          blockedSerialProductIds.add(item.entityId);
        }
      }
      flushProgress();
    };

  return {
    queueItemIdentity,
    physicalProductKey,
    applyIndependentProductPhysically,
    syncPendingCloud,
    drainCloudOnce,
  };
}
