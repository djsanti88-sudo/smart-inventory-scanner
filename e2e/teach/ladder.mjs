// Pure, read-only observation module for the Teach Bot Playwright harness.
// Parses the Scanbin decode API response (POST /api/ai-lookup, mode: decode)
// into a diagnosis of which decode-ladder rung answered and why others did not.
//
// Does NOT import app source. Read-only observation only.

/** Cost-ordered decode ladder (paid/rung stages only; free corpus/cache stages
 * run BEFORE the ladder and surface via debug.corroborationPath / debug.cached). */
export const LADDER_ORDER = ["upcitemdb", "openfoodfacts", "goupc", "fetchv2", "gpt"];

/**
 * Parse a decode API response body into a ladder trace diagnosis.
 * Defensive: body / body.debug / arrays may be missing or malformed.
 * @param {any} body
 */
export function parseLadderTrace(body) {
  const debug = (body && typeof body === "object" && body.debug && typeof body.debug === "object")
    ? body.debug
    : {};
  const providerStatuses = Array.isArray(body?.providerStatuses) ? body.providerStatuses : [];
  const results = Array.isArray(body?.results) ? body.results : [];
  const decision = (body && typeof body === "object" && body.decision && typeof body.decision === "object")
    ? body.decision
    : {};

  const reasons = Array.isArray(debug.ladderReasons) ? debug.ladderReasons : [];

  const rawLadderPath = typeof debug.ladderPath === "string" ? debug.ladderPath : "";
  const corroborationPath = typeof debug.corroborationPath === "string" ? debug.corroborationPath : null;

  let settledRung;
  if (rawLadderPath && rawLadderPath !== "none") {
    settledRung = rawLadderPath;
  } else if (corroborationPath) {
    settledRung = corroborationPath;
  } else {
    settledRung = "none";
  }

  const gptProviderEntry = providerStatuses.find(
    (p) => p && typeof p === "object" && p.provider === "gpt-5.5-ladder"
  );

  const reachedGpt =
    reasons.some((r) => r && r.rung === "gpt") ||
    settledRung === "gpt" ||
    Boolean(gptProviderEntry && gptProviderEntry.status !== "skipped");

  const gptSkipReason =
    (typeof debug.gptLadderSkipReason === "string" && debug.gptLadderSkipReason) ||
    (gptProviderEntry && gptProviderEntry.errorCode) ||
    null;

  // escapedGpt: paid rungs (fetchv2) ran, but GPT was neither reached nor
  // explicitly skipped for a known/honest reason. Diagnostic flag, not a verdict.
  const fetchv2Present = reasons.some((r) => r && r.rung === "fetchv2") || settledRung === "fetchv2";
  const escapedGpt = fetchv2Present && !reachedGpt && !gptSkipReason;

  const cached = Boolean(debug.cached || debug.persistedCacheHit);
  const missReasonCode = typeof debug.missReasonCode === "string" ? debug.missReasonCode : null;

  const decisionStatus = typeof decision.status === "string" ? decision.status : null;
  const confidence = typeof decision.confidence === "number" ? decision.confidence : null;

  const first = results[0] && typeof results[0] === "object" ? results[0] : {};
  const identity = {
    brand: first.brand ?? null,
    model: first.model ?? null,
    size: first.size ?? null,
    name: first.name ?? null,
  };

  // partialIdentity heuristic: a brand is present but model AND size are both
  // missing -> a rung settled on partial identity (brand only).
  const partialIdentity = Boolean(identity.brand) && !identity.model && !identity.size;

  return {
    settledRung,
    reasons,
    reachedGpt,
    gptSkipReason,
    escapedGpt,
    cached,
    corroborationPath,
    missReasonCode,
    decisionStatus,
    confidence,
    partialIdentity,
    identity,
  };
}

