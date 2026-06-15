"use client";

import { useEffect } from "react";
import { useScanStore } from "@/stores/scanStore";

// Rehydrates the persisted Zustand store on the client only, then renders children.
// Using skipHydration + an explicit rehydrate avoids the App Router hydration mismatch where
// the server renders empty state and the client immediately swaps in localStorage data.
export function StoreHydrator({ children }: { children: React.ReactNode }) {
  const hasHydrated = useScanStore((s) => s._hasHydrated);

  useEffect(() => {
    void useScanStore.persist.rehydrate();
  }, []);

  if (!hasHydrated) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-zinc-500">
        Loading local session...
      </div>
    );
  }
  return <>{children}</>;
}
