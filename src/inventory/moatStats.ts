// "X of Y identified automatically" - the moat line (master plan cross-cutting rule: "the coverage
// line is product surface, not internals"). Pure aggregation over ScanEvent.resolverStatus
// (src/types.ts:50,179). "Identified" = the deterministic resolver (or a human's later resolution)
// reached a trusted match without a guess - "known" (approved alias / verified identifier) or
// "resolved" (human-approved mapping). "suggested" (an AI suggestion awaiting approval) does NOT
// count as automatically identified - it is a candidate, not a confirmed identity, per the
// resolver-trust rule "wrong identity is failure; unknown is acceptable."
//
// B3 FIX (owner-reported burst, 2026-07-20): resolverStatus is stamped ONCE at scan time by the
// deterministic resolver and is NEVER updated when a later live decode auto-verifies the row
// (markFeedRowVerified in scanStore.ts only writes decodeStatus/provenance, by design - resolverStatus
// is the ORIGINAL resolver outcome, not a mutable decode cache). That left the header stuck at "0 of
// 268 identified automatically" while dozens of rows visibly showed "Verified (app-confirmed)". A row
// the app itself auto-verified (decodeStatus "verified" with provenance "app_verified" - the SAME
// signal the badge component treats as "Verified (app-confirmed)", see components/badges.tsx) counts
// as automatically identified even though resolverStatus never left "needs_review". A raw AI
// self-report ("ai_self_report"/"db_self_report" provenance, or any non-"verified" decodeStatus) is
// still a candidate awaiting confirmation and must NOT count - unchanged from the "suggested" rule.
export interface MoatStats {
  total: number;
  identified: number;
}

const IDENTIFIED_STATUSES = new Set(["known", "resolved"]);

interface MoatStatsEvent {
  resolverStatus: string;
  decodeStatus?: string;
  provenance?: string;
}

export function computeMoatStats(events: MoatStatsEvent[]): MoatStats {
  let identified = 0;
  for (const e of events) {
    const autoIdentified =
      IDENTIFIED_STATUSES.has(e.resolverStatus) ||
      (e.decodeStatus === "verified" && e.provenance === "app_verified");
    if (autoIdentified) identified += 1;
  }
  return { total: events.length, identified };
}
