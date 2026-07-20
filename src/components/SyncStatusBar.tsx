"use client";

import { useScanStore } from "@/stores/scanStore";
import { useIsPlatformOwner } from "@/services/security/useAccessLevel";

// Shows sync health and the controls needed to prove offline-tolerant + idempotent retry behavior:
// online/offline toggle, pending count, a Retry button, a "simulate sync failure" switch (mock
// only), and the last sync error. The offline / simulate-failure switches are DEV/diagnostic controls,
// shown only to the platform owner - a customer sees plain status + a Retry button and nothing scary.
export function SyncStatusBar() {
  const online = useScanStore((s) => s.online);
  const pending = useScanStore((s) => s.pendingSyncQueue.length);
  const lastSyncError = useScanStore((s) => s.lastSyncError);
  const simulateSyncFailure = useScanStore((s) => s.simulateSyncFailure);
  const setOnline = useScanStore((s) => s.setOnline);
  const setSimulateSyncFailure = useScanStore((s) => s.setSimulateSyncFailure);
  const retrySync = useScanStore((s) => s.retrySync);
  const refreshFromCloud = useScanStore((s) => s.refreshFromCloud);
  const isPlatform = useIsPlatformOwner();

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-2 text-base">
      <span className="flex items-center gap-1.5" data-testid="online-status">
        <span className={`inline-block h-2.5 w-2.5 rounded-full ${online ? "bg-green-500" : "bg-zinc-400"}`} aria-hidden="true" />
        {online ? "Online" : "Offline"}
      </span>

      <span className="h-4 w-px self-center bg-zinc-200" aria-hidden="true" />

      <span data-testid="pending-count">
        {isPlatform ? "Waiting to save" : pending > 0 ? "Saving" : "All saved"}:{" "}
        <strong className={pending > 0 ? "text-amber-700" : "text-zinc-700"}>{pending}</strong>
      </span>

      {pending > 0 && (
        <span className="text-sm text-amber-900" data-testid="pending-warning">
          Saved locally, not synced yet.
        </span>
      )}

      <button
        type="button"
        onClick={() => retrySync()}
        disabled={pending === 0}
        data-testid="retry-sync"
        className="inline-flex min-h-[44px] items-center rounded-lg border border-zinc-300 px-4 text-base font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-40"
      >
        Try saving again
      </button>

      <button
        type="button"
        data-testid="refresh-from-cloud"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void refreshFromCloud()}
        className="inline-flex min-h-[36px] items-center rounded-lg border border-zinc-300 px-3 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
      >
        Refresh
      </button>

      {isPlatform && (
        <span className="ml-auto flex items-center gap-3 text-sm text-zinc-600">
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={!online}
              onChange={(e) => setOnline(!e.target.checked)}
              data-testid="toggle-offline"
            />
            Go offline
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={simulateSyncFailure}
              onChange={(e) => setSimulateSyncFailure(e.target.checked)}
              data-testid="toggle-sync-failure"
            />
            Simulate sync failure
          </label>
        </span>
      )}

      {lastSyncError && (
        <span className="w-full text-sm text-red-600" data-testid="sync-error">
          {isPlatform ? `Last save error: ${lastSyncError}` : "Some items haven't saved yet. Tap Try saving again."}
        </span>
      )}
    </div>
  );
}
