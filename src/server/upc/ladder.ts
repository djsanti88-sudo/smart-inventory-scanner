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

/** Optional request-scoped budget (L2, owner-reported 36-70s blocking decodes, AM-1). Fully
 *  backward compatible: omit `opts` entirely and behavior is byte-for-byte identical to before. */
export interface RunLadderOpts {
  /** Absolute timestamp (same clock as `now`). No rung may START at or after this instant. */
  deadlineAt?: number;
  /** Clock override for tests. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Run rungs in order until one settles. The first settled outcome stops the ladder; every rung that
 * ran contributes its reason (in order). An all-miss ladder returns no `settledBy`/`outcome` and a
 * full reason list.
 *
 * L2 (owner-reported 36-70s blocking decodes, AM-1): when `opts.deadlineAt` is passed, the deadline
 * is checked BEFORE each rung starts - never mid-flight. A rung already running is NEVER aborted
 * here (each rung owns its own internal timeout); this only stops NEW rungs from starting once the
 * request-scoped budget is spent. Every skipped rung still records an honest reason so the
 * needs_review response can say exactly why it never got a full answer.
 */
export async function runLadder(_code: string, rungs: LadderRung[], opts: RunLadderOpts = {}): Promise<LadderResult> {
  const now = opts.now ?? Date.now;
  const reasons: Array<{ rung: string; reason: string }> = [];
  for (const r of rungs) {
    if (opts.deadlineAt !== undefined && now() >= opts.deadlineAt) {
      reasons.push({ rung: r.name, reason: "skipped: ladder deadline reached (DECODE_LADDER_TOTAL_MS)" });
      continue;
    }
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
  runUpcItemDb: () => Promise<RungOutcome>;
  runOpenFoodFacts: () => Promise<RungOutcome>;
  runGoUpc: () => Promise<RungOutcome>;
  runFetchV2: () => Promise<RungOutcome>;
  runGpt: () => Promise<RungOutcome>;
}

/**
 * The FREE half of the ladder: UPCitemdb then Open Food Facts, both GATED to real GTINs (shape +
 * valid GS1 check digit). Neither rung ever touches the paid daily AI-lookup cap - each owns its
 * own local usage counter (see UpcItemDbProvider.ts / OpenFoodFactsProvider.ts). A vendor/ASIN/
 * FNSKU-shaped code, or a GTIN-shaped code with a bad check digit, gets an EMPTY array here (same
 * gate Go-UPC uses in buildPaidLadderRungs, kept in one place per builder so callers never need to
 * duplicate the GTIN check).
 *
 * Bug fix (2026-07-12, controller-ratified): this half MUST run via runLadder() on its own,
 * BEFORE any interaction with the paid daily cap - see pipeline.ts's two-phase call. Previously
 * these rungs ran inside the same buildLadderRungs() array as the paid rungs, AFTER the cap was
 * already unconditionally charged (or after an exhausted cap had already thrown), so a free-rung
 * resolution still burned a paid slot and an exhausted cap blocked the free rungs from ever
 * running. Splitting the builder is what makes the free/paid separation possible at the call site.
 *
 * Order for a valid GTIN: ["upcitemdb", "openfoodfacts"]. Order for a non-GTIN: [].
 */
export function buildFreeLadderRungs(code: string, deps: Pick<LadderRungRunners, "runUpcItemDb" | "runOpenFoodFacts">): LadderRung[] {
  const rungs: LadderRung[] = [];
  if (isGtinShaped(code) && isValidCheckDigit(code)) {
    rungs.push({ name: "upcitemdb", run: deps.runUpcItemDb });
    rungs.push({ name: "openfoodfacts", run: deps.runOpenFoodFacts });
  }
  return rungs;
}

/**
 * The PAID half of the ladder: Go-UPC (GTIN-gated, same check-digit gate as the free rungs) then
 * Fetch V2 then GPT-5.5, for every code. The caller (pipeline.ts) charges the paid daily cap slot
 * immediately before running this half - never inside runLadder itself.
 *
 * Order for a valid GTIN: ["goupc", "fetchv2", "gpt"]. Order for a non-GTIN: ["fetchv2", "gpt"].
 */
export function buildPaidLadderRungs(code: string, deps: Pick<LadderRungRunners, "runGoUpc" | "runFetchV2" | "runGpt">): LadderRung[] {
  const rungs: LadderRung[] = [];
  if (isGtinShaped(code) && isValidCheckDigit(code)) {
    rungs.push({ name: "goupc", run: deps.runGoUpc });
  }
  rungs.push({ name: "fetchv2", run: deps.runFetchV2 });
  rungs.push({ name: "gpt", run: deps.runGpt });
  return rungs;
}

/**
 * COMPATIBILITY WRAPPER: the full free+paid ladder in one array, in the original combined order.
 * No production caller uses this anymore (pipeline.ts now calls buildFreeLadderRungs and
 * buildPaidLadderRungs separately so it can charge the paid cap only between the two halves) -
 * kept for any other caller (and existing tests) that still wants the single-array shape.
 *
 * Final order for a valid GTIN: ["upcitemdb", "openfoodfacts", "goupc", "fetchv2", "gpt"].
 * Final order for a non-GTIN: ["fetchv2", "gpt"].
 */
export function buildLadderRungs(code: string, deps: LadderRungRunners): LadderRung[] {
  return [...buildFreeLadderRungs(code, deps), ...buildPaidLadderRungs(code, deps)];
}
