import { describe, it, expect } from "vitest";
import { runDecode, type DecodeProvider } from "@/services/ai/decodeOrchestrator";
import { emptyResult } from "@/services/ai/provider";
import type { AiLookupResult, EvidenceResult } from "@/types";

function coke(): AiLookupResult {
  return { ...emptyResult(), productName: "Coca-Cola Classic", brand: "Coca-Cola", upc: "049000028904", sourceSnippets: ["UPC 049000028904 Coca-Cola"], confidence: 0.96 };
}
function suggestion(): AiLookupResult {
  return { ...emptyResult(), productName: "Maybe Snack", brand: "Generic", upc: "049000028904", sourceUrls: ["https://x"], confidence: 0.5 };
}

describe("runDecode - time budget + concurrency", () => {
  it("returns a VERIFIED result quickly when TWO providers agree + evidence verifies (no timeout)", async () => {
    // Auto-count requires two independent sources to agree (Gemini Flash + ChatGPT mini in parallel).
    const a: DecodeProvider = { name: "gemini", lookup: async () => coke() };
    const b: DecodeProvider = { name: "openai", lookup: async () => coke() };
    const r = await runDecode({
      code: "049000028904",
      codeType: "upc_a",
      confidenceThreshold: 0.8,
      providers: [a, b],
      budgetMs: 13_000,
    });
    expect(r.timedOut).toBe(false);
    expect(r.decision.status).toBe("verified");
  });

  it("a SINGLE provider on its own does NOT auto-verify - it is Suggested (needs a second agreeing source)", async () => {
    const p: DecodeProvider = { name: "openai", lookup: async () => coke() };
    const r = await runDecode({
      code: "049000028904",
      codeType: "upc_a",
      confidenceThreshold: 0.8,
      providers: [p],
      budgetMs: 13_000,
    });
    expect(r.timedOut).toBe(false);
    expect(r.decision.status).toBe("suggested");
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

  it("uses the page-fetch enrich result (single source -> Suggested) + reports latency", async () => {
    // Provider finds nothing; the page-fetch result is the ONLY source. One source alone cannot
    // auto-count under the two-source rule, so it lands as Suggested (human review) - but it is used.
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
    expect(r.decision.status).toBe("suggested"); // single source: shown + reviewable, not auto-counted
    expect(r.results.some((x) => x.productName === "Coca-Cola Classic")).toBe(true); // page-fetch result IS used
    expect(typeof r.latencyMs).toBe("number");
  });

  it("a provider + the page-fetch enrich that AGREE verify (two independent sources)", async () => {
    // The page-fetch acts as a second independent source: provider + page-fetch landing on the same
    // identity is exactly the agreement the two-source rule wants -> auto-counted.
    const p: DecodeProvider = { name: "openai", lookup: async () => coke() };
    const r = await runDecode({
      code: "049000028904",
      codeType: "upc_a",
      confidenceThreshold: 0.8,
      providers: [p],
      enrich: async () => ({ result: coke(), evidence: { verified: true, strength: "fetched_source", matchedCode: "049000028904", matchedSources: ["go-upc"], reason: "" } }),
      budgetMs: 13_000,
    });
    expect(r.timedOut).toBe(false);
    expect(r.decision.status).toBe("verified");
  });
});

// --- W1 (v1.0.0): verified-only early exit. The old name-only "trust-the-AI" fast path is removed:
// a usable product NAME no longer stops the wait; only an app-VERIFIED decision (or the budget) does.
function namedWeak(name: string, brand: string): AiLookupResult {
  // Usable product NAME but only weak (untrusted URL, no exact-code evidence) -> must NOT be trusted.
  return { ...emptyResult(), productName: name, brand, upc: "049000028904", sourceUrls: ["https://untrusted.example"], confidence: 0.96 };
}

describe("runDecode - W1 verified-only early exit", () => {
  it("does NOT early-exit on a usable product name alone; waits for the page-fetch to VERIFY", async () => {
    const weakNamed: DecodeProvider = { name: "openai", lookup: async () => namedWeak("Coca-Cola Classic", "Coca-Cola") };
    // The slower page-fetch supplies fetched_source evidence that actually verifies the exact code.
    const enrich = (signal: AbortSignal) =>
      new Promise<{ result: AiLookupResult; evidence: EvidenceResult }>((res, rej) => {
        const t = setTimeout(
          () =>
            res({
              result: { ...emptyResult(), productName: "Coca-Cola Classic", brand: "Coca-Cola", upc: "049000028904", confidence: 0.92 },
              evidence: { verified: true, strength: "fetched_source", matchedCode: "049000028904", matchedSources: ["go-upc"], reason: "" },
            }),
          40,
        );
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          rej(new Error("aborted"));
        });
      });
    const r = await runDecode({ code: "049000028904", codeType: "upc_a", confidenceThreshold: 0.8, providers: [weakNamed], enrich, budgetMs: 13_000 });
    // Old fast path would have stopped at the unverified name (suggested) and aborted the enrich.
    expect(r.timedOut).toBe(false);
    expect(r.decision.status).toBe("verified");
    expect(r.providerNames).toContain("page-fetch");
  });

  it("exits early as soon as TWO providers agree (app-VERIFIED) - does not wait for a hung third provider", async () => {
    // Stricter pipeline: auto-verify needs two independent sources to agree. Once they do, the run
    // early-exits and does NOT wait for a third hung provider (whose 10s timeout > vitest's 5s would hang).
    const fastA: DecodeProvider = { name: "gemini", lookup: async () => coke() };
    const fastB: DecodeProvider = { name: "openai", lookup: async () => coke() };
    const hung: DecodeProvider = {
      name: "premium",
      lookup: (signal) => new Promise<AiLookupResult>((_, rej) => signal.addEventListener("abort", () => rej(new Error("aborted")))),
    };
    const r = await runDecode({ code: "049000028904", codeType: "upc_a", confidenceThreshold: 0.8, providers: [fastA, fastB, hung], budgetMs: 13_000, providerTimeoutMs: 10_000 });
    expect(r.timedOut).toBe(false);
    expect(r.decision.status).toBe("verified");
  });

  it("routes conflicting providers to conflict (never verified, never auto-counted)", async () => {
    const a: DecodeProvider = { name: "gemini", lookup: async () => namedWeak("Powdered Creamer", "Laird") };
    const b: DecodeProvider = { name: "openai", lookup: async () => namedWeak("Duplex Receptacle", "Leviton") };
    const r = await runDecode({ code: "049000028904", codeType: "upc_a", confidenceThreshold: 0.8, providers: [a, b], budgetMs: 13_000 });
    expect(r.timedOut).toBe(false);
    expect(r.decision.status).toBe("conflict");
    expect(r.decision.exactCodeEvidenceVerifiedByApp).toBe(false);
  });

  it("a single usable-but-weak provider stays Suggested, never Verified (no auto-count)", async () => {
    const weak: DecodeProvider = { name: "openai", lookup: async () => namedWeak("Maybe Snack", "Generic") };
    const r = await runDecode({ code: "049000028904", codeType: "upc_a", confidenceThreshold: 0.8, providers: [weak], budgetMs: 13_000 });
    expect(r.decision.status).toBe("suggested");
    expect(r.decision.exactCodeEvidenceVerifiedByApp).toBe(false);
  });

  it("855724007602 (known live decode) VERIFIES under the stricter pipeline when TWO sources agree with evidence", async () => {
    const natureWise = (name: string): DecodeProvider => ({
      name,
      lookup: async () => ({
        ...emptyResult(),
        productName: "NatureWise Omega 3 1000 Mg + Vitamin E",
        brand: "NatureWise",
        upc: "855724007602",
        sourceSnippets: ["NatureWise Omega 3 1000 Mg + Vitamin E UPC 855724007602 fish oil supplement"],
        confidence: 0.95,
      }),
    });
    const r = await runDecode({ code: "855724007602", codeType: "upc_a", confidenceThreshold: 0.85, providers: [natureWise("gemini"), natureWise("openai")], budgetMs: 13_000 });
    expect(r.timedOut).toBe(false);
    expect(r.decision.status).toBe("verified");
    expect(r.results[0]?.productName).toMatch(/NatureWise Omega 3/);
  });
});
