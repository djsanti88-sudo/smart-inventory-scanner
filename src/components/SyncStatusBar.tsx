"use client";

import { useScanStore } from "@/stores/scanStore";

// Shows sync health and the controls needed to prove offline-tolerant + idempotent retry behavior:
// online/offline toggle, pending count, a Retry button, a "simulate sync failure" switch (mock
// only), and the last sync error.
export function SyncStatusBar() {
  const online = useScanStore((s) => s.online);
  const pending = useScanStore((s) => s.pendingSyncQueue.length);
  const lastSyncError = useScanStore((s) => s.lastSyncError);
  const simulateSyncFailure = useScanStore((s) => s.simulateSyncFailure);
  const setOnline = useScanStore((s) => s.setOnline);
  const setSimulateSyncFailure = useScanStore((s) => s.setSimulateSyncFailure);
  const retrySync = useScanStore((s) => s.retrySync);

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-2 text-sm">
      <span className="flex items-center gap-1.5" data-testid="online-status">
        <span className={`inline-block h-2.5 w-2.5 rounded-full ${online ? "bg-green-500" : "bg-zinc-400"}`} />
        {online ? "Online" : "Offline"}
      </span>

      <span className="text-zinc-300">|</span>

      <span data-testid="pending-count">
        Pending sync: <strong className={pending > 0 ? "text-amber-700" : "text-zinc-700"}>{pending}</strong>
      </span>

      {pending > 0 && (
        <span className="text-xs text-amber-700" data-testid="pending-warning">
          Saved locally, not synced yet.
        </span>
      )}

      <button
        type="button"
        onClick={() => retrySync()}
        disabled={pending === 0}
        data-testid="retry-sync"
        className="rounded border border-zinc-300 px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-40"
      >
        Retry sync
      </button>

      <span className="ml-auto flex items-center gap-3 text-xs text-zinc-500">
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={!online}
            onChange={(e) => setOnline(!e.target.checked)}
            data-testid="toggle-offline"
          />
          Go offline
        </label>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={simulateSyncFailure}
            onChange={(e) => setSimulateSyncFailure(e.target.checked)}
            data-testid="toggle-sync-failure"
          />
          Simulate sync failure
        </label>
      </span>

      {lastSyncError && (
        <span className="w-full text-xs text-red-600" data-testid="sync-error">
          Last sync error: {lastSyncError}
        </span>
      )}
    </div>
  );
}
