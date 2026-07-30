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
// Copy rule: no em dash or en dash, plain punctuation only.
export function KillSwitchBanner({ killSwitchOn }: { killSwitchOn: boolean }) {
  if (!killSwitchOn) return null;
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