/**
 * Flatten a parsed trace into a table row for reporting.
 * @param {string} code
 * @param {ReturnType<typeof parseLadderTrace>} parsed
 * @param {{ latencyMs?: number|null }} [options] Optional timing metadata
 *   (e.g. from attachLadderCapture). Absent/undefined -> latencyMs is null.
 */
export function ladderTableRow(code, parsed, options) {
  const reasonsSummary = (parsed?.reasons ?? [])
    .map((r) => `${r?.rung ?? "?"}:${r?.reason ?? "?"}`)
    .join("; ");

  const latencyMs = options && typeof options === "object" && typeof options.latencyMs === "number"
    ? options.latencyMs
    : null;

  return {
    code,
    settledRung: parsed?.settledRung ?? "none",
    reachedGpt: Boolean(parsed?.reachedGpt),
    gptSkipReason: parsed?.gptSkipReason ?? null,
    cached: Boolean(parsed?.cached),
    partialIdentity: Boolean(parsed?.partialIdentity),
    confidence: parsed?.confidence ?? null,
    reasonsSummary,
    latencyMs,
  };
}

/**
 * Pure decision helper for lesson 7 (live decode ladder trace): given whether
 * the manual "Look up with AI" trigger was actually available/clickable for
 * a code, and how many ladder-capture traces + /api/ai-lookup calls were
 * observed for the codes we attempted to trigger, decide what happened.
 *
 * Three outcomes:
 *  - 'unavailable': the trigger button was absent/disabled for at least one
 *    attempted code, so decode could not be exercised through this path.
 *    Not automatically a bug - the caller supplies `reason` (e.g. AI lookup
 *    off, no platform-owner access, no server keys) so the lesson can record
 *    an honest, non-locked finding rather than silently passing.
 *  - 'silent_miss': the trigger WAS available and was clicked on every
 *    attempted code, but zero ladder traces / zero api calls were captured.
 *    This is a real app-bug candidate (the button did nothing) and MUST
 *    surface a finding, never a silent pass.
 *  - 'triggered': the trigger was available and at least one trace/api call
 *    was captured for the attempted codes - decode was genuinely exercised.
 *
 * @param {{
 *   attemptedCount: number,
 *   triggerAvailableCount: number,
 *   traceCount: number,
 *   apiCallCount: number,
 *   unavailableReason?: string|null,
 * }} input
 */
export function evaluateDecodeTriggerOutcome({
  attemptedCount,
  triggerAvailableCount,
  traceCount,
  apiCallCount,
  unavailableReason = null,
} = {}) {
  const attempted = Number.isFinite(attemptedCount) ? attemptedCount : 0;
  const available = Number.isFinite(triggerAvailableCount) ? triggerAvailableCount : 0;
  const traces = Number.isFinite(traceCount) ? traceCount : 0;
  const apiCalls = Number.isFinite(apiCallCount) ? apiCallCount : 0;

  if (attempted === 0) {
    return { outcome: 'unavailable', reason: unavailableReason ?? 'no_codes_attempted' };
  }

  if (available < attempted) {
    return { outcome: 'unavailable', reason: unavailableReason ?? 'trigger_not_available' };
  }

  if (traces === 0 && apiCalls === 0) {
    return { outcome: 'silent_miss', reason: null };
  }

  return { outcome: 'triggered', reason: null };
}

/**
 * Summarize an array of ladder table rows.
 * @param {ReturnType<typeof ladderTableRow>[]} rows
 */
export function summarizeLadder(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const byRung = {};
  let reachedGptCount = 0;
  let partialIdentityCount = 0;

  for (const row of list) {
    const rung = row?.settledRung ?? "none";
    byRung[rung] = (byRung[rung] ?? 0) + 1;
    if (row?.reachedGpt) reachedGptCount += 1;
    if (row?.partialIdentity) partialIdentityCount += 1;
  }

  return {
    total: list.length,
    byRung,
    reachedGptCount,
    partialIdentityCount,
  };
}
