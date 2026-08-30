import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/sync-database/mock/mockDb";

// Phase 3 defect F1 (TOP-LEVEL LAW: "every scan appears and counts"): processScan hard-returned
// null when the current session was locked or completed. ensureAutoSession only runs on scan-page
// mount, so any scan taken AFTER Finish or Lock (without a page remount) was silently dropped - no
// feed row, no count. Required fix: rotate to a fresh ACTIVE session and count the scan there,
// leaving the frozen (completed/locked) session's own counts untouched.
//
// Note: this store's live `finalCounts`/`scanFeed`/`needsReviewQueue` fields are a window into the
// CURRENTLY DISPLAYED session only (see reopenSession, ensureAutoSession's fresh-mint branch) - they
// are intentionally reset on every session switch. The durable source of truth for a session no
// longer displayed is the synced backend (MockDb.getServerCount/getSessionCounts here), which these
// tests assert against to prove the old session's counts are truly untouched by the rotation.

describe("processScan after Finish (completed session) rotates instead of dropping the scan", () => {
  it("finish-then-scan: the scan appears in the feed and counts, in a NEW active session; the old completed session's synced counts stay unchanged", () => {
    const db = new MockDb();
    const store = createTestScanStore({ db, now: () => "2026-07-20T10:00:00.000Z" });
    // Seed a known scan into the original ("session-1") session, then finish it.
    store.getState().processScan("049000028904"); // known Coke code from the fixture set
    const finishedSessionId = store.getState().sessionId;
    const finishedCountBefore = db.getServerCount(finishedSessionId, "prod-coke");
    expect(finishedCountBefore?.quantity).toBe(1);
    store.getState().finishSession();
    expect(store.getState().currentSession?.status).toBe("completed");

    // A physical scan arrives AFTER Finish, with no intervening ensureAutoSession/page mount.
    const result = store.getState().processScan("049000028904");

    // Per the TOP-LEVEL LAW, the scan must appear and count - never be dropped.
    expect(result).not.toBeNull();
    const state = store.getState();
    expect(state.scanFeed[0]?.cleanCode).toBe("049000028904");

    // It must land in a NEW active session, not reopen/mutate the finished one.
    const newSessionId = state.sessionId;
    expect(newSessionId).not.toBe(finishedSessionId);
    expect(state.currentSession?.status).toBe("active");
    expect(state.currentSession?.locked).toBeFalsy();

    // The new session's count must reflect the post-finish scan.
    const newSessionCount = state.finalCounts.find((c) => c.sessionId === newSessionId);
    expect(newSessionCount).toBeDefined();
    expect(newSessionCount?.quantity).toBe(1);

    // The OLD finished session's own synced count is frozen - untouched by the rotation.
    const finishedCountAfter = db.getServerCount(finishedSessionId, "prod-coke");
    expect(finishedCountAfter?.quantity).toBe(1);
    const finishedSessionRecord = db.getSession(finishedSessionId);
    expect(finishedSessionRecord?.status).toBe("completed");
  });
});

