// Pure, read-only parser for the current free-first decode response.
export const DECODE_TRACE_ORDER = ["cache", "tire_corpus", "retail_corpus", "learned_products", "master_catalog", "gpt_5_4_mini"];

export function parseDecodeTraceTrace(body) {
  const debug = body?.debug && typeof body.debug === "object" ? body.debug : {};
  const statuses = Array.isArray(body?.providerStatuses) ? body.providerStatuses : [];
  const results = Array.isArray(body?.results) ? body.results : [];
  const decision = body?.decision && typeof body.decision === "object" ? body.decision : {};
  const provider = typeof debug.decodePath === "string" ? debug.decodePath : body?.providerNames?.[0];
  const settledSource = debug.cached ? "cache" : String(provider || "none").replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "").toLowerCase();
  const gptStatus = statuses.find((status) => status?.provider === "gpt-5.4-mini");
  const first = results[0] && typeof results[0] === "object" ? results[0] : {};
  const identity = { brand: first.brand ?? null, model: first.model ?? null, size: first.size ?? null, name: first.productName ?? first.name ?? null };
  return {
    settledSource,
    reasons: [],
    reachedGpt: Boolean(gptStatus && gptStatus.status !== "skipped") || settledSource === "gpt_5_4_mini",
    gptSkipReason: gptStatus?.status === "skipped" ? gptStatus.errorCode ?? "skipped" : null,
    escapedGpt: false,
    cached: Boolean(debug.cached),
    corroborationPath: typeof debug.corroborationPath === "string" ? debug.corroborationPath : null,
    missReasonCode: typeof body?.reasonCode === "string" ? body.reasonCode : null,
    decisionStatus: typeof decision.status === "string" ? decision.status : null,
    confidence: typeof decision.confidence === "number" ? decision.confidence : null,
    partialIdentity: Boolean(identity.brand) && !identity.model && !identity.size,
    identity,
  };
}

export function decodeTraceTableRow(code, parsed, options) {
  return {
    code,
    settledSource: parsed?.settledSource ?? "none",
    reachedGpt: Boolean(parsed?.reachedGpt),
    gptSkipReason: parsed?.gptSkipReason ?? null,
    cached: Boolean(parsed?.cached),
    partialIdentity: Boolean(parsed?.partialIdentity),
    confidence: parsed?.confidence ?? null,
    reasonsSummary: "",
    latencyMs: typeof options?.latencyMs === "number" ? options.latencyMs : null,
  };
}

export function evaluateDecodeTriggerOutcome({ attemptedCount = 0, triggerAvailableCount = 0, traceCount = 0, apiCallCount = 0, unavailableReason = null } = {}) {
  if (!Number.isFinite(attemptedCount) || attemptedCount === 0) return { outcome: "unavailable", reason: unavailableReason ?? "no_codes_attempted" };
  if (triggerAvailableCount < attemptedCount) return { outcome: "unavailable", reason: unavailableReason ?? "trigger_not_available" };
  if (traceCount === 0 && apiCallCount === 0) return { outcome: "silent_miss", reason: null };
  return { outcome: "triggered", reason: null };
}

export function summarizeDecodeTrace(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const bySource = {};
  for (const row of list) bySource[row?.settledSource ?? "none"] = (bySource[row?.settledSource ?? "none"] ?? 0) + 1;
  return { total: list.length, bySource, reachedGptCount: list.filter((row) => row?.reachedGpt).length, partialIdentityCount: list.filter((row) => row?.partialIdentity).length };
}
