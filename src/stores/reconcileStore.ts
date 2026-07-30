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

/** Fields of an ExpectedInventoryRow the report/match path actually reads (see
 *  identityMatcher.ts, reconcileReport.ts, api/reconcile/match/route.ts) - `raw` is never one of
 *  them. Used to slim the row shape persisted to localStorage. */
type PersistedRow = Pick<
  AdapterResult["rows"][number],
  "externalId" | "partNumbers" | "brand" | "model" | "sizeText" | "specs" | "qty"
>;

function stripRawFromRow(row: AdapterResult["rows"][number]): PersistedRow {
  const { externalId, partNumbers, brand, model, sizeText, specs, qty } = row;
  return { externalId, partNumbers, brand, model, sizeText, specs, qty };
}

/** Review finding (robustness): the route caps COMPUTE at MAX_ROWS but persist has no size bound.
 *  A full catalog import (thousands of rows x every non-price CSV column in `raw`) can exceed the
 *  localStorage quota. `raw` is only needed transiently during the live import -> match -> report
 *  cycle in THIS session (see route.ts isValidRow / identityMatcher.ts / reconcileReport.ts - none
 *  of them read `row.raw`); it is never read after a rehydrate, so it is dropped entirely from the
 *  persisted blob rather than merely capped. */
function stripRawForPersist(adapter: AdapterResult): AdapterResult {
  return { ...adapter, rows: adapter.rows.map(stripRawFromRow) as AdapterResult["rows"] };
}

interface ReconcileState {
  session: ReconcileSession | null;
  /** Server match results for session.adapter.rows; null until a match run completes. */
  matches: MatchResult[] | null;
  /** Built report for the current matches; null until a match run completes. */
  report: ReconcileReport | null;
  /** Opt-in, LOCAL-ONLY per-part-number unit cost map for the dollar-variance headline (M3/H1).
   *  Deliberately a SEPARATE field from `session.adapter` - session.adapter.rows is the object
   *  sent to /api/reconcile/match (see ReconcilePanel.onRunCompare); unitCosts is never read by
   *  that fetch call, so cost data structurally cannot leave the browser through it. Defaults to
   *  an empty map (feature off) until a caller opts in at import time. */
  unitCosts: Record<string, number>;
  _hasHydrated: boolean;
  setHasHydrated: (v: boolean) => void;
  /** AM-R9: REPLACE the active session with a fresh import; stale results (and any stale unit
   *  cost map from a prior file) are dropped. `unitCosts` defaults to {} when omitted. */
  startSession: (adapter: AdapterResult, fileName: string, unitCosts?: Record<string, number>) => void;
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
      unitCosts: {},
      _hasHydrated: false,
      setHasHydrated: (v) => set({ _hasHydrated: v }),

      startSession: (adapter, fileName, unitCosts) =>
        set({
          session: { fileName, importedAt: new Date().toISOString(), adapter },
          matches: null,
          report: null,
          unitCosts: unitCosts ?? {},
        }),

      setResults: (matches, report) => set({ matches, report }),

      clearLocalCache: () => {
        // Reset state FIRST (this also persists the empty state), THEN remove the key so no
        // reconcile data survives on disk (persist writes on every set, so the reverse order
        // would immediately re-create the key with the emptied state).
        set({ session: null, matches: null, report: null, unitCosts: {} });
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
      // Fail-soft storage (review finding): a full catalog import can still exceed the ~5MB
      // localStorage quota even with `raw` stripped (thousands of rows of part numbers/specs).
      // zustand's persist middleware does not itself catch a throwing storage.setItem - it
      // propagates synchronously out of every set()/store action. Wrap setItem so a
      // QuotaExceededError (or any other storage failure) degrades to "not persisted this run"
      // instead of crashing the app; the in-memory session keeps working normally.
      storage: createJSONStorage(() => ({
        getItem: (name: string) => localStorage.getItem(name),
        removeItem: (name: string) => localStorage.removeItem(name),
        setItem: (name: string, value: string) => {
          try {
            localStorage.setItem(name, value);
          } catch (err) {
            console.warn(
              `[reconcileStore] Could not persist '${name}' (storage quota or unavailable); this session's reconcile data will not survive a reload.`,
              err,
            );
          }
        },
      })),
      skipHydration: true,
      partialize: (s) => ({
        session: s.session ? { ...s.session, adapter: stripRawForPersist(s.session.adapter) } : null,
        matches: s.matches,
        report: s.report,
        // Unit costs are small (one number per SKU, no free-text columns) and are, by definition
        // of this feature, LOCAL-ONLY data the owner opted to store on this device - unlike `raw`
        // there is no quota-risk reason to strip them.
        unitCosts: s.unitCosts,
      }),
      onRehydrateStorage: () => (state) => state?.setHasHydrated(true),
    },
  ),
);
