import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import type { InventoryCount } from "@/types";

// Regression (bug #34 residual, read-side counterpart to the pendingSyncQueue data-loss fix in
// sessionRotationSyncSafety.store.test.ts): startSession/ensureAutoSession used to reset
// `finalCounts: []` unconditionally on rotation. That wiped not just the just-abandoned session's
// rows but ALSO any OTHER past session's rows a prior refreshFromCloud had already merged into this
// device's finalCounts array - disabling/emptying the History page's CSV download for sessions that
// had nothing to do with the rotation, until the next refreshFromCloud call happened to re-fetch them.
// Fix: scope the prune to only the just-abandoned session's own rows (superseded by the
// sessionHistory archive captured synchronously by archiveCurrentSessionIfAny), never a blanket wipe.

function count(over: Partial<InventoryCount>): InventoryCount {
  return {
    id: "c-" + Math.random(),
    businessId: "biz-rot",
    sessionId: "session-x",
    productId: "p-x",
    quantity: 1,
    lastScannedAt: "t",
    aliasesSeen: [],
    scanEventIds: [],
    createdAt: "t",
    updatedAt: "t",
    syncStatus: "synced",
    syncError: null,
    appliedIdempotencyKeys: [],
    ...over,
  };
}

describe("session rotation finalCounts safety (bug #34 residual, 2026-08-06)", () => {
  it("startSession keeps a merged PAST session's finalCounts rows and only drops the just-abandoned session's own rows", () => {
    const store = createTestScanStore();
    const abandonedId = store.getState().currentSession?.id; // "session-1", the default active session
    expect(abandonedId).toBeTruthy();

    // Simulate: a prior refreshFromCloud already merged in a completed past session's rows,
    // plus the currently-active (about to be abandoned) session's own rows.
    store.setState({
      finalCounts: [
        count({ sessionId: "session-past-merged", productId: "p-past", quantity: 4 }),
        count({ sessionId: abandonedId!, productId: "p-active", quantity: 2 }),
      ],
    });

    store.getState().startSession("Next count", "Main");

    const after = store.getState().finalCounts;
    // The merged past session's row MUST survive the rotation untouched.
    expect(after.some((c) => c.sessionId === "session-past-merged" && c.productId === "p-past")).toBe(true);
    // Only the just-abandoned session's own rows are dropped (superseded by the sessionHistory archive).
    expect(after.some((c) => c.sessionId === abandonedId)).toBe(false);
  });

  it("ensureAutoSession (genuine rotation path) keeps a merged PAST session's finalCounts rows", () => {
    const store = createTestScanStore();
    const abandonedId = store.getState().currentSession?.id;
    expect(abandonedId).toBeTruthy();
    // Force a genuine rotation (not reuse/adopt): mark the current session locked so
    // ensureAutoSession must rotate to a fresh session rather than reusing or silently adopting
    // the existing one (shouldReuseSession and the adopt branch both bail out on locked===true;
    // see services/sessions/autoSession.ts).
    store.setState({ currentSession: { ...store.getState().currentSession!, locked: true } });

    store.setState({
      finalCounts: [
        count({ sessionId: "session-past-merged", productId: "p-past", quantity: 7 }),
        count({ sessionId: abandonedId!, productId: "p-active", quantity: 3 }),
      ],
    });

    store.getState().ensureAutoSession();

    const after = store.getState().finalCounts;
    expect(after.some((c) => c.sessionId === "session-past-merged" && c.productId === "p-past")).toBe(true);
    expect(after.some((c) => c.sessionId === abandonedId)).toBe(false);
  });
});
