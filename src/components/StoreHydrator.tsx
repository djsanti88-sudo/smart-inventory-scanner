"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useScanStore } from "@/stores/scanStore";
import { useReconcileStore } from "@/stores/reconcileStore";
import { getBrowserPersistenceStatus, subscribeBrowserPersistenceStatus } from "@/stores/scanPersistStorage";

// Rehydrates the persisted Zustand stores on the client only, then renders children.
// Using skipHydration + an explicit rehydrate avoids the App Router hydration mismatch where
// the server renders empty state and the client immediately swaps in localStorage data.
// The reconcile store follows the same pattern; only the scan store gates rendering (a slow
// reconcile rehydrate must never block scanning - the reconcile page has its own loading state).
export function StoreHydrator({ children }: { children: React.ReactNode }) {
  const hasHydrated = useScanStore((s) => s._hasHydrated);
  const persistenceStatus = useSyncExternalStore(subscribeBrowserPersistenceStatus, getBrowserPersistenceStatus, getBrowserPersistenceStatus);

  useEffect(() => {
    void useScanStore.persist.rehydrate();
    void useReconcileStore.persist.rehydrate();
  }, []);

  if (!hasHydrated) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-zinc-500">
        Loading local session...
      </div>
    );
  }
  return (
    <>
      {persistenceStatus === "degraded" && (
        <div data-testid="persistence-degraded" role="status" className="border-b border-amber-200 bg-amber-50 px-3 py-2 text-center text-xs text-amber-900">
          Saved in this tab. Durable browser storage is unavailable, so keep this tab open until you can clear space or change browser settings.
        </div>
      )}
      {children}
    </>
  );
}
