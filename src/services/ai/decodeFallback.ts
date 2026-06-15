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
  product_not_found_after_search: "Searched the barcode databases and the open web - no product matched this barcode.",
  search_provider_unavailable: "Not in the databases, and open-web fallback is unavailable (no Firecrawl key).",
};

/** Map the final decode state to a SPECIFIC reason code (never the old generic message). */
export function decodeReasonCode(a: {
  hasProduct: boolean;
  fallbackFound: boolean;
  timedOut: boolean;
  decisionStatus: string;
  statuses: ProviderStatus[];
  firecrawlKey: boolean;
}): string {
  if (a.hasProduct) return a.fallbackFound ? "fallback_discovery_found_product" : "ok";
  if (a.decisionStatus === "conflict") return "conflicting_product_identity";
  if (a.timedOut) return "lookup_budget_exceeded";
  if (a.statuses.some((s) => s.status === "rate_limited")) return "provider_rate_limited";
  if (a.statuses.some((s) => s.status === "timeout")) return "provider_timeout";
  if (a.statuses.some((s) => s.status === "error")) return "provider_error";
  if (a.statuses.some((s) => s.provider === "firecrawl" && s.status === "no_match")) return "product_not_found_after_search";
  if (!a.firecrawlKey) return "search_provider_unavailable";
  return "product_not_found_after_search";
}
