import { describe, it, expect } from "vitest";
import { shouldRunFallback, decodeReasonCode, sanitizeCustomerReason, allMissReasonCode, MISS_REASON_TEXT } from "@/services/ai/decodeFallback";
import type { ProviderStatus } from "@/services/ai/decodeOrchestrator";

const st = (over: Partial<ProviderStatus>): ProviderStatus => ({
  provider: "gemini", status: "no_match", latencyMs: 1, sourceUrlsReturned: 0, exactCodeFound: false, identityFound: false, ...over,
});

describe("shouldRunFallback (fast path never runs fallback)", () => {
  it("does NOT run when the fast path already has a product", () => {
    expect(shouldRunFallback({ hasProduct: true, timedOut: false, decisionStatus: "verified", e2e: false })).toBe(false);
  });
  it("does NOT run on timeout, conflict, or in e2e mode", () => {
    expect(shouldRunFallback({ hasProduct: false, timedOut: true, decisionStatus: "needs_review", e2e: false })).toBe(false);
    expect(shouldRunFallback({ hasProduct: false, timedOut: false, decisionStatus: "conflict", e2e: false })).toBe(false);
    expect(shouldRunFallback({ hasProduct: false, timedOut: false, decisionStatus: "needs_review", e2e: true })).toBe(false);
  });
  it("runs only when the fast path failed to find a product", () => {
    expect(shouldRunFallback({ hasProduct: false, timedOut: false, decisionStatus: "needs_review", e2e: false })).toBe(true);
  });
});

describe("decodeReasonCode (honest, specific reasons)", () => {
  const base = { hasProduct: false, fallbackFound: false, timedOut: false, decisionStatus: "needs_review", statuses: [] as ProviderStatus[], firecrawlKey: true };

  it("ok when the fast path found a product", () => {
    expect(decodeReasonCode({ ...base, hasProduct: true })).toBe("ok");
  });
  it("fallback_discovery_found_product when the fallback found it", () => {
    expect(decodeReasonCode({ ...base, hasProduct: true, fallbackFound: true })).toBe("fallback_discovery_found_product");
  });
  it("provider_rate_limited (NOT not-found) when a provider 429'd and nothing was found", () => {
    expect(decodeReasonCode({ ...base, statuses: [st({ status: "rate_limited" })] })).toBe("provider_rate_limited");
  });
  it("provider_timeout when a provider timed out", () => {
    expect(decodeReasonCode({ ...base, statuses: [st({ status: "timeout" })] })).toBe("provider_timeout");
  });
  it("product_not_found_after_search only when Firecrawl actually searched and missed", () => {
    expect(decodeReasonCode({ ...base, statuses: [st({ provider: "firecrawl", status: "no_match" })] })).toBe("product_not_found_after_search");
  });
  it("fallback_coverage_missed when Firecrawl found more results than it could open", () => {
    expect(decodeReasonCode({ ...base, coverageMissed: true, statuses: [st({ provider: "firecrawl", status: "no_match" })] })).toBe("fallback_coverage_missed");
  });
  it("provider_rate_limited still wins over coverage gaps (a hard quota stop is more specific)", () => {
    expect(decodeReasonCode({ ...base, coverageMissed: true, statuses: [st({ status: "rate_limited" })] })).toBe("provider_rate_limited");
  });
  it("search_provider_unavailable when there is no Firecrawl key", () => {
    expect(decodeReasonCode({ ...base, firecrawlKey: false })).toBe("search_provider_unavailable");
  });
  it("conflicting_product_identity on a provider conflict; lookup_budget_exceeded on timeout", () => {
    expect(decodeReasonCode({ ...base, decisionStatus: "conflict" })).toBe("conflicting_product_identity");
    expect(decodeReasonCode({ ...base, timedOut: true })).toBe("lookup_budget_exceeded");
  });
});

