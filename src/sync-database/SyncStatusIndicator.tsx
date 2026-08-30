"use client";

import { useScanStore } from "@/stores/scanStore";
import { useOnlineStatusSync } from "@/sync-database/useOnlineStatusSync";

// Defect 1 fix (loop2-ui report, UI2-1): SyncStatusBar - the only surface showing offline state, pending
// count, "Saved locally, not synced yet", and the Retry button - lives inside a <details> that stays
// COLLAPSED by default for every real user (scan/page.tsx's expandSecondary is only true under the
// Playwright E2E webServer, never in production). A shop worker on a flaky connection could see
// confident, correctly-rendered quantities everywhere with no above-the-fold cue that some of them had
// not synced yet.
//
// This component is that above-the-fold cue. It renders NOTHING when everything is healthy (online, no
// pending items, no sync error) so it never adds clutter to the core scan loop - the product's whole
// point is fast scanning, and a permanent banner in the normal case would be noise. It speaks up only
// when there is something honest to report, and gives a Retry action right there so a real user never
// has to find "Sessions and export" to act on it.
export function SyncStatusIndicator() {
  useOnlineStatusSync();

  const online = useScanStore((s) => s.online);
  const pending = useScanStore(
    (s) => s.pendingSyncQueue.filter((item) => item.businessId === s.businessId).length,
  );
  const lastSyncError = useScanStore((s) => s.lastSyncError);
  const retrySync = useScanStore((s) => s.retrySync);

  const hasIssue = !online || pending > 0 || Boolean(lastSyncError);
  if (!hasIssue) return null;

  const label = !online
    ? "Offline. Scans are saved locally and will sync when you're back online."
    : lastSyncError
      ? "Some items have not saved yet."
      : "Saving...";

  return (
    <div
      data-testid="sync-status-indicator"
      role="status"
      className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
    >
      <span
        className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${online ? "bg-amber-500" : "bg-zinc-400"}`}
        aria-hidden="true"
      />
      <span data-testid="sync-status-indicator-label">{label}</span>
      {pending > 0 && (
        <span data-testid="sync-status-indicator-pending" className="font-medium">
          {pending} not synced yet
        </span>
      )}
      {(pending > 0 || lastSyncError) && (
        <button
          type="button"
          data-testid="sync-status-indicator-retry"
          onClick={() => retrySync()}
          className="ml-auto inline-flex min-h-[36px] items-center rounded-lg border border-amber-400 bg-white px-3 text-sm font-medium text-amber-900 hover:bg-amber-100"
        >
          Try saving again
        </button>
      )}
    </div>
  );
}
