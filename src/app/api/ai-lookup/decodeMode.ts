// Shared predicate for a single security/money invariant: "the daily AI cap charges ONLY paid rungs,
// exactly once per genuine compute" (CLAUDE.md Decode Ladder + Evidence Rules; LESSONS_LEARNED L12).
//
// Extracted per the 2026-08-12 invariant audit (docs/superpowers/reports/2026-08-12-invariant-audit-
// security.md, finding #2): route.ts previously computed `isDecodeMode` inline from the client-supplied
// `body.mode` string and reused that single variable at two downstream call sites - the "skip the legacy
// lookup-mode charge" gate and the "run the decode pipeline (which owns its own charge)" dispatch. Today
// that was already the SAME variable at both sites (no runtime drift existed), but nothing structurally
// stopped a future edit from reintroducing a second, independently-parsed `body.mode === "decode"`-style
// comparison at one site without updating the other - exactly the duplicate-condition shape that produced
// the L12 double-charge incident (232 charges vs ~27 genuine calls). Pulling the comparison into one
// named, unit-testable function removes that risk: there is now exactly one place that decides what a
// "decode-mode" (paid-ladder) request looks like.
//
// NO BEHAVIOR CHANGE: this is byte-identical to the inline expression it replaces.
export type AiLookupRequestMode = "lookup" | "decode" | "decode-deep";

/**
 * True when the request's `mode` selects the decode pipeline (and therefore the decode pipeline's own
 * internal charge, not the legacy lookup-mode charge at the route level). Used to gate BOTH:
 *   - skipping the legacy 'lookup' daily-cap charge, and
 *   - dispatching to `runDecodePipeline` (which owns the single charge for this path).
 * Those two decisions must always move together; this function is the one place that decides them.
 */
export function isDecodeChargeMode(mode: AiLookupRequestMode | string | undefined): boolean {
  return mode === "decode" || mode === "decode-deep";
}
