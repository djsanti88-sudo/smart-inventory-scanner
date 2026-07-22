// Pure decision logic for Phase 3 auto-sessions: idempotent per (account, device, time-window).
// No store, no Firebase, no React - fully deterministic given its inputs so it is trivially unit
// tested with fixed clocks (matches the createTestScanStore pinned-clock pattern used elsewhere in
// this store, see scanStore.ts:5451).
//
// Design: an auto-session is reused (not re-minted) when ALL of:
//   1. status is "active" (a completed session is NEVER auto-reused - matches the owner's explicit
//      "no session after finish, until the next auto-start" requirement; finishSession itself does
//      not clear sessionId, but ensureAutoSession's caller in scanStore.ts routes through this
//      function instead of trusting the raw currentSession/sessionId fields).
//   2. NOT locked (Phase 3 defect F1: an owner-PIN-locked session is frozen/read-only exactly like a
//      completed one - a scan arriving while it is locked must never be silently reused; it must
//      rotate to a fresh session just like the completed case, and the locked session/its counts
//      stay untouched until explicitly unlocked with the PIN).
//   3. deviceId matches the CURRENT device exactly (two devices may hold concurrent sessions by
//      design - a session auto-opened by device B must never be silently adopted by device A).
//   4. startedAt is within the inactivity window of "now" (auto-close boundary; a session idle
//      longer than the window is stale and a fresh one should auto-open instead).
// A session with NO deviceId (e.g. a manually-started legacy session, or the default boot session)
// is never auto-reused - only auto-sessions with a matching device stamp are eligible, so a manual
// session is never silently repurposed by the auto-open logic.

export interface AutoSessionCandidate {
  status: "active" | "completed";
  deviceId?: string;
  startedAt: string;
  /** Owner-PIN lock flag. A locked session is frozen/read-only and must never be auto-reused. */
  locked?: boolean;
}

export interface AutoSessionOptions {
  deviceId: string;
  nowIso: string;
  inactivityMinutes: number;
}

export function shouldReuseSession(candidate: AutoSessionCandidate, opts: AutoSessionOptions): boolean {
  if (candidate.status !== "active") return false;
  if (candidate.locked) return false;
  if (!candidate.deviceId || candidate.deviceId !== opts.deviceId) return false;
  const startedMs = Date.parse(candidate.startedAt);
  const nowMs = Date.parse(opts.nowIso);
  if (Number.isNaN(startedMs) || Number.isNaN(nowMs)) return false;
  const elapsedMinutes = (nowMs - startedMs) / 60000;
  return elapsedMinutes <= opts.inactivityMinutes;
}

/** "Jul 19, 4:00 PM" style auto-session name, per the master plan's example. */
export function buildAutoSessionName(nowIso: string): string {
  const d = new Date(nowIso);
  const datePart = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const timePart = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${datePart}, ${timePart}`;
}
