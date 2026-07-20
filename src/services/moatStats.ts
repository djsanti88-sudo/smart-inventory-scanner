// "X of Y identified automatically" - the moat line (master plan cross-cutting rule: "the coverage
// line is product surface, not internals"). Pure aggregation over ScanEvent.resolverStatus
// (src/types.ts:50,179). "Identified" = the deterministic resolver (or a human's later resolution)
// reached a trusted match without a guess - "known" (approved alias / verified identifier) or
// "resolved" (human-approved mapping). "suggested" (an AI suggestion awaiting approval) does NOT
// count as automatically identified - it is a candidate, not a confirmed identity, per the
// resolver-trust rule "wrong identity is failure; unknown is acceptable."
export interface MoatStats {
  total: number;
  identified: number;
}

const IDENTIFIED_STATUSES = new Set(["known", "resolved"]);

export function computeMoatStats(events: Array<{ resolverStatus: string }>): MoatStats {
  let identified = 0;
  for (const e of events) {
    if (IDENTIFIED_STATUSES.has(e.resolverStatus)) identified += 1;
  }
  return { total: events.length, identified };
}
