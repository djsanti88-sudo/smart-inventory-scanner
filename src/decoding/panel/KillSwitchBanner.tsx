"use client";

// Spec 2 (M1, kill-switch visibility): the POST /api/ai-lookup handler already 503s every request
// when the SERVER kill switch (AI_LOOKUP_KILL_SWITCH env var) is on, but until now the GET status
// endpoint Settings polls never reported it, so a shop owner had no way to know why every scan's
// identity lookup was failing - aiStatus.missingKeys stayed empty and liveEnabled stayed true.
// This is a DIFFERENT flag from aiStatus.emergencyStop: emergencyStop is a CLIENT preference the
// shop owner toggles themselves (Settings' "Emergency stop" toggle); killSwitchOn is a SERVER
// operator control the shop owner cannot turn off. Per the TOP-LEVEL LAW, every scan still appears
// and counts even with the kill switch on - only identity lookup pauses - so the copy must say that,
// not imply scanning itself is broken.
// Silent-failure fix (review of 92e9c32c): `statusUnknown` is true when the last refreshAiStatus()
// could not confirm the server's kill-switch state (fetch failed, or the GET response was not ok).
// A false killSwitchOn must never be read as "confirmed off" in that case - render a muted note
// instead of silently showing nothing, which would look identical to a confirmed-safe state.
// Copy rule: no em dash or en dash, plain punctuation only.
export function KillSwitchBanner({
  killSwitchOn,
  statusUnknown,
}: {
  killSwitchOn: boolean;
  statusUnknown?: boolean;
}) {
  if (killSwitchOn) {
    return (
      <div
        className="rounded-lg border-2 border-red-600 bg-red-50 p-3 text-sm font-medium text-red-900"
        data-testid="kill-switch-banner"
        role="alert"
      >
        AI lookup is emergency-stopped by the kill switch. Scans still count, unknowns go to Needs
        Review.
      </div>
    );
  }
  if (statusUnknown) {
    return (
      <div
        className="rounded-lg border border-gray-300 bg-gray-50 p-3 text-sm text-gray-600"
        data-testid="kill-switch-status-unknown"
        role="status"
      >
        AI status unavailable. Could not confirm the server kill switch state. Scans still count.
      </div>
    );
  }
  return null;
}
