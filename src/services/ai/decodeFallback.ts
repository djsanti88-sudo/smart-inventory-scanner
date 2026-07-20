import type { ProviderStatus } from "@/services/ai/decodeOrchestrator";

// Pure helpers for the Stage-2 fallback gate + honest review reasons. Kept out of the Next route
// handler so they're unit-testable (Loop 5: fast path never runs fallback; Loop 4: honest reasons).

/**
 * Stage 2 (AI-cited URLs + Firecrawl) runs ONLY when the fast path found no usable product, the run
 * did not time out, it is not a provider conflict, and we are not in E2E mock mode. So a normal
 * successful scan adds ZERO extra network calls.
 */
export function shouldRunFallback(a: { hasProduct: boolean; timedOut: boolean; decisionStatus: string; e2e: boolean }): boolean {
  return !a.hasProduct && !a.timedOut && a.decisionStatus !== "conflict" && !a.e2e;
}

export const REASON_TEXT: Record<string, string> = {
  ok: "",
  fallback_discovery_found_product: "Found via open-web fallback search.",
  conflicting_product_identity: "Providers disagree on the product - confirm before saving.",
  lookup_budget_exceeded: "The lookup ran out of time. Retry live decode.",
  provider_rate_limited: "The AI provider was rate-limited (quota). Retry shortly.",
  provider_timeout: "The AI provider timed out. Retry live decode.",
  provider_error: "The AI provider returned an error. Retry live decode.",
  fallback_coverage_missed: "The open-web search found more results than it could open - the product may be on a page we didn't reach. Retry live decode to search deeper.",
  product_not_found_after_search: "Searched the barcode databases and the open web - no product matched this barcode.",
  search_provider_unavailable: "Not in the databases, and open-web fallback is unavailable (no Firecrawl key).",
};

// BUG #14 (medium, info-disclosure, QA hardening 2026-07-16): the T2 REASON_TEXT map above is honest
// prose but was never the only source of customer-facing reason text - raw per-rung reason strings
// (UpcItemDbProvider/OpenFoodFactsProvider/GoUpcProvider, Fetch V2, the GPT ladder rung, and the
// all-miss join in pipeline.ts) flow straight into reasonText/decision.reason and were rendered
// verbatim on the scan feed / Needs Review row, leaking vendor/service/model names ("upcitemdb",
// "openfoodfacts", "goupc"/"Go-UPC", "fetchv2"/"Fetch V2", "gpt-5.5") and internal skip-reason codes
// ("gpt_call_failed", "no_api_key", etc.) to every role. sanitizeCustomerReason is the single choke
// point every customer-facing reason must pass through before it leaves the server (and again
// client-side as defense in depth) - debug.* is untouched and keeps the raw values for diagnosis.
const CUSTOMER_REASON_DENYLIST =
  /upcitemdb|openfoodfacts|goupc|go-upc|fetchv2|fetch v2|gpt[-_ ]?5\.5|gpt-5\.5-ladder|gpt_call_failed|gpt_aborted_at_cap|no_api_key|non_public_code_type|e2e_mode|budget_exceeded|prior_status_already_decided|\bladder\b|parallel:|tire-corpus|retail-corpus|learned-products/i;

/** Honest, token-free fallback shown whenever the raw reason is empty or leaks an internal name. */
const HONEST_DEFAULT_REASON = "Could not confirm this item automatically. Review and confirm the details.";

/** Context-specific honest fallbacks, reused from the existing scanStore honest-reason copy so a
 *  sanitized reason still tells the customer roughly WHY (offline / missing keys) when that context
 *  is known, instead of always collapsing to the fully generic default.
 *  NOTE: the "cap_blocked" key that used to live here was DEAD CODE - `decision.status` (the only
 *  thing ever passed as `ctx.status`) is architecturally always verified|needs_review|suggested|
 *  conflict, never "cap_blocked" (that string only exists as a PipelineOutcome.kind and a telemetry
 *  status, both of which bypass sanitizeCustomerReason entirely). A per-rung cap (e.g. Go-UPC's own
 *  monthly quota) instead flows through the ordinary all-miss reason with status "needs_review" - see
 *  allMissReasonCode()/MISS_REASON_TEXT below, which classify the per-rung reasons directly. */