// BUG #14 (medium, info-disclosure, QA hardening 2026-07-16): customer-facing reason/status text must
// never leak raw vendor/service/model names ("upcitemdb", "openfoodfacts", "goupc"/"Go-UPC",
// "fetchv2"/"Fetch V2", "gpt-5.5", internal skip-reason codes like "gpt_call_failed"). The sanitizer is
// the single choke point every reasonText/decision.reason must pass through before it reaches the
// customer-facing response body or client state. Raw values stay reachable ONLY in debug.* (platform-only).
describe("sanitizeCustomerReason (BUG #14: no raw vendor/model names leak to customers)", () => {
  const DENYLIST_RE = /upcitemdb|openfoodfacts|goupc|go-upc|fetchv2|fetch v2|gpt[-_ ]?5\.5|gpt-5\.5-ladder|gpt_call_failed|gpt_aborted_at_cap|no_api_key|non_public_code_type|e2e_mode|budget_exceeded|prior_status_already_decided|\bladder\b|parallel:|tire-corpus|retail-corpus|learned-products/i;

  it("strips every denylisted raw token to an honest non-empty string", () => {
    const raws = [
      "No rung resolved the code. upcitemdb: no match; openfoodfacts: no match; goupc: not a GTIN; fetchv2: no usable identity; gpt: gpt-5.5 skipped: gpt_call_failed",
      "Go-UPC exact barcode match -> verified auto-count candidate",
      "Fetch V2 verified",
      "gpt-5.5 from-scratch: exact code self-reported (owner trust rule)",
      "gpt-5.5-ladder skipped: no_api_key",
      "gpt_call_failed",
      "gpt_aborted_at_cap",
      "non_public_code_type",
      "e2e_mode",
      "budget_exceeded",
      "prior_status_already_decided",
      "parallel:groundIdentify found a match",
      "Matched in the tire-corpus (exact barcode).",
      "Matched in the retail-corpus (exact barcode).",
      "Suggested from the learned-products tier: learned from example.com on 2026-07-10",
    ];
    for (const raw of raws) {
      const out = sanitizeCustomerReason(raw);
      expect(out.length, `expected non-empty for raw: ${raw}`).toBeGreaterThan(0);
      expect(DENYLIST_RE.test(out), `leaked a raw token for raw: ${raw} -> "${out}"`).toBe(false);
    }
  });

  it("never returns empty string, even for empty input", () => {
    const out = sanitizeCustomerReason("");
    expect(out.length).toBeGreaterThan(0);
    expect(DENYLIST_RE.test(out)).toBe(false);
  });

  it("passes safe hand-written prose through unchanged", () => {
    const safe = [
      "Providers disagree on the product - confirm before saving.",
      "The lookup ran out of time. Retry live decode.",
      "Searched the barcode databases and the open web - no product matched this barcode.",
      "Matched in the retail product database (exact barcode). No AI lookup needed.",
    ];
    for (const s of safe) {
      expect(sanitizeCustomerReason(s)).toBe(s);
    }
  });

  it("honest context reasons (offline, cap, missing keys) survive intact because they contain no denylisted tokens", () => {
    const honestReasons = [
      "AI lookup is off. Turn it on in Settings to auto-decode.",
      "Offline. Saved locally; AI was not called.",
      "Daily AI lookup cap reached. Routed to Needs Review.",
      "AI circuit breaker is open after repeated failures. Routed to Needs Review.",
      "No API keys configured (missing: GEMINI_API_KEY, OPENAI_API_KEY). Set them server-side, then retry live decode.",
    ];
    for (const r of honestReasons) {
      expect(sanitizeCustomerReason(r)).toBe(r);
    }
  });

});

