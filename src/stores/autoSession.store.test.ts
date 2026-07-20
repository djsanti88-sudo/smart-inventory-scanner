import { describe, it, expect, vi } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";

describe("ensureAutoSession", () => {
  it("auto-opens a session with an auto-generated name and deviceId stamp when none is active for this device", () => {
    const store = createTestScanStore({ now: () => "2026-07-19T16:00:00.000Z" });
    // Simulate a signed-out-then-fresh-boot state with no session (mirrors resetForSignOut's sessionId: "").
    store.setState({ sessionId: "", currentSession: null });
    store.getState().ensureAutoSession();
    const session = store.getState().currentSession;
    expect(session).not.toBeNull();
    expect(session!.status).toBe("active");
    expect(session!.deviceId).toBeTruthy();
    expect(session!.name).toMatch(/\d{1,2}:\d{2}\s*(AM|PM)/i);
  });

  it("is idempotent: calling twice in a row does NOT mint a second session", () => {
    const store = createTestScanStore({ now: () => "2026-07-19T16:00:00.000Z" });
    store.setState({ sessionId: "", currentSession: null });
    store.getState().ensureAutoSession();
    const firstId = store.getState().sessionId;
    store.getState().ensureAutoSession();
    expect(store.getState().sessionId).toBe(firstId);
  });

  it("auto-opens a FRESH session once the inactivity window has elapsed (auto-close)", () => {
    let clock = "2026-07-19T16:00:00.000Z";
    const store = createTestScanStore({ now: () => clock });
    store.setState({ sessionId: "", currentSession: null });
    store.getState().ensureAutoSession();
    const firstId = store.getState().sessionId;
    clock = "2026-07-19T16:45:00.000Z"; // 45 min later, default inactivity window is 30
    store.getState().ensureAutoSession();
    expect(store.getState().sessionId).not.toBe(firstId);
    expect(store.getState().currentSession!.status).toBe("active");
  });

  it("does NOT auto-reuse a manually finished session (finishSession does not clear sessionId, but ensureAutoSession must not stamp new scans onto it)", () => {
    const store = createTestScanStore({ now: () => "2026-07-19T16:00:00.000Z" });
    store.getState().startSession("Manual", "Main");
    store.getState().finishSession();
    const completedId = store.getState().sessionId;
    store.getState().ensureAutoSession();
    expect(store.getState().sessionId).not.toBe(completedId);
    expect(store.getState().currentSession!.status).toBe("active");
  });

  it("processScan on a completed session (before ensureAutoSession runs) is blocked, matching the locked-session guard shape", () => {
    const store = createTestScanStore({ now: () => "2026-07-19T16:00:00.000Z" });
    store.getState().startSession("Manual", "Main");
    store.getState().finishSession();
    // Without an explicit ensureAutoSession call, a scan must not silently land in the completed session.
    const result = store.getState().processScan("012345678905");
    expect(result).toBeNull();
  });
});
