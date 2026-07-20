import { describe, it, expect, vi } from "vitest";
import { DEVICE_ID_KEY } from "@/services/deviceIdentity";
import { createTestScanStore } from "@/stores/scanStore";
import type { PendingSyncItem, ScanEvent } from "@/types";

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

  it("preserves unsynced scans when a stale device-owned session rotates", () => {
    const nowIso = "2026-07-19T16:00:00.000Z";
    const oldSessionId = "session-old-device-owned";
    const deviceId = "device-current";
    const scanEventId = "scan-unsynced-1";
    window.localStorage.setItem(DEVICE_ID_KEY, deviceId);

    const pendingItem: PendingSyncItem = {
      id: "queue-unsynced-scan-1",
      businessId: "demo-business",
      sessionId: oldSessionId,
      entityType: "ScanEvent",
      entityId: scanEventId,
      operation: "SAVE_SCAN_EVENT",
      payload: {
        id: scanEventId,
        businessId: "demo-business",
        sessionId: oldSessionId,
        rawCode: "012345678905",
        cleanCode: "012345678905",
        normalizedCandidates: ["012345678905"],
        matchedProductId: "p-good",
        matchType: "upc",
        status: "known",
        resolverStatus: "known",
        codeType: "upc_a",
        reason: "Approved alias match",
        quantityDelta: 1,
        quantityAfterScan: 1,
        createdAt: "2026-07-19T15:20:00.000Z",
        source: "scan",
        notes: "",
        syncStatus: "pending",
        syncError: null,
        idempotencyKey: "idem-unsynced-scan-1",
        deviceId,
        location: "Main",
      } satisfies ScanEvent,
      status: "pending",
      retryCount: 0,
      lastError: null,
      createdAt: "2026-07-19T15:20:00.000Z",
      updatedAt: "2026-07-19T15:20:00.000Z",
      idempotencyKey: "idem-save-unsynced-scan-1",
      scanEventId,
    };

    const store = createTestScanStore({ now: () => nowIso });
    store.getState().setOnline(false);
    store.setState({
      sessionId: oldSessionId,
      currentSession: {
        id: oldSessionId,
        businessId: "demo-business",
        name: "Auto Count 11:15 AM",
        location: "Main",
        status: "active",
        startedAt: "2026-07-19T15:15:00.000Z",
        completedAt: null,
        createdBy: "demo",
        notes: "",
        syncStatus: "pending",
        locked: false,
        lockedAt: null,
        deviceId,
      },
      pendingSyncQueue: [pendingItem],
    });

    store.getState().ensureAutoSession();

    const state = store.getState();
    expect(state.sessionId).not.toBe(oldSessionId);
    expect(state.currentSession?.deviceId).toBe(deviceId);
    expect(state.pendingSyncQueue).toContainEqual(pendingItem);
    expect((pendingItem.payload as ScanEvent).sessionId).toBe(oldSessionId);
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

  it("ADOPTS an unclaimed active in-window session (no deviceId) and PRESERVES its counts instead of rotating", () => {
    // Regression: a hydrated pre-Phase-3 / mock session has no deviceId. On scan-page mount
    // ensureAutoSession must claim it for this device and keep its finalCounts, not open a fresh
    // session and wipe the visible in-progress count (caught by e2e cleanup.spec).
    const store = createTestScanStore({ now: () => "2026-07-19T16:00:00.000Z" });
    store.setState({
      sessionId: "session-legacy",
      currentSession: {
        id: "session-legacy", businessId: "demo-business", name: "Default Session", location: "Main",
        status: "active", startedAt: "2026-07-19T15:55:00.000Z", completedAt: null, createdBy: "demo",
        notes: "", syncStatus: "synced",
      } as never,
      finalCounts: [{ productId: "p-good", quantity: 3 } as never],
    });
    store.getState().ensureAutoSession();
    const s = store.getState();
    expect(s.currentSession!.id).toBe("session-legacy"); // adopted, NOT rotated to a new id
    expect(s.currentSession!.deviceId).toBeTruthy(); // now claimed by this device
    expect(s.currentSession!.name).not.toBe("Default Session"); // boot placeholder must not leak to UI
    expect(s.currentSession!.name).toMatch(/\d{1,2}:\d{2}\s*(AM|PM)/i); // renamed to a real auto-session name
    expect(s.finalCounts).toHaveLength(1); // counts preserved, NOT wiped
    expect(s.finalCounts[0].quantity).toBe(3);
  });
});
