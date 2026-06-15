import { describe, it, expect } from "vitest";
import { runDecode, type DecodeProvider } from "@/services/ai/decodeOrchestrator";
import { emptyResult } from "@/services/ai/provider";
import type { AiLookupResult } from "@/types";

function coke(): AiLookupResult {
  return { ...emptyResult(), productName: "Coca-Cola Classic", brand: "Coca-Cola", upc: "049000028904", sourceSnippets: ["UPC 049000028904 Coca-Cola"], confidence: 0.96 };
}
function suggestion(): AiLookupResult {
  return { ...emptyResult(), productName: "Maybe Snack", brand: "Generic", upc: "049000028904", sourceUrls: ["https://x"], confidence: 0.5 };
}

describe("runDecode - time budget + concurrency", () => {
  it("returns a VERIFIED result quickly when a provider + evidence verify (no timeout)", async () => {
    const p: DecodeProvider = { name: "openai", lookup: async () => coke() };
    const r = await runDecode({
      code: "049000028904",
      codeType: "upc_a",
      confidenceThreshold: 0.8,
      providers: [p],
      budgetMs: 13_000,
    });
    expect(r.timedOut).toBe(false);
    expect(r.decision.status).toBe("verified");
  });

  it("on TIMEOUT, aborts pending work and returns needs_review with NO partial result", async () => {
    let aborted = false;
    const slow: DecodeProvider = {
      name: "gemini",
      lookup: (signal) =>
        new Promise<AiLookupResult>((res, rej) => {
          const t = setTimeout(() => res(coke()), 800); // would verify, but too slow
          signal.addEventListener("abort", () => {
            aborted = true;
            clearTimeout(t);
            rej(new Error("aborted"));
          });
        }),
    };
    // Nothing resolves before the budget -> the timeout path must abort and return needs_review.
    const r = await runDecode({
      code: "049000028904",
      codeType: "upc_a",
      confidenceThreshold: 0.8,
      providers: [slow],
      budgetMs: 40,
      providerTimeoutMs: 1000,
    });

    expect(r.timedOut).toBe(true);
    expect(r.decision.status).toBe("needs_review"); // untrusted on timeout, never the partial "Maybe Snack"
    expect(r.decision.reason.toLowerCase()).toMatch(/budget|timed out|time/);
    expect(aborted).toBe(true); // pending work was actually cancelled
  });

  it("when everything settles in budget with only a suggestion, returns suggested (not a timeout)", async () => {
    const p: DecodeProvider = { name: "openai", lookup: async () => suggestion() };
    const r = await runDecode({ code: "049000028904", codeType: "upc_a", confidenceThreshold: 0.8, providers: [p], budgetMs: 13_000 });
    expect(r.timedOut).toBe(false);
    expect(r.decision.status).toBe("suggested");
  });

  it("captures a provider 429 as rate_limited (does NOT swallow the error)", async () => {
    const bad: DecodeProvider = { name: "gemini", lookup: async () => { throw new Error("Gemini error 429: quota exceeded"); } };
    const r = await runDecode({ code: "049000028904", codeType: "upc_a", confidenceThreshold: 0.8, providers: [bad], budgetMs: 5000 });
    const gem = r.providerStatuses.find((s) => s.provider === "gemini");
    expect(gem?.status).toBe("rate_limited");
    expect(gem?.errorCode).toBe("429");
  });

  it("captures a provider timeout as timeout", async () => {
    const slow: DecodeProvider = {
      name: "openai",
      lookup: (signal) => new Promise<AiLookupResult>((_, rej) => signal.addEventListener("abort", () => rej(new Error("per-call-timeout")))),
    };
    const r = await runDecode({ code: "049000028904", codeType: "upc_a", confidenceThreshold: 0.8, providers: [slow], budgetMs: 5000, providerTimeoutMs: 30 });
    expect(r.providerStatuses.find((s) => s.provider === "openai")?.status).toBe("timeout");
  });

  it("marks a provider that returns a usable product as ok", async () => {
    const ok: DecodeProvider = { name: "openai", lookup: async () => coke() };
    const r = await runDecode({ code: "049000028904", codeType: "upc_a", confidenceThreshold: 0.8, providers: [ok], budgetMs: 5000 });
    expect(r.providerStatuses.find((s) => s.provider === "openai")?.status).toBe("ok");
  });

  it("uses the page-fetch enrich result + reports latency", async () => {
    // Provider finds nothing; the page-fetch result is authoritative.
    const p: DecodeProvider = { name: "openai", lookup: async () => emptyResult() };
    const r = await runDecode({
      code: "049000028904",
      codeType: "upc_a",
      confidenceThreshold: 0.8,
      providers: [p],
      enrich: async () => ({ result: coke(), evidence: { verified: true, strength: "fetched_source", matchedCode: "049000028904", matchedSources: ["go-upc"], reason: "" } }),
      budgetMs: 13_000,
    });
    expect(r.timedOut).toBe(false);
    expect(r.decision.status).toBe("verified"); // page-fetch fetched_source verifies it
    expect(typeof r.latencyMs).toBe("number");
  });
});
