import { describe, it, expect } from "vitest";
import {
  parseCsv,
  toInputRows,
  classifyPath,
  accuracyVerdict,
  latencyStats,
  firecrawlCreditsForResponse,
  isUsableName,
  summarize,
  type DecodeResponseLike,
  type BenchmarkRow,
} from "@/services/benchmark/benchmarkAnalysis";

const resp = (over: Partial<DecodeResponseLike>): DecodeResponseLike => ({
  providerNames: [],
  results: [],
  providerStatuses: [],
  decision: { status: "needs_review" },
  debug: {},
  ...over,
});

describe("parseCsv", () => {
  it("parses headers + rows and handles quoted commas", () => {
    const csv = `code,expectedName,notes\n810118139604,"Acrylic Paint Markers, 24 Colors",real product\n070330645936,,`;
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0].code).toBe("810118139604");
    expect(rows[0].expectedName).toBe("Acrylic Paint Markers, 24 Colors");
    expect(rows[1].code).toBe("070330645936");
    expect(rows[1].expectedName).toBe("");
  });
  it("toInputRows drops rows without a code", () => {
    const rows = toInputRows(parseCsv(`code,notes\n123,a\n,blank\n456,b`));
    expect(rows.map((r) => r.code)).toEqual(["123", "456"]);
  });
});

describe("classifyPath", () => {
  it("cache wins over everything when debug.cached", () => {
    expect(classifyPath(resp({ debug: { cached: true }, results: [{ productName: "X Thing" }], decision: { status: "verified" } }))).toBe("cache");
  });
  it("fast_page_fetch for a verified page-fetch win with no fallback", () => {
    expect(classifyPath(resp({ providerNames: ["page-fetch"], results: [{ productName: "BIC Lighter" }], decision: { status: "verified" }, debug: { fallbackFound: false } }))).toBe("fast_page_fetch");
  });
  it("gemini_flash for a verified gemini win on the fast path", () => {
    expect(classifyPath(resp({ providerNames: ["gemini"], results: [{ productName: "Real Product" }], decision: { status: "verified" }, debug: { fallbackFound: false } }))).toBe("gemini_flash");
  });
  it("firecrawl_fallback when firecrawl won the fallback", () => {
    expect(classifyPath(resp({ providerNames: ["firecrawl"], results: [{ productName: "Acrylic Markers" }], decision: { status: "verified" }, debug: { fallbackFound: true } }))).toBe("firecrawl_fallback");
  });
  it("ai_deep_fallback when a deep AI re-run won", () => {
    expect(classifyPath(resp({ providerNames: ["ai-cited-deep"], results: [{ productName: "Deep Found" }], decision: { status: "verified" }, debug: { fallbackFound: true } }))).toBe("ai_deep_fallback");
  });
  it("needs_review when nothing usable resolved", () => {
    expect(classifyPath(resp({ results: [], decision: { status: "needs_review" }, reasonCode: "product_not_found_after_search" }))).toBe("needs_review");
  });
  it("failed on timeout / budget exceeded", () => {
    expect(classifyPath(resp({ timedOut: true, decision: { status: "needs_review" }, reasonCode: "lookup_budget_exceeded" }))).toBe("failed");
  });
});

describe("accuracyVerdict (honest)", () => {
  it("pass when the resolved name overlaps expected", () => {
    const r = resp({ results: [{ productName: "Acrylic Paint Markers Set, 24 Metallic Colors" }], decision: { status: "verified" } });
    expect(accuracyVerdict(r, { code: "x", expectedName: "Acrylic Paint Markers Set 24 Metallic" }).verdict).toBe("pass");
  });
  it("fail when ground truth exists but app did not resolve", () => {
    const r = resp({ results: [], decision: { status: "needs_review" }, reasonCode: "product_not_found_after_search" });
    expect(accuracyVerdict(r, { code: "x", expectedName: "Some Real Product" }).verdict).toBe("fail");
  });
  it("never claims correctness without ground truth", () => {
    const r = resp({ results: [{ productName: "Mystery Product 12oz" }], decision: { status: "verified" } });
    expect(accuracyVerdict(r, { code: "x" }).verdict).toBe("resolved_without_ground_truth");
  });
  it("needs_manual_review when resolved name clearly disagrees with expected", () => {
    const r = resp({ results: [{ productName: "Completely Different Widget" }], decision: { status: "verified" } });
    expect(accuracyVerdict(r, { code: "x", expectedName: "Acrylic Paint Markers Metallic" }).verdict).toBe("needs_manual_review");
  });
  it("cached is reported distinctly", () => {
    expect(accuracyVerdict(resp({ debug: { cached: true } }), { code: "x", expectedName: "Y" }).verdict).toBe("cached");
  });
});

describe("latencyStats", () => {
  it("computes avg/median/p95/min/max", () => {
    const s = latencyStats([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]);
    expect(s.count).toBe(10);
    expect(s.min).toBe(100);
    expect(s.max).toBe(1000);
    expect(s.median).toBe(500);
    expect(s.p95).toBe(1000);
  });
  it("handles empty input", () => {
    expect(latencyStats([])).toEqual({ count: 0, avg: 0, median: 0, p95: 0, min: 0, max: 0 });
  });
});

describe("cost estimation", () => {
  it("uses reported firecrawl credits when present", () => {
    expect(firecrawlCreditsForResponse(resp({ debug: { firecrawlCreditsEstimated: 7 } }))).toBe(7);
  });
  it("estimates 1 search + 1 per candidate when not reported", () => {
    expect(firecrawlCreditsForResponse(resp({ providerStatuses: [{ provider: "firecrawl", status: "no_match", latencyMs: 1, sourceUrlsReturned: 6, exactCodeFound: false, identityFound: false }] }))).toBe(7);
  });
  it("zero credits when firecrawl never ran (skipped)", () => {
    expect(firecrawlCreditsForResponse(resp({ providerStatuses: [{ provider: "firecrawl", status: "skipped", latencyMs: 0, sourceUrlsReturned: 0, exactCodeFound: false, identityFound: false }] }))).toBe(0);
  });
});

describe("isUsableName", () => {
  it("rejects junk/short/not-found titles", () => {
    expect(isUsableName("Product Not Found")).toBe(false);
    expect(isUsableName("Unknown")).toBe(false);
    expect(isUsableName("ab")).toBe(false);
    expect(isUsableName("")).toBe(false);
  });
  it("accepts a real product name", () => {
    expect(isUsableName("BIC Classic Pocket Lighter")).toBe(true);
  });
});

describe("summarize", () => {
  it("counts paths, resolved, and firecrawl credits", () => {
    const rows: BenchmarkRow[] = [
      { code: "a", path: "fast_page_fetch", verdict: "pass", verdictReason: "", productName: "A", decision: "verified", reasonCode: "ok", latencyMs: 1000, cached: false, firecrawlCredits: 0 },
      { code: "b", path: "firecrawl_fallback", verdict: "resolved_without_ground_truth", verdictReason: "", productName: "B", decision: "verified", reasonCode: "fallback_discovery_found_product", latencyMs: 16000, cached: false, firecrawlCredits: 7 },
      { code: "c", path: "needs_review", verdict: "needs_review", verdictReason: "", productName: "", decision: "needs_review", reasonCode: "product_not_found_after_search", latencyMs: 13000, cached: false, firecrawlCredits: 7 },
    ];
    const s = summarize(rows);
    expect(s.total).toBe(3);
    expect(s.resolved).toBe(2);
    expect(s.needsReview).toBe(1);
    expect(s.firecrawlCreditsTotal).toBe(14);
    expect(s.slowest[0].code).toBe("b");
  });
});
