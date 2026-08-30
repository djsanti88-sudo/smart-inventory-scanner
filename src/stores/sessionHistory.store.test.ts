import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { buildPersistedScanState, type PersistableScanState } from "@/stores/scanPersist";
import { SESSION_HISTORY_CAP } from "@/sessions/history/sessionHistory";

// Owner feature (approved 2026-07-22): session history. Every session that ends or rotates with at
// least one scan in it is automatically archived to `sessionHistory` BEFORE scanFeed/finalCounts are
// wiped, so the shop owner can look back at any past session without doing anything themselves.

describe("session history: archiving on session end/rotation", () => {
  it("startSession archives the just-finished session's scans into sessionHistory before wiping scanFeed", () => {
    const store = createTestScanStore({ now: () => "2026-07-22T09:00:00.000Z" });
    store.getState().startSession("Morning Count", "Bay A");
    const firstSessionId = store.getState().sessionId;
    store.getState().processScan("049000028904"); // seeded product (prod-coke)

    // Starting a SECOND session abandons/rotates the first - it must be archived, not lost.
    store.getState().startSession("Afternoon Count", "Bay A");

    const history = store.getState().sessionHistory;
    expect(history).toHaveLength(1);
    expect(history[0].sessionId).toBe(firstSessionId);
    expect(history[0].totalScans).toBe(1);
    expect(history[0].totalUnits).toBeGreaterThan(0);
    expect(history[0].scanRows[0].code).toBe("049000028904");
    // scanFeed reset still happens after archiving (existing rotation behavior unchanged).
    expect(store.getState().scanFeed).toHaveLength(0);
  });

  it("a session with zero scans is not recorded when it rotates away", () => {
    const store = createTestScanStore({ now: () => "2026-07-22T09:00:00.000Z" });
    store.getState().startSession("Empty Session", "Bay A");
    // No scans taken.
    store.getState().startSession("Next Session", "Bay A");
    expect(store.getState().sessionHistory).toHaveLength(0);
  });

  it("ensureAutoSession's rotate-on-staleness path also archives the stale session's scans", () => {
    let clock = "2026-07-22T09:00:00.000Z";
    const store = createTestScanStore({ now: () => clock });
    store.setState({ sessionId: "", currentSession: null });
    store.getState().ensureAutoSession();
    const firstSessionId = store.getState().sessionId;
    store.getState().processScan("049000028904");

    clock = "2026-07-22T09:45:00.000Z"; // past the default 30-min inactivity window
    store.getState().ensureAutoSession();

    expect(store.getState().sessionId).not.toBe(firstSessionId);
    const history = store.getState().sessionHistory;
    expect(history).toHaveLength(1);
    expect(history[0].sessionId).toBe(firstSessionId);
    expect(history[0].totalScans).toBe(1);
  });

  it("a second ended session appends a second entry, newest first", () => {
    const store = createTestScanStore({ now: () => "2026-07-22T09:00:00.000Z" });
    store.getState().startSession("First", "Bay A");
    store.getState().processScan("049000028904");
    store.getState().startSession("Second", "Bay A");
    const secondSessionId = store.getState().sessionId;
    store.getState().processScan("049000028904");
    store.getState().startSession("Third", "Bay A");

    const history = store.getState().sessionHistory;
    expect(history).toHaveLength(2);
    expect(history[0].sessionId).toBe(secondSessionId); // newest first
  });

  it("caps at SESSION_HISTORY_CAP entries, dropping the oldest", () => {
    const store = createTestScanStore({ now: () => "2026-07-22T09:00:00.000Z" });
    for (let i = 0; i < SESSION_HISTORY_CAP + 2; i++) {
      store.getState().startSession(`Session ${i}`, "Bay A");
      store.getState().processScan("049000028904");
    }
    // One more start to flush the last one into history.
    store.getState().startSession("Flush", "Bay A");
    expect(store.getState().sessionHistory.length).toBe(SESSION_HISTORY_CAP);
  });
});

describe("session history: persistence round-trip", () => {
  it("survives buildPersistedScanState round-trip at 'business' access level", () => {
    const store = createTestScanStore({ now: () => "2026-07-22T09:00:00.000Z" });
    store.getState().startSession("Morning Count", "Bay A");
    store.getState().processScan("049000028904");
    store.getState().startSession("Afternoon Count", "Bay A");

    const state = store.getState();
    const persisted = buildPersistedScanState(state as unknown as PersistableScanState, "business");
    const rehydrated = JSON.parse(JSON.stringify(persisted));
    expect(rehydrated.sessionHistory).toHaveLength(1);
    expect(rehydrated.sessionHistory[0].scanRows[0].code).toBe("049000028904");
    // No cost/price fields ever included.
    expect(rehydrated.sessionHistory[0].scanRows[0].cost).toBeUndefined();
  });

  it("survives buildPersistedScanState round-trip at 'platform' access level", () => {
    const store = createTestScanStore({ now: () => "2026-07-22T09:00:00.000Z" });
    store.getState().startSession("Morning Count", "Bay A");
    store.getState().processScan("049000028904");
    store.getState().startSession("Afternoon Count", "Bay A");

    const state = store.getState();
    const persisted = buildPersistedScanState(state as unknown as PersistableScanState, "platform");
    const rehydrated = JSON.parse(JSON.stringify(persisted));
    expect(rehydrated.sessionHistory).toHaveLength(1);
  });
});
