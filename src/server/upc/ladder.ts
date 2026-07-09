// Pure decode-ladder driver. SERVER-SIDE ONLY in practice, but this module reads no env, touches no
// filesystem, and imports only the pure GTIN gate helpers - so it is fully unit-testable with stubs.
//
// The ladder is an ordered list of rungs. Each rung runs a lookup that returns a RungOutcome:
//   - settled: true  -> this rung answered (verified OR a suggestion). The ladder STOPS here; no
//                       rung below it runs (owner rule: never pay for a rung when an earlier one
//                       already produced an actionable answer).
//   - settled: false -> this rung had nothing usable (miss / unavailable / transient). The ladder
//                       continues to the next rung. Its `reason` is still recorded so the final
//                       needs_review response can list WHY every door came back empty.
//
// The route composes the concrete rungs (Go-UPC, Fetch V2, GPT-5.5) and translates the winning
// payload / accumulated reasons into its existing decode-response shape.
import { isGtinShaped, isValidCheckDigit } from "@/services/upc/gtin";

/** One rung's result. `payload` is opaque here - the caller knows its concrete shape per rung. */
export interface RungOutcome {
  /** true = this rung answered; the ladder stops. false = miss/unavailable; continue. */
  settled: boolean;
  /** Present only when settled - the rung's answer (a decode decision/results bundle). */
  payload?: unknown;
  /** ALWAYS present: a human-readable reason (accumulated for transparency + needs_review). */
  reason: string;
}

export interface LadderRung {
  name: string;
  run: () => Promise<RungOutcome>;
}

export interface LadderResult {
  /** The rung name that settled the ladder, or undefined when every rung missed. */
  settledBy?: string;
  /** The settling rung's outcome, or undefined on an all-miss ladder. */
  outcome?: RungOutcome;
  /** One entry per rung that actually RAN, in order (the settling rung is the last entry). */
  reasons: Array<{ rung: string; reason: string }>;
}

/**
 * Run rungs in order until one settles. The first settled outcome stops the ladder; every rung that
 * ran contributes its reason (in order). An all-miss ladder returns no `settledBy`/`outcome` and a
 * full reason list.
 */
export async function runLadder(_code: string, rungs: LadderRung[]): Promise<LadderResult> {
  const reasons: Array<{ rung: string; reason: string }> = [];
  for (const r of rungs) {
    const outcome = await r.run();
    reasons.push({ rung: r.name, reason: outcome.reason });
    if (outcome.settled) {
      return { settledBy: r.name, outcome, reasons };
    }
  }
  return { reasons };
}

/** The concrete rung runners the route injects (each already closed over the request + deps). */
export interface LadderRungRunners {
  runGoUpc: () => Promise<RungOutcome>;
  runFetchV2: () => Promise<RungOutcome>;
  runGpt: () => Promise<RungOutcome>;
}

/**
 * Build the ordered rung array for a code. Go-UPC is GATED to real GTINs (shape + valid GS1 check
 * digit): a vendor/ASIN/FNSKU-shaped code, or a GTIN-shaped code with a bad check digit, simply gets
 * NO Go-UPC rung in the array (the gate lives here at the caller, so runLadder stays shape-agnostic).
 * Fetch V2 then GPT always follow.
 */
export function buildLadderRungs(code: string, deps: LadderRungRunners): LadderRung[] {
  const rungs: LadderRung[] = [];
  if (isGtinShaped(code) && isValidCheckDigit(code)) {
    rungs.push({ name: "goupc", run: deps.runGoUpc });
  }
  rungs.push({ name: "fetchv2", run: deps.runFetchV2 });
  rungs.push({ name: "gpt", run: deps.runGpt });
  return rungs;
}
