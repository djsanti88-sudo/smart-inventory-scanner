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
 */
export function ladderTableRow(code, parsed) {
  const reasonsSummary = (parsed?.reasons ?? [])
    .map((r) => `${r?.rung ?? "?"}:${r?.reason ?? "?"}`)
    .join("; ");

  return {
    code,
    settledRung: parsed?.settledRung ?? "none",
    reachedGpt: Boolean(parsed?.reachedGpt),
    gptSkipReason: parsed?.gptSkipReason ?? null,
    cached: Boolean(parsed?.cached),
    partialIdentity: Boolean(parsed?.partialIdentity),
    confidence: parsed?.confidence ?? null,
    reasonsSummary,
  };
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
