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

export interface RunLadderContext {
  /** Aborts when this rung exceeds its per-rung timeout OR the total wall-clock ceiling. */
  signal: AbortSignal;
}

export interface LadderRung {
  name: string;
  run: (ctx: RunLadderContext) => Promise<RungOutcome>;
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
  /** Per-rung hard timeout (ms). A rung that does not settle within this window (or before the total
   *  deadlineAt, whichever is sooner) is abandoned: its AbortController fires, an "aborted" reason is
   *  recorded, and the ladder moves on or settles best-so-far. NOTE the honest scope: the LADDER stops
   *  waiting - the rung's own underlying fetch may keep running server-side until its provider-level
   *  timeout (signal threading into every provider fetch is a deferred follow-up). Omit BOTH this and
   *  deadlineAt for the legacy unbounded behavior. */
  perRungTimeoutMs?: number;
}

/** Internal sentinel used ONLY to mark the budget-timer rejection in runLadder's Promise.race, so the
 *  catch block can tell "the ladder gave up waiting" apart from a genuine exception thrown by r.run()
 *  itself. Never thrown by rung code - a rung's own errors are plain Error (or whatever it throws). */
class LadderRungTimeoutError extends Error {
  constructor() {
    super("ladder-rung-timeout");
    this.name = "LadderRungTimeoutError";
  }
}

/**
 * Run rungs in order until one settles. The first settled outcome stops the ladder; every rung that
 * ran contributes its reason (in order). An all-miss ladder returns no `settledBy`/`outcome` and a
 * full reason list.
 *
 * L2 (owner-reported 36-70s blocking decodes, AM-1): when `opts.deadlineAt` is passed, the deadline
 * is checked BEFORE each rung starts - never mid-flight. Every skipped rung still records an honest
 * reason so the needs_review response can say exactly why it never got a full answer.
 *
 * D7 (owner-reported 36-70s blocking decodes, same class as L2 but for a rung already in flight): a
 * started rung is raced against an AbortController that fires at min(perRungTimeoutMs, remaining
 * wall-clock to deadlineAt). If the rung does not settle within that budget, the ladder stops WAITING
 * on it, records an "aborted" reason, and moves on (or settles best-so-far if it was the last rung).
 * Honest scope: the LADDER stops waiting - the abandoned rung's own underlying network call may keep
 * running server-side until its own provider-level timeout; threading the abort signal into every
 * provider fetch is a deferred follow-up, not part of this guarantee. A rung that resolves AFTER the
 * ladder has already moved on (late resolve) cannot mutate the returned result - the race's loser is
 * simply never awaited again.
 */
export async function runLadder(_code: string, rungs: LadderRung[], opts: RunLadderOpts = {}): Promise<LadderResult> {
  const now = opts.now ?? Date.now;
  const reasons: Array<{ rung: string; reason: string }> = [];
  for (const r of rungs) {
    if (opts.deadlineAt !== undefined && now() >= opts.deadlineAt) {
      reasons.push({ rung: r.name, reason: "skipped: ladder deadline reached (DECODE_LADDER_TOTAL_MS)" });
      continue;
    }
    // Per-rung hard budget = min(perRungTimeout, remaining wall-clock to the total deadline). The
    // ladder stops WAITING on an in-flight rung at this budget - the D7 fix: a started rung is no
    // longer an unbounded await (the abandoned rung's own network call may still run server-side
    // until its provider timeout; the ladder result is already settled and immune to it - see the
    // late-resolve guard test). When neither a per-rung timeout nor a deadline is set, the rung runs
    // unbounded (legacy behavior, fully backward compatible).
    const controller = new AbortController();
    const budgets: number[] = [];
    if (opts.perRungTimeoutMs !== undefined) budgets.push(opts.perRungTimeoutMs);
    if (opts.deadlineAt !== undefined) budgets.push(Math.max(0, opts.deadlineAt - now()));
    const budgetMs = budgets.length > 0 ? Math.min(...budgets) : undefined;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let outcome: RungOutcome;
    try {
      if (budgetMs !== undefined) {
        const abortedPromise = new Promise<never>((_res, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new LadderRungTimeoutError());
          }, budgetMs);
        });
        outcome = await Promise.race([r.run({ signal: controller.signal }), abortedPromise]);
      } else {
        outcome = await r.run({ signal: controller.signal });
      }
    } catch (err) {
      if (err instanceof LadderRungTimeoutError) {
        // The budget timer fired first: the ladder gave up WAITING on this rung (it may still be
        // running server-side - see the D7 doc comment above). Keep the existing honest wording.
        reasons.push({ rung: r.name, reason: `aborted: rung exceeded its budget (${budgetMs ?? "unbounded"}ms) - DECODE_LADDER_RUNG_MS / DECODE_LADDER_TOTAL_MS` });
      } else {
        // A genuine exception from r.run() itself (network error, thrown bug, etc) - NOT a timeout.
        // Record the real message so needs_review shows the actual failure instead of a false
        // "aborted" label that would misattribute a real bug to the budget clock.
        const message = err instanceof Error ? err.message : String(err);
        const truncated = message.length > 200 ? `${message.slice(0, 200)}...` : message;
        reasons.push({ rung: r.name, reason: `error: ${truncated}` });
      }
      continue;
    } finally {
      if (timer) clearTimeout(timer);
    }
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
