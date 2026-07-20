import type { PendingSyncItem, ScanEvent } from "@/types";
import type { SyncResult, FailureMode } from "@/services/mockDb";

// The durable-write target the scan store syncs to. MockDb (local, sync) and FirebaseSyncTarget
// (cloud/emulator, async) both satisfy this. apply() may be sync or async; the store awaits it either
// way, so the optimistic-local scan flow and idempotent retry logic are unchanged.
export interface SyncTarget {
  apply(item: PendingSyncItem): SyncResult | Promise<SyncResult>;
  setFailure(mode: FailureMode): void;
  reset(): void;
  /**
   * Phase 3: one-shot read of every ScanEvent for a session, oldest first - the source of a session
   * detail/timeline view. Optional because it is a NEW read-side capability added alongside the
   * existing write-only apply(); a SyncTarget implementation that has not been updated yet degrades
   * gracefully (callers check for its presence, per Task 8's session detail page).
   */
  getScanEventsBySession?(businessId: string, sessionId: string): ScanEvent[] | Promise<ScanEvent[]>;
}
