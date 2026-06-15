import { describe, it, expect } from "vitest";
import { shouldRunFallback, decodeReasonCode } from "@/services/ai/decodeFallback";
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
