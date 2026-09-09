"use client";

import { useEffect } from "react";
import { useScanStore } from "@/stores/scanStore";

// Defect 2 fix (loop2-ui report): nothing in src/ listened for the browser's real "online"/"offline"
// events, so a genuine network drop was invisible - the store's `online` flag only ever changed via the
// platform-owner "Go offline" test control (SyncStatusBar's toggle-offline checkbox). This hook wires the
// real signal to the store's EXISTING public `setOnline` action (never touches scanStore.ts internals),
// which already does the right thing on reconnect: `setOnline(true)` re-triggers `syncPending(true)` (see
// scanStore.ts ~3871-3874), draining anything queued while offline.
//
// Only reacts to genuine browser events, never to the initial `navigator.onLine` snapshot on mount. That
// keeps a manual "Go offline" override (which calls the same `setOnline` action directly) from being
// fought: nothing here fires unless the browser itself reports a real transition, so toggling the
// checkbox is never instantly undone by a stray "online" event. If a real transition DOES occur after a
// manual override, the real transition wins - which is the correct behavior a genuinely reconnected user
// needs.
export function useOnlineStatusSync(): void {
  const setOnline = useScanStore((s) => s.setOnline);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [setOnline]);
}
