import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { AdapterResult } from "@/services/reconcile/types";
import type { MatchResult } from "@/services/reconcile/identityMatcher";
import type { ReconcileReport } from "@/services/reconcile/reconcileReport";

// Reconcile session store (Task 7, AM-R9): exactly ONE active expected-inventory session.
// - Re-importing a file REPLACES the session (never appends) and clears stale matches/report.
// - Persists to its own localStorage key (Zustand persist), same skipHydration + explicit
//   rehydrate pattern as scanStore (see StoreHydrator.tsx).
// - clearLocalCache() mirrors scanStore's clearLocalCache contract: reset in-memory state AND
//   remove this store's own localStorage key. The Settings "Clear local cache" button calls both.
//
// This store NEVER touches products, aliases, counts, or reviews - reconcile results are a
// report, not inventory truth. Confirming a barcode linkage (AM-R6) goes through the EXISTING
// scanStore human-approval path (reopenNeedsReview + resolveUnknown "link_existing") from the UI,
// never through anything here.

export const RECONCILE_PERSIST_KEY = "sis-reconcile-v1";

export interface ReconcileSession {
  fileName: string;
  importedAt: string;
  adapter: AdapterResult;
}

interface ReconcileState {
  session: ReconcileSession | null;
  /** Server match results for session.adapter.rows; null until a match run completes. */
  matches: MatchResult[] | null;
  /** Built report for the current matches; null until a match run completes. */
  report: ReconcileReport | null;
  _hasHydrated: boolean;
  setHasHydrated: (v: boolean) => void;
  /** AM-R9: REPLACE the active session with a fresh import; stale results are dropped. */
  startSession: (adapter: AdapterResult, fileName: string) => void;
  setResults: (matches: MatchResult[], report: ReconcileReport) => void;
  /** Wipe this store's browser-local data (state + its own persisted key). Called by the
   *  existing Settings "Clear local cache" action alongside scanStore.clearLocalCache. */
  clearLocalCache: () => void;
}

export const useReconcileStore = create<ReconcileState>()(
  persist(
    (set) => ({
      session: null,
      matches: null,
      report: null,
      _hasHydrated: false,
      setHasHydrated: (v) => set({ _hasHydrated: v }),

      startSession: (adapter, fileName) =>
        set({
          session: { fileName, importedAt: new Date().toISOString(), adapter },
          matches: null,
          report: null,
        }),

      setResults: (matches, report) => set({ matches, report }),

      clearLocalCache: () => {
        // Reset state FIRST (this also persists the empty state), THEN remove the key so no
        // reconcile data survives on disk (persist writes on every set, so the reverse order
        // would immediately re-create the key with the emptied state).
        set({ session: null, matches: null, report: null });
        if (typeof window !== "undefined" && window.localStorage) {
          try {
            window.localStorage.removeItem(RECONCILE_PERSIST_KEY);
          } catch {
            // ignore - the state reset above already cleared the session for this tab
          }
        }
      },
    }),
    {
      name: RECONCILE_PERSIST_KEY,
      version: 1,
      storage: createJSONStorage(() => localStorage),
      skipHydration: true,
      partialize: (s) => ({ session: s.session, matches: s.matches, report: s.report }),
      onRehydrateStorage: () => (state) => state?.setHasHydrated(true),
    },
  ),
);