// The root-cause fix (.superpowers/sdd/goupc-cap-rootcause.md): decision.status is architecturally
// never "cap_blocked" (only verified|needs_review|suggested|conflict), so the old
// HONEST_CONTEXT_REASON["cap_blocked"] key that ctx.status used to look up was dead code - nothing
// upstream ever produced that status value. A per-rung cap has to be detected from the honest
// per-rung reasons themselves. allMissReasonCode() does that classification; MISS_REASON_TEXT is the
// honest, token-free prose for each resulting code, hand-written so it always survives
// sanitizeCustomerReason unchanged (contains no denylisted vendor/model token).
describe("allMissReasonCode (classifies all-rungs-missed reasons, most specific first)", () => {
  it("provider_cap_reached for a real Go-UPC monthly-cap reason string", () => {
    const reasons = [
      { rung: "go-upc", reason: "Go-UPC monthly cap reached" },
      { rung: "fetchv2", reason: "Fetch V2 skipped (E2E mock mode)" },
      { rung: "gpt", reason: "gpt-5.5 skipped: no_api_key" },
    ];
    expect(allMissReasonCode(reasons)).toBe("provider_cap_reached");
  });

  it("provider_cap_reached for quota / usage limit phrasing", () => {
    expect(allMissReasonCode([{ rung: "go-upc", reason: "Go-UPC quota exceeded for today" }])).toBe("provider_cap_reached");
    expect(allMissReasonCode([{ rung: "upcitemdb", reason: "usage limit hit" }])).toBe("provider_cap_reached");
  });

  it("provider_rate_limited for a 429 / rate-limit reason (and cap still wins if both present)", () => {
    expect(allMissReasonCode([{ rung: "go-upc", reason: "HTTP 429 rate limited" }])).toBe("provider_rate_limited");
    expect(
      allMissReasonCode([
        { rung: "go-upc", reason: "monthly cap reached" },
        { rung: "fetchv2", reason: "rate limited" },
      ]),
    ).toBe("provider_cap_reached");
  });

  it("lookup_budget_exceeded for a budget/timeout reason", () => {
    expect(allMissReasonCode([{ rung: "fetchv2", reason: "budget_exceeded" }])).toBe("lookup_budget_exceeded");
    expect(allMissReasonCode([{ rung: "gpt", reason: "request timed out" }])).toBe("lookup_budget_exceeded");
  });

  it("provider_unavailable for a missing-key / offline / unavailable reason", () => {
    expect(allMissReasonCode([{ rung: "gpt", reason: "gpt-5.5 skipped: no_api_key" }])).toBe("provider_unavailable");
    expect(allMissReasonCode([{ rung: "fetchv2", reason: "search provider unavailable" }])).toBe("provider_unavailable");
  });

  it("product_not_found when every rung genuinely just missed", () => {
    const reasons = [
      { rung: "upcitemdb", reason: "no match" },
      { rung: "openfoodfacts", reason: "no match" },
      { rung: "go-upc", reason: "not a GTIN" },
    ];
    expect(allMissReasonCode(reasons)).toBe("product_not_found");
  });

  it("returns product_not_found for an empty reasons list", () => {
    expect(allMissReasonCode([])).toBe("product_not_found");
  });
});

describe("MISS_REASON_TEXT (honest, token-free prose per allMissReasonCode)", () => {
  const DENYLIST_RE = /upcitemdb|openfoodfacts|goupc|go-upc|fetchv2|fetch v2|gpt[-_ ]?5\.5|gpt-5\.5-ladder|gpt_call_failed|gpt_aborted_at_cap|no_api_key|non_public_code_type|e2e_mode|budget_exceeded|prior_status_already_decided|\bladder\b|parallel:|tire-corpus|retail-corpus|learned-products/i;

  it("has an entry for every code allMissReasonCode can return", () => {
    const codes = ["provider_cap_reached", "provider_rate_limited", "lookup_budget_exceeded", "provider_unavailable", "product_not_found"];
    for (const code of codes) {
      expect(MISS_REASON_TEXT[code], `missing MISS_REASON_TEXT entry for ${code}`).toBeTruthy();
    }
  });

  it("no entry leaks a denylisted vendor/provider/model token (BUG #14 anti-leak law)", () => {
    for (const [code, text] of Object.entries(MISS_REASON_TEXT)) {
      expect(DENYLIST_RE.test(text), `MISS_REASON_TEXT["${code}"] leaked a token: "${text}"`).toBe(false);
    }
  });

  it("every entry survives sanitizeCustomerReason unchanged (passes on its own merits)", () => {
    for (const text of Object.values(MISS_REASON_TEXT)) {
      expect(sanitizeCustomerReason(text)).toBe(text);
    }
  });

  it("the real Go-UPC cap fixture reason resolves to the honest cap-reached text end to end", () => {
    const reasons = [
      { rung: "go-upc", reason: "Go-UPC monthly cap reached" },
      { rung: "fetchv2", reason: "Fetch V2 skipped (E2E mock mode)" },
      { rung: "gpt", reason: "gpt-5.5 skipped: no_api_key" },
    ];
    const code = allMissReasonCode(reasons);
    const honest = MISS_REASON_TEXT[code];
    expect(sanitizeCustomerReason(honest)).toBe(honest);
    expect(honest).toMatch(/usage limit/i);
    expect(DENYLIST_RE.test(honest)).toBe(false);
  });
});
