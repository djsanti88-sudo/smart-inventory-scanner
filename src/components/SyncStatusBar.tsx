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
  const isPlatform = useIsPlatformOwner();

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-2 text-base">
      <span className="flex items-center gap-1.5" data-testid="online-status">
        <span className={`inline-block h-2.5 w-2.5 rounded-full ${online ? "bg-green-500" : "bg-zinc-400"}`} />
        {online ? "Online" : "Offline"}
      </span>

      <span className="text-zinc-300">|</span>

      <span data-testid="pending-count">
        {/* platformOwner keeps the precise "Pending sync" wording; a customer sees plain language. */}
        {isPlatform ? "Pending sync" : pending > 0 ? "Saving" : "Saved"}:{" "}
        <strong className={pending > 0 ? "text-amber-700" : "text-zinc-700"}>{pending}</strong>
      </span>

      {pending > 0 && (
        <span className="text-sm text-amber-700" data-testid="pending-warning">
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
          {/* P3: the raw technical error is platformOwner only; a customer gets a plain, non-scary message. */}
          {isPlatform ? `Last sync error: ${lastSyncError}` : "Some items haven't saved yet. Tap Try saving again."}
        </span>
      )}
    </div>
  );
}
