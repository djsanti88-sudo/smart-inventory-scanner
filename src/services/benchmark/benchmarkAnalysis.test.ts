import { describe, expect, it } from "vitest";
import { accuracyVerdict, classifyPath, gptDecodeCallsForResponse, isUsableName, latencyStats, parseCsv, summarize, toInputRows, type BenchmarkRow, type DecodeResponseLike } from "@/services/benchmark/benchmarkAnalysis";

const response = (over: Partial<DecodeResponseLike>): DecodeResponseLike => ({ results: [], providerNames: [], providerStatuses: [], decision: { status: "needs_review" }, debug: {}, ...over });

describe("decode benchmark analysis", () => {
  it("parses quoted CSV and removes blank codes", () => {
    expect(toInputRows(parseCsv('code,expectedName\n123,"A, B"\n,blank')).map((row) => row.code)).toEqual(["123"]);
  });

  it.each([
    ["tire-corpus", "tire_corpus"],
    ["retail-corpus", "retail_corpus"],
    ["learned-products", "learned_products"],
    ["master-catalog", "master_catalog"],
    ["gpt-5.4-mini", "gpt_5_4_mini"],
  ])("classifies %s", (provider, expected) => {
    expect(classifyPath(response({ providerNames: [provider], results: [{ productName: "Real Product" }], decision: { status: "suggested" } }))).toBe(expected);
  });

  it("classifies cache, review, and failures", () => {
    expect(classifyPath(response({ debug: { cached: true } }))).toBe("cache");
    expect(classifyPath(response({ reasonCode: "no_result" }))).toBe("needs_review");
    expect(classifyPath(response({ timedOut: true }))).toBe("failed");
  });

  it("counts only an attempted GPT decode", () => {
    expect(gptDecodeCallsForResponse(response({ providerStatuses: [{ provider: "gpt-5.4-mini", status: "ok", latencyMs: 1, sourceUrlsReturned: 1, exactCodeFound: true, identityFound: true }] }))).toBe(1);
    expect(gptDecodeCallsForResponse(response({ providerStatuses: [{ provider: "gpt-5.4-mini", status: "skipped", latencyMs: 0, sourceUrlsReturned: 0, exactCodeFound: false, identityFound: false }] }))).toBe(0);
  });

  it("grades only against supplied ground truth", () => {
    const resolved = response({ results: [{ productName: "Acrylic Paint Markers Set" }], decision: { status: "suggested" } });
    expect(accuracyVerdict(resolved, { code: "x" }).verdict).toBe("resolved_without_ground_truth");
    expect(accuracyVerdict(resolved, { code: "x", expectedName: "Acrylic Paint Markers Set" }).verdict).toBe("pass");
  });

  it("keeps name and latency rules deterministic", () => {
    expect(isUsableName("Product Not Found")).toBe(false);
    expect(isUsableName("Real Product")).toBe(true);
    expect(latencyStats([100, 200, 300]).median).toBe(200);
  });

  it("summarizes the simplified path and paid calls", () => {
    const rows: BenchmarkRow[] = [
      { code: "a", path: "tire_corpus", verdict: "pass", verdictReason: "", productName: "A", decision: "verified", reasonCode: "ok", latencyMs: 1, cached: false, gptDecodeCalls: 0, webSearchCalls: 0 },
      { code: "b", path: "gpt_5_4_mini", verdict: "resolved_without_ground_truth", verdictReason: "", productName: "B", decision: "suggested", reasonCode: "gpt_decode", latencyMs: 10, cached: false, gptDecodeCalls: 1, webSearchCalls: 5 },
    ];
    expect(summarize(rows)).toMatchObject({ resolved: 2, gptDecodeCallsTotal: 1, webSearchCallsReserved: 5 });
  });
});
