import { describe, it, expect, beforeEach } from "vitest";
import { useReconcileStore, RECONCILE_PERSIST_KEY } from "@/stores/reconcileStore";
import type { AdapterResult } from "@/services/reconcile/types";
import type { MatchResult } from "@/services/reconcile/identityMatcher";
import type { ReconcileReport } from "@/services/reconcile/reconcileReport";

// Task 7 (AM-R9): ONE active expected-inventory session; re-import REPLACES (never appends);
// persists like other session state (Zustand persist); wiped by the existing "Clear local cache"
// action via the store's own clearLocalCache (same pattern as scanStore: reset state + remove its
// own localStorage key).

function adapter(rows: number, fileTag: string): AdapterResult {
  return {
    rows: Array.from({ length: rows }, (_, i) => ({
      externalId: `${fileTag}-pn-${i}`,
      partNumbers: [`${fileTag}-pn-${i}`],
      qty: i + 1,
      raw: {},
    })),
    uomReview: [],
    unparseable: [],
    assumptions: ['Quantities assumed unit "each" (no UOM column).'],
  };
}

const A_MATCH: MatchResult = {
  row: { externalId: "a-pn-0", partNumbers: ["a-pn-0"], qty: 1, raw: {} },
  status: "unmatched",
  reason: "No part-number hit and no identity match found in the corpus for this row.",
};

const A_REPORT: ReconcileReport = {
  lines: [],
  totals: {
    variance: 0, agreement: 0, expected_not_counted: 0, ambiguous: 0,
    unmatched: 1, non_tire: 0, uom_review: 0, unparseable: 0,
  },
  assumptions: [],
};

beforeEach(() => {
  window.localStorage.clear();
  useReconcileStore.getState().clearLocalCache();
});

describe("reconcileStore - one active session (AM-R9)", () => {
  it("startSession stores the import and stamps fileName/importedAt", () => {
    useReconcileStore.getState().startSession(adapter(2, "a"), "shopware-export.csv");
    const s = useReconcileStore.getState();
    expect(s.session?.fileName).toBe("shopware-export.csv");
    expect(s.session?.adapter.rows).toHaveLength(2);
    expect(s.session?.importedAt).toBeTruthy();
  });

  it("re-import REPLACES the prior session and clears stale matches/report (never appends)", () => {
    const st = useReconcileStore.getState();
    st.startSession(adapter(2, "a"), "first.csv");
    useReconcileStore.getState().setResults([A_MATCH], A_REPORT);
    expect(useReconcileStore.getState().matches).toHaveLength(1);

    useReconcileStore.getState().startSession(adapter(3, "b"), "second.csv");
    const after = useReconcileStore.getState();
    expect(after.session?.fileName).toBe("second.csv");
    expect(after.session?.adapter.rows).toHaveLength(3);
    expect(after.session?.adapter.rows[0].externalId).toBe("b-pn-0"); // no first-file rows survive
    expect(after.matches).toBeNull(); // stale results never describe the new file
    expect(after.report).toBeNull();
  });
});

describe("reconcileStore - persistence round trip", () => {
  it("state persists to its own localStorage key and rehydrates into a reset store", async () => {
    useReconcileStore.getState().startSession(adapter(1, "a"), "persisted.csv");

    const rawPersisted = window.localStorage.getItem(RECONCILE_PERSIST_KEY);
    expect(rawPersisted).toBeTruthy();
    expect(rawPersisted).toContain("persisted.csv");

    // Simulate a fresh page load: wipe the in-memory state, restore the captured disk value
    // (the wipe itself re-persists, since persist writes on every set), then rehydrate.
    useReconcileStore.setState({ session: null, matches: null, report: null });
    expect(useReconcileStore.getState().session).toBeNull();
    window.localStorage.setItem(RECONCILE_PERSIST_KEY, rawPersisted!);
    await useReconcileStore.persist.rehydrate();
    expect(useReconcileStore.getState().session?.fileName).toBe("persisted.csv");
  });
});

describe("reconcileStore - clearLocalCache (the Clear local cache wipe)", () => {
  it("resets state AND removes the persisted key", () => {
    useReconcileStore.getState().startSession(adapter(1, "a"), "wiped.csv");
    useReconcileStore.getState().setResults([A_MATCH], A_REPORT);
    expect(window.localStorage.getItem(RECONCILE_PERSIST_KEY)).toBeTruthy();

    useReconcileStore.getState().clearLocalCache();
    const s = useReconcileStore.getState();
    expect(s.session).toBeNull();
    expect(s.matches).toBeNull();
    expect(s.report).toBeNull();
    expect(window.localStorage.getItem(RECONCILE_PERSIST_KEY)).toBeNull();
  });
});
