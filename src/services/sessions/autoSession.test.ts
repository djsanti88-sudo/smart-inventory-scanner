import { describe, it, expect } from "vitest";
import { shouldReuseSession, buildAutoSessionName, type AutoSessionCandidate } from "@/services/sessions/autoSession";

const DEVICE_A = "device-a";
const DEVICE_B = "device-b";

describe("shouldReuseSession", () => {
  it("reuses an ACTIVE session from the SAME device within the inactivity window", () => {
    const candidate: AutoSessionCandidate = { status: "active", deviceId: DEVICE_A, startedAt: "2026-07-19T16:00:00.000Z" };
    const result = shouldReuseSession(candidate, { deviceId: DEVICE_A, nowIso: "2026-07-19T16:10:00.000Z", inactivityMinutes: 30 });
    expect(result).toBe(true);
  });

  it("does NOT reuse a COMPLETED session even from the same device", () => {
    const candidate: AutoSessionCandidate = { status: "completed", deviceId: DEVICE_A, startedAt: "2026-07-19T16:00:00.000Z" };
    const result = shouldReuseSession(candidate, { deviceId: DEVICE_A, nowIso: "2026-07-19T16:10:00.000Z", inactivityMinutes: 30 });
    expect(result).toBe(false);
  });

  it("does NOT reuse a session past the inactivity window (auto-close boundary)", () => {
    const candidate: AutoSessionCandidate = { status: "active", deviceId: DEVICE_A, startedAt: "2026-07-19T16:00:00.000Z" };
    // 31 minutes later, window is 30 -> stale, must auto-close and start fresh.
    const result = shouldReuseSession(candidate, { deviceId: DEVICE_A, nowIso: "2026-07-19T16:31:00.000Z", inactivityMinutes: 30 });
    expect(result).toBe(false);
  });

  it("reuses right AT the inactivity boundary (inclusive)", () => {
    const candidate: AutoSessionCandidate = { status: "active", deviceId: DEVICE_A, startedAt: "2026-07-19T16:00:00.000Z" };
    const result = shouldReuseSession(candidate, { deviceId: DEVICE_A, nowIso: "2026-07-19T16:30:00.000Z", inactivityMinutes: 30 });
    expect(result).toBe(true);
  });

  it("does NOT reuse a DIFFERENT device's active session (two devices hold concurrent sessions by design)", () => {
    const candidate: AutoSessionCandidate = { status: "active", deviceId: DEVICE_B, startedAt: "2026-07-19T16:00:00.000Z" };
    const result = shouldReuseSession(candidate, { deviceId: DEVICE_A, nowIso: "2026-07-19T16:05:00.000Z", inactivityMinutes: 30 });
    expect(result).toBe(false);
  });

  it("does NOT reuse a session with no deviceId at all (legacy/manual session - never silently adopted)", () => {
    const candidate: AutoSessionCandidate = { status: "active", startedAt: "2026-07-19T16:00:00.000Z" };
    const result = shouldReuseSession(candidate, { deviceId: DEVICE_A, nowIso: "2026-07-19T16:05:00.000Z", inactivityMinutes: 30 });
    expect(result).toBe(false);
  });
});

describe("buildAutoSessionName", () => {
  it("formats an auto-session name as 'Mon D, h:MM AM/PM' in the local timezone", () => {
    // Fixed instant; assert only the STRUCTURE (month/day + time + AM/PM marker) to stay timezone-safe
    // in CI, since toLocaleString is host-timezone-dependent.
    const name = buildAutoSessionName("2026-07-19T16:00:00.000Z");
    expect(name).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} (AM|PM)$/);
  });
});
