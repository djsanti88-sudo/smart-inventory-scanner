import { describe, expect, it, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import type { SyncTarget } from "@/services/db/syncTarget";
import type { SyncResult } from "@/services/mockDb";
import type { PendingSyncItem } from "@/types";

function expectMonotonicNonDecreasing(label: string, values: number[]) {
  for (let i = 1; i < values.length; i += 1) {
    expect(values[i], `${label}: value at index ${i} (${values[i]}) dropped below index ${i - 1} (${values[i - 1]})`).toBeGreaterThanOrEqual(values[i - 1]);
  }
}

// Regression for the 2026-08-05 preview-campaign livelock: with ~3,000 queued items on real-network
// latency, a full drain pass takes minutes. The STALE_DRAIN_MS=75s watchdog fires (a new scan/retry
// triggers syncPendingCloud, which resets the mutex) while the pass is still working. The superseded
// pass's bookkeeping (dequeue + syncedScanEventIds) previously lived ONLY in a single set() call gated
// on `activeDrainToken === token` AFTER the whole batch loop finished - so every reset discarded 100%
// of that pass's already-server-committed successes. The replacement pass re-sends the SAME full batch
// (idempotent 200s server-side) and gets reset again before finishing: forever. Progress is lost only
// client-side; db.apply() genuinely lands (this test's `target.applied` proves that half).

const ITEM_LATENCY_MS = 500;
const ITEM_COUNT = 300;
const BIZ = "biz-drainprogress";

class SlowTarget implements SyncTarget {
  applied: PendingSyncItem[] = [];

  apply(item: PendingSyncItem): Promise<SyncResult> {
    return new Promise((resolve) => {
      setTimeout(() => {
        this.applied.push(item);
        resolve({ ok: true, alreadyApplied: false });
      }, ITEM_LATENCY_MS);
    });
  }

  setFailure() {}
  reset() {}
}

function pendingItem(i: number): PendingSyncItem {
  const id = `scan-${i}`;
  return {
    id,
    businessId: BIZ,
    sessionId: "session-1",
    entityType: "ScanEvent",
    entityId: id,
    operation: "SAVE_SCAN_EVENT",
    payload: { id, businessId: BIZ, code: `0000000${i}` },
    status: "pending",
    retryCount: 0,
    lastError: null,
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
    idempotencyKey: `${BIZ}:session-1:${id}:SAVE_SCAN_EVENT`,
    scanEventId: id,
  } as PendingSyncItem;
}

const flush = async (ticks = 20) => {
  for (let i = 0; i < ticks; i += 1) await Promise.resolve();
};

describe("cloud drain progress under repeated watchdog resets (2026-08-05 livelock regression)", () => {
  it("fully drains a large real-latency queue even when new activity keeps re-triggering the stale-drain watchdog mid-pass", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const target = new SlowTarget();
      const store = createTestScanStore({ db: target, cloudBackend: true });
      store.getState().setBusinessContext(BIZ, "user-drainprogress");
      await vi.runAllTimersAsync();

      const items = Array.from({ length: ITEM_COUNT }, (_, i) => pendingItem(i));
      store.setState({ pendingSyncQueue: items });
      store.getState().retrySync(); // kicks off the first drain pass

      // Simulate real production conditions: new activity (more scans / retries) keeps arriving roughly
      // every 76 seconds - just past the 75s watchdog window - continuously, for as long as the campaign
      // runs. This is the real-world condition that broke: scanning never stops long enough to give a
      // pass an uninterrupted window, so the pass NEVER gets to complete without being reset mid-flight.
      // A correct implementation must still make monotonic, durable progress despite that; a livelocked
      // one resends the SAME starting batch every round forever, no matter how many rounds run.
      const queueLengths: number[] = [];
      const syncedLengths: number[] = [store.getState().syncedScanEventIds.length];
      for (let round = 0; round < 8; round += 1) {
        await vi.advanceTimersByTimeAsync(76_000);
        await flush();
        store.getState().retrySync();
        await flush();
        queueLengths.push(store.getState().pendingSyncQueue.length);
        syncedLengths.push(store.getState().syncedScanEventIds.length);
      }

      // syncedScanEventIds is a documented monotonic ledger (scanPersist.ts:55): it must only ever grow,
      // never shrink, no matter how many overlapping/superseded passes write to it across this run.
      expectMonotonicNonDecreasing("syncedScanEventIds.length across rounds", syncedLengths);

      // The server genuinely received and accepted a large number of applies throughout (this is the
      // "486 commits returned 200" half of the real incident) ...
      expect(target.applied.length).toBeGreaterThan(0);

      // ... but the TOP-LEVEL LAW here is client bookkeeping: every item must eventually be dequeued and
      // recorded as synced, WITHOUT ever needing a quiet/uninterrupted window. A livelocked implementation
      // leaves pendingSyncQueue stuck at exactly 300 every single round, with syncedScanEventIds empty,
      // no matter how many rounds of continuous activity pass.
      expect(queueLengths.some((len) => len < ITEM_COUNT)).toBe(true);
      expect(store.getState().pendingSyncQueue).toHaveLength(0);
      expect(store.getState().syncedScanEventIds).toHaveLength(ITEM_COUNT);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  }, 30_000);

  // Deterministic reproduction of the code-review finding on the first fix: flushProgress wrote
  // `syncedScanEventIds: [...syncedSnapshot]` - a full OVERWRITE from the pass-local snapshot (seeded
  // once at that pass's start). The watchdog ABANDONS a superseded pass rather than cancelling it, so an
  // old pass can keep running in the background and its trailing flush (triggered once it finally
  // finishes the item it was mid-await on) can land AFTER a newer, replacement pass already flushed a
  // LARGER syncedScanEventIds set. An overwrite from the stale, smaller snapshot then silently drops the
  // newer pass's recorded ids - reintroducing, in this one field, exactly the "superseded pass discards
  // committed progress" defect this task exists to eliminate. The fix must MERGE (union) against `cur`
  // instead, exactly as pendingSyncQueue is already reconciled functionally against `cur`.
  it("never lets a stale pass's trailing flush erase syncedScanEventIds a newer pass already recorded (adversarial interleaving)", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      type Resolver = (res: SyncResult) => void;

      // Calls 1 and 2 (item A then item B, pass1's own attempts) are held open manually / only resolved
      // by our OWN internal CLOUD_APPLY_TIMEOUT_MS race (never by this target) - modeling two requests
      // still genuinely in flight on a slow real network. Calls 3+ (the replacement pass's attempts)
      // resolve almost immediately, modeling the network recovering / a smaller, faster retry batch.
      const FAST_FROM_CALL = 3;
      class InterleavedTarget implements SyncTarget {
        applied: PendingSyncItem[] = [];
        callCount = 0;
        manualResolvers: Resolver[] = [];

        apply(item: PendingSyncItem): Promise<SyncResult> {
          this.callCount += 1;
          const isManual = this.callCount < FAST_FROM_CALL;
          return new Promise((resolve) => {
            const settle: Resolver = (res) => {
              if (res.ok) this.applied.push(item);
              resolve(res);
            };
            if (isManual) {
              this.manualResolvers.push(settle);
            } else {
              setTimeout(() => settle({ ok: true, alreadyApplied: false }), 5);
            }
          });
        }

        setFailure() {}
        reset() {}
      }

      const target = new InterleavedTarget();
      const store = createTestScanStore({ db: target, cloudBackend: true });
      store.getState().setBusinessContext(BIZ, "user-interleave");
      await vi.runAllTimersAsync();

      const A = pendingItem(1000);
      const B = pendingItem(1001);
      const C = pendingItem(1002);
      store.setState({ pendingSyncQueue: [A, B, C] });

      const syncedLengths: number[] = [store.getState().syncedScanEventIds.length]; // starts at 0

      // Pass1 (token 1) starts and immediately begins awaiting item A (call #1, held manually - left
      // unresolved so our own 60s per-item timeout converts it to an error, which is NOT counted as
      // progress). It then moves on to item B (call #2, also held manually - this is the one we resolve
      // LATE, below).
      store.getState().retrySync();
      await flush();
      await vi.advanceTimersByTimeAsync(76_000); // > CLOUD_APPLY_TIMEOUT_MS(60s): A force-times-out as an
      // error (no progress recorded); pass1 moves on to B (call #2) and is now stuck awaiting it, with
      // zero SUCCESSES recorded so far - lastProgressAt is still unset, so this elapsed time alone
      // satisfies the watchdog's no-progress-for-75s condition on the next check below.
      await flush();

      // A real retry/reconnect trigger re-evaluates the watchdog: no item has SUCCEEDED yet in pass1, so
      // it force-resets the mutex (token -> 2) and starts a fresh, replacement pass. Pass1 is ABANDONED,
      // not cancelled - it is still suspended awaiting item B's call #2 in the background.
      store.getState().retrySync();
      await flush();

      // The replacement pass (token 2) re-snapshots the still-untouched queue ([A, B, C] - pass1 never
      // flushed anything) and re-attempts all three. Its calls (#3, #4, #5) resolve quickly.
      await vi.advanceTimersByTimeAsync(20);
      await flush(40);
      syncedLengths.push(store.getState().syncedScanEventIds.length);

      // The replacement pass must have fully landed and flushed all three items before we let pass1's
      // stale call resolve, to set up the exact ordering the review flagged.
      expect(store.getState().pendingSyncQueue).toHaveLength(0);
      expect(store.getState().syncedScanEventIds.length).toBe(3);

      // NOW let pass1's original, long-in-flight call #2 (item B) finally "land" with a genuine success -
      // its late physical completion, exactly like the real incident's late-arriving Firestore commits.
      target.manualResolvers[1]({ ok: true, alreadyApplied: false });
      await flush(40);
      syncedLengths.push(store.getState().syncedScanEventIds.length);

      // Pass1, now resumed, sees item B succeeded, then discovers at its next loop check that its token
      // is stale and stops sending further applies - but its trailing flush still runs (it has a real
      // success to report) and must MERGE into, never overwrite, whatever the replacement pass already
      // recorded.
      expectMonotonicNonDecreasing("syncedScanEventIds.length under adversarial interleaving", syncedLengths);
      expect(store.getState().syncedScanEventIds.length).toBe(3); // must NOT have shrunk to 1
      expect(store.getState().pendingSyncQueue).toHaveLength(0); // must NOT have been resurrected either
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });
});
