import { describe, it, expect, beforeEach, vi } from "vitest";
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

describe("reconcileStore - persisted blob is bounded (review finding: raw stripped, quota fails soft)", () => {
  it("persisted payload does NOT contain the heavy `raw` field from adapter rows", () => {
    const withRaw = adapter(2, "a");
    withRaw.rows[0].raw = { color: "black", warehouse: "12", note: "some long descriptive column value" };
    withRaw.rows[1].raw = { color: "white", warehouse: "7", note: "another long descriptive column value" };

    useReconcileStore.getState().startSession(withRaw, "heavy.csv");

    const rawPersisted = window.localStorage.getItem(RECONCILE_PERSIST_KEY);
    expect(rawPersisted).toBeTruthy();
    // None of the raw column values leaked into the persisted blob.
    expect(rawPersisted).not.toContain("warehouse");
    expect(rawPersisted).not.toContain("some long descriptive column value");

    const parsed = JSON.parse(rawPersisted!);
    const persistedRows = parsed.state.session.adapter.rows as Array<Record<string, unknown>>;
    for (const row of persistedRows) {
      expect(row.raw).toBeUndefined();
    }
    // The fields the report/match actually need must survive.
    expect(persistedRows[0].externalId).toBe("a-pn-0");
    expect(persistedRows[0].partNumbers).toEqual(["a-pn-0"]);
    expect(persistedRows[0].qty).toBe(1);
  });

  it("a storage whose setItem throws QuotaExceededError does not throw out of startSession (fail soft)", () => {
    // jsdom's Storage#setItem lives on the prototype, not as an own property of the localStorage
    // instance - spying on the instance creates a shadowing own-property that jsdom's internal
    // dispatch never reaches. Spy on the prototype so the real call path is actually exercised,
    // the same method every write in the app goes through.
    const quotaError = new DOMException("Quota exceeded", "QuotaExceededError");
    const proto = Object.getPrototypeOf(window.localStorage);
    const setItemSpy = vi.spyOn(proto, "setItem").mockImplementation(() => {
      throw quotaError;
    });

    try {
      expect(() => {
        useReconcileStore.getState().startSession(adapter(1, "a"), "quota.csv");
      }).not.toThrow();
      // The in-memory store still works this run even though persistence failed.
      expect(useReconcileStore.getState().session?.fileName).toBe("quota.csv");
    } finally {
      setItemSpy.mockRestore();
    }
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