describe("processScan after Lock rotates instead of dropping the scan", () => {
  it("lock-then-scan: the scan appears in the feed and counts, in a NEW active session; the locked session stays locked and frozen", async () => {
    const db = new MockDb();
    const store = createTestScanStore({ db, now: () => "2026-07-20T10:00:00.000Z" });
    await store.getState().setOwnerPin("1234");
    store.getState().processScan("049000028904"); // seed a known scan first
    const lockedSessionId = store.getState().currentSession!.id;
    const lockedCountBefore = db.getServerCount(lockedSessionId, "prod-coke");
    expect(lockedCountBefore?.quantity).toBe(1);

    expect(store.getState().lockSession(lockedSessionId)).toBe(true);
    expect(store.getState().currentSession?.locked).toBe(true);

    // A physical scan arrives while the session is still locked.
    const result = store.getState().processScan("049000028904");

    expect(result).not.toBeNull();
    const state = store.getState();
    expect(state.scanFeed[0]?.cleanCode).toBe("049000028904");

    const newSessionId = state.sessionId;
    expect(newSessionId).not.toBe(lockedSessionId);
    expect(state.currentSession?.status).toBe("active");
    expect(state.currentSession?.locked).toBeFalsy();

    const newSessionCount = state.finalCounts.find((c) => c.sessionId === newSessionId);
    expect(newSessionCount).toBeDefined();
    expect(newSessionCount?.quantity).toBe(1);

    // The old locked session stays locked and its synced count is frozen (never mutated/unlocked).
    const lockedCountAfter = db.getServerCount(lockedSessionId, "prod-coke");
    expect(lockedCountAfter?.quantity).toBe(1);
    const lockedSessionRecord = db.getSession(lockedSessionId);
    expect(lockedSessionRecord?.locked).toBe(true);
  });

  it("multiple scans after lock all land in the SAME rotated session (rotation itself is idempotent within the window)", async () => {
    const store = createTestScanStore({ now: () => "2026-07-20T10:00:00.000Z" });
    await store.getState().setOwnerPin("1234");
    const lockedSessionId = store.getState().currentSession!.id;
    expect(store.getState().lockSession(lockedSessionId)).toBe(true);

    store.getState().processScan("049000028904");
    const firstRotatedId = store.getState().sessionId;
    expect(firstRotatedId).not.toBe(lockedSessionId);

    store.getState().processScan("6419440485331");
    const secondRotatedId = store.getState().sessionId;
    expect(secondRotatedId).toBe(firstRotatedId); // second scan reuses the same rotated session

    expect(store.getState().scanFeed).toHaveLength(2);
  });
});

describe("processScan internal caller (resolveUnknown re-apply) also rotates instead of dropping", () => {
  // resolveUnknown's applyToCount branch (scanStore.ts ~line 4861) calls processScan directly ONLY
  // when there is no provisional placeholder row left to transfer onto the linked product (the
  // normal case merges the placeholder's existing count instead, via transferOrphanCount, and
  // correctly does NOT re-invoke processScan to avoid a double count). Engineer that exact case: link
  // an unknown review to an EXISTING product after its own provisional placeholder has already been
  // removed, so resolveUnknown falls through to its literal processScan(...) call - the one internal
  // caller the F1 brief calls out - and prove IT rotates too, instead of silently dropping the count.
  it("applyToCount re-invokes processScan internally (no orphan to transfer) and must not silently drop a post-finish confirmation", () => {
    const store = createTestScanStore({ now: () => "2026-07-20T10:00:00.000Z" });
    store.getState().processScan("UNKNOWN-F1-TEST");
    const review = store.getState().needsReviewQueue.find((r) => r.cleanCode === "UNKNOWN-F1-TEST");
    expect(review).toBeDefined();
    const provisionalId = review!.provisionalProductId;
    expect(provisionalId).toBeTruthy();

    // Remove the provisional placeholder's product + count so resolveUnknown finds no orphan to
    // transfer, forcing its applyToCount branch down the literal processScan(...) call.
    store.setState((s) => ({
      products: s.products.filter((p) => p.id !== provisionalId),
      finalCounts: s.finalCounts.filter((c) => c.productId !== provisionalId),
    }));

    // Finish the session AFTER the scan lands in review but BEFORE the human resolves it.
    store.getState().finishSession();
    const finishedSessionId = store.getState().sessionId;
    expect(store.getState().currentSession?.status).toBe("completed");

    // Human resolution links to a pre-existing product with applyToCount - with no orphan to
    // transfer, this falls through to the internal processScan(...) call. It must count in a
    // rotated session, not silently no-op because the session is completed.
    store.getState().resolveUnknown(review!.id, "link_existing", {
      productId: "prod-coke",
      applyToCount: true,
    });

    const state = store.getState();
    expect(state.sessionId).not.toBe(finishedSessionId);
    expect(state.currentSession?.status).toBe("active");
    const newSessionCount = state.finalCounts.find((c) => c.sessionId === state.sessionId && c.productId === "prod-coke");
    expect(newSessionCount).toBeDefined();
    expect(newSessionCount!.quantity).toBeGreaterThan(0);
  });
});
