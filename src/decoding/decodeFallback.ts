// Customer-facing decode reasons pass through this one boundary. Internal provider names, storage
// codes, and skip codes remain available in server-only diagnostics but never leak into scan rows.

const INTERNAL_REASON =
  /gpt[-_ ]?5\.[45]|gpt_decode|no_api_key|non_public_code_type|budget_exceeded|insufficient_time|e2e_mode|tire-corpus|retail-corpus|learned-products|master-catalog|upcitemdb|openfoodfacts|go-?upc|fetchv2|\bladder\b/i;

const DEFAULT_REASON = "Could not confirm this item automatically. Review and confirm the details.";

export const MISS_REASON_TEXT = {
  product_not_found: DEFAULT_REASON,
} as const;

const CONTEXT_REASON: Record<string, string> = {
  offline: "Offline. Saved locally; AI was not called.",
  missing_keys: "Live lookup is not configured. Review and confirm the details.",
};

export function sanitizeCustomerReason(raw: string, context?: { status?: string }): string {
  const fallback = (context?.status && CONTEXT_REASON[context.status]) || DEFAULT_REASON;
  const value = raw?.trim();
  return !value || INTERNAL_REASON.test(value) ? fallback : value;
}
