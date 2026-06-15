import type { PendingSyncItem } from "@/types";
import type { SyncResult, FailureMode } from "@/services/mockDb";

// The durable-write target the scan store syncs to. MockDb (local, sync) and FirebaseSyncTarget
// (cloud/emulator, async) both satisfy this. apply() may be sync or async; the store awaits it either
// way, so the optimistic-local scan flow and idempotent retry logic are unchanged.
export interface SyncTarget {
  apply(item: PendingSyncItem): SyncResult | Promise<SyncResult>;
  setFailure(mode: FailureMode): void;
  reset(): void;
}
