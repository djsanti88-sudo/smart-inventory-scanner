import { describe, expect, test, vi } from "vitest";
import { gptFromScratch, gptTierFor } from "./gptFromScratch";

const MODEL_JSON = {
  brand: "Falken", productName: "Falken Wildpeak A/T3W 265/70R17", specs: "265/70R17 115T",
  gtin: "848983006257", confidence: 0.92, exactCodeFound: true,
  basis: "exact code on tirerack product page", sourceUrls: ["https://www.tirerack.com/x"],
};
const respBody = (json: unknown, searches = 2, inTok = 3000, outTok = 900) => ({
  output: [
    ...Array.from({ length: searches }, () => ({ type: "web_search_call" })),
    { type: "message", content: [{ type: "output_text", text: JSON.stringify(json) }] },
  ],
  usage: { input_tokens: inTok, output_tokens: outTok },
});
const okFetch = (body: unknown) =>
  vi.fn(async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch;

describe("gptTierFor", () => {
  test("trust tiers follow the owner gate exactly", () => {
    expect(gptTierFor(true, 0.8)).toBe("verified");
    expect(gptTierFor(true, 0.92)).toBe("verified");
    expect(gptTierFor(false, 0.92)).toBe("suggested");   // no exactCodeFound -> never verified
    expect(gptTierFor(true, 0.79)).toBe("suggested");
    expect(gptTierFor(false, 0.5)).toBe("suggested");
    expect(gptTierFor(false, 0.49)).toBe("info_only");
    expect(gptTierFor(true, 0.3)).toBe("info_only");
  });
});

describe("gptFromScratch", () => {
  test("default abort cap is 17 seconds (owner-set 2026-07-05, raised from 10s: 15/26 live calls aborted at 10s)", async () => {
    let abortedAt = -1;
    let elapsed = 0;
    const f = ((_u: string, init: RequestInit) =>
      new Promise((_res, rej) => {
        init.signal?.addEventListener("abort", () => {
          abortedAt = elapsed;
          rej(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      })) as unknown as typeof fetch;
    vi.useFakeTimers();
    try {
      const p = gptFromScratch("848983006257", { apiKey: "k", fetchImpl: f });
      elapsed = 16_900;
      await vi.advanceTimersByTimeAsync(16_900);
      expect(abortedAt, "must NOT abort before 17s (a 10s cap would have fired here)").toBe(-1);
      elapsed = 17_100;
      await vi.advanceTimersByTimeAsync(200); // 17_100ms: the 17s cap must have fired
      const r = await p;
      expect(r.aborted).toBe(true);
      expect(r.usdActual).toBe(0.39);
    } finally {
      vi.useRealTimers();
    }
  });

  test("sends the exact 21/21 config and parses a strong answer to verified", async () => {
    const f = okFetch(respBody(MODEL_JSON));
    const r = await gptFromScratch("848983006257", { apiKey: "k", fetchImpl: f });
    expect(r.tier).toBe("verified");
    expect(r.productName).toContain("Wildpeak");
    expect(r.searches).toBe(2);
    expect(r.usdActual).toBeCloseTo((3000 / 1e6) * 5 + (900 / 1e6) * 30 + 0.02, 5);
    const body = JSON.parse((f as any).mock.calls[0][1].body);
    expect(body.model).toBe("gpt-5.5");
    expect(body.tools).toEqual([{ type: "web_search", search_context_size: "low" }]);
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body.max_output_tokens).toBe(6000);
    expect(body.max_tool_calls).toBe(6);
    expect(body.input).toContain("848983006257");
    expect(body.input).toContain("exactCodeFound");
  });

  test("weak best-guess maps to info_only and keeps the guess text", async () => {
    const f = okFetch(respBody({ ...MODEL_JSON, confidence: 0.3, exactCodeFound: false }));
    const r = await gptFromScratch("049000000000", { apiKey: "k", fetchImpl: f });
    expect(r.tier).toBe("info_only");
    expect(r.productName).toContain("Wildpeak");
  });

  test("malformed JSON is contained: tier none + error, never a throw", async () => {
    const f = okFetch({ output: [{ type: "message", content: [{ type: "output_text", text: "not json {" }] }], usage: { input_tokens: 10, output_tokens: 5 } });
    const r = await gptFromScratch("049000000000", { apiKey: "k", fetchImpl: f });
    expect(r.tier).toBe("none");
    expect(r.error).toBeTruthy();
  });

  test("HTTP error is contained with status in error", async () => {
    const f = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({ error: { message: "rate" } }) })) as unknown as typeof fetch;
    const r = await gptFromScratch("049000000000", { apiKey: "k", fetchImpl: f });
    expect(r.tier).toBe("none");
    expect(r.error).toContain("429");
    expect(r.usdWorstCase).toBe(0.39);
  });

  test("10s abort: fetch rejecting with AbortError -> aborted true, usdActual = worst case", async () => {
    const f = vi.fn(async (_u: string, init: RequestInit) => {
      return await new Promise((_res, rej) => {
        init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    }) as unknown as typeof fetch;
    const p = gptFromScratch("049000000000", { apiKey: "k", fetchImpl: f, timeoutMs: 20 });
    const r = await p;
    expect(r.aborted).toBe(true);
    expect(r.usdActual).toBe(0.39); // billed server-side anyway: count worst case
    expect(r.tier).toBe("none");
  });

  test("confidence is clamped and junk fields tolerated", async () => {
    const f = okFetch(respBody({ brand: 7, productName: "X", confidence: 4, exactCodeFound: "yes", sourceUrls: "nope" }));
    const r = await gptFromScratch("049000000000", { apiKey: "k", fetchImpl: f });
    expect(r.confidence).toBeLessThanOrEqual(1);
    expect(Array.isArray(r.sourceUrls)).toBe(true);
    expect(typeof r.brand).toBe("string");
  });
});
