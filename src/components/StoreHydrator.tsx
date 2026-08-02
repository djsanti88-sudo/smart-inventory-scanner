"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useScanStore } from "@/stores/scanStore";
import { getBrowserPersistenceStatus, subscribeBrowserPersistenceStatus } from "@/stores/scanPersistStorage";

// Rehydrates the persisted Zustand stores on the client only, then renders children.
// Using skipHydration + an explicit rehydrate avoids the App Router hydration mismatch where
// the server renders empty state and the client immediately swaps in localStorage data.
// Only the scan store gates rendering. Reconcile data is hydrated by ReconcileStoreHydrator on
// its route, so a large dormant reconcile session never competes with scanner startup.
export function StoreHydrator({ children }: { children: React.ReactNode }) {
  const hasHydrated = useScanStore((s) => s._hasHydrated);
  const persistenceStatus = useSyncExternalStore(subscribeBrowserPersistenceStatus, getBrowserPersistenceStatus, getBrowserPersistenceStatus);

  useEffect(() => {
    void useScanStore.getState().rehydrateActivePersistedState();
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

/** Keep reconciliation persistence off the scanner's app-wide startup path. */
export function ReconcileStoreHydrator({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    void import("@/stores/reconcileStore").then(({ useReconcileStore }) => useReconcileStore.persist.rehydrate());
  }, []);
  return <>{children}</>;
}