const HONEST_CONTEXT_REASON: Record<string, string> = {
  offline: "Offline. Saved locally; AI was not called.",
  missing_keys: "No API keys configured. Set them server-side, then retry live decode.",
};

/**
 * Classify an all-rungs-missed decode into a SPECIFIC, customer-safe reason code by reading the
 * honest per-rung reasons (e.g. "go-upc: Go-UPC monthly cap reached"). Most-specific match wins so a
 * cap distinguishes itself from a generic rate limit or a genuine not-found. This is what actually
 * captures "cap reached" today - `ctx.status` never can (see note above).
 */
export function allMissReasonCode(reasons: Array<{ rung: string; reason: string }>): string {
  const joined = reasons.map((r) => r.reason).join(" ; ");
  if (/\b(cap|quota|monthly limit|usage limit)\b/i.test(joined)) return "provider_cap_reached";
  if (/rate.?limit|\b429\b/i.test(joined)) return "provider_rate_limited";
  if (/budget|timed out|timeout/i.test(joined)) return "lookup_budget_exceeded";
  if (/no.?api.?key|unavailable|offline|no key/i.test(joined)) return "provider_unavailable";
  return "product_not_found";
}

/** Honest, token-free prose for each allMissReasonCode() outcome. Hand-written so none of these
 *  strings can ever match CUSTOMER_REASON_DENYLIST - they name no vendor, provider, or model. */
export const MISS_REASON_TEXT: Record<string, string> = {
  provider_cap_reached: "A lookup service is at its usage limit right now. Saved to Needs Review; try again shortly.",
  provider_rate_limited: "A lookup service was rate-limited. Saved to Needs Review; retry shortly.",
  lookup_budget_exceeded: "The lookup ran out of time. Saved to Needs Review; retry live decode.",
  provider_unavailable: "Live lookup is unavailable right now. Saved to Needs Review.",
  product_not_found: "No match found in the databases or open web. Saved to Needs Review.",
};

/**
 * Sanitize a decode reason string before it ever reaches a customer-facing field (reasonText,
 * decision.reason, needsReviewQueue[].reason, scanFeed[].reason). LAW: never returns empty. Honest,
 * hand-written prose (the REASON_TEXT map, the scanStore honest-context strings) contains none of the
 * denylisted tokens, so it always passes through unchanged. A raw rung/provider/model name, an
 * internal skip-reason code, or an empty string is replaced with an honest fixed fallback - never the
 * raw value, never "".
 */
export function sanitizeCustomerReason(raw: string, ctx?: { status?: string }): string {
  if (!raw || !raw.trim()) {
    return (ctx?.status && HONEST_CONTEXT_REASON[ctx.status]) || HONEST_DEFAULT_REASON;
  }
  if (CUSTOMER_REASON_DENYLIST.test(raw)) {
    return (ctx?.status && HONEST_CONTEXT_REASON[ctx.status]) || HONEST_DEFAULT_REASON;
  }
  return raw;
}

/** Map the final decode state to a SPECIFIC reason code (never the old generic message). */
export function decodeReasonCode(a: {
  hasProduct: boolean;
  fallbackFound: boolean;
  timedOut: boolean;
  decisionStatus: string;
  statuses: ProviderStatus[];
  firecrawlKey: boolean;
  coverageMissed?: boolean;
}): string {
  if (a.hasProduct) return a.fallbackFound ? "fallback_discovery_found_product" : "ok";
  if (a.decisionStatus === "conflict") return "conflicting_product_identity";
  if (a.timedOut) return "lookup_budget_exceeded";
  if (a.statuses.some((s) => s.status === "rate_limited")) return "provider_rate_limited";
  // Firecrawl searched but couldn't open the result that may have held the product (coverage gap) -
  // distinct from a genuine "searched everything and it's not there".
  if (a.coverageMissed) return "fallback_coverage_missed";
  if (a.statuses.some((s) => s.status === "timeout")) return "provider_timeout";
  if (a.statuses.some((s) => s.status === "error")) return "provider_error";
  if (a.statuses.some((s) => s.provider === "firecrawl" && s.status === "no_match")) return "product_not_found_after_search";
  if (!a.firecrawlKey) return "search_provider_unavailable";
  return "product_not_found_after_search";
}
