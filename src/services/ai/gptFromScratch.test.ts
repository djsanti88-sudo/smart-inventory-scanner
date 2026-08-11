import { afterEach, describe, expect, test, vi } from "vitest";
import { gptFromScratch, gptTierFor, GPT_LADDER_WORST_CASE_USD } from "./gptFromScratch";

const MODEL_JSON = {
  brand: "Falken", productName: "Falken Wildpeak A/T3W 265/70R17", category: "Tires", specs: "265/70R17 115T",
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

type CapturedGptRequestBody = {
  input?: string;
  model?: string;
  tools?: unknown;
  text?: {
    format?: {
      type?: string;
      name?: string;
      strict?: boolean;
      schema?: { additionalProperties?: boolean; required?: string[] };
    };
  };
};

function parseCapturedBody(init: RequestInit | undefined): CapturedGptRequestBody {
  return JSON.parse(String(init?.body ?? "{}")) as CapturedGptRequestBody;
}

function emptyOutputResponse(): Response {
  return { ok: true, json: async () => ({ output: [] }) } as Response;
}

function captureGptRequest() {
  let sentBody: CapturedGptRequestBody | null = null;
  const fetchImpl: typeof fetch = async (_url, init) => {
    sentBody = parseCapturedBody(init);
    return emptyOutputResponse();
  };
  return {
    fetchImpl,
    body: (): CapturedGptRequestBody => {
      if (!sentBody) throw new Error("expected gptFromScratch to send a request body");
      return sentBody;
    },
  };
}

describe("gptTierFor", () => {
  test("trust tiers follow the owner gate exactly (probe parity 2026-07-06: every non-verified answer with a name is a suggestion)", () => {
    expect(gptTierFor(true, 0.8, "X")).toBe("verified");
    expect(gptTierFor(true, 0.92, "X")).toBe("verified");
    expect(gptTierFor(false, 0.92, "X")).toBe("suggested");   // no exactCodeFound -> never verified
    expect(gptTierFor(true, 0.79, "X")).toBe("suggested");
    expect(gptTierFor(false, 0.5, "X")).toBe("suggested");
    expect(gptTierFor(false, 0.49, "X")).toBe("suggested");   // info_only deleted - weak guesses are shown
    expect(gptTierFor(true, 0.3, "X")).toBe("suggested");
  });

  test("honest-empty (prompt v3 2026-07-08): an empty productName is tier none, never suggested, whatever the flags say", () => {
    expect(gptTierFor(false, 0.4, "")).toBe("none");
    expect(gptTierFor(false, 0.4)).toBe("none");        // default arg is empty
    expect(gptTierFor(true, 0.95, "")).toBe("none");    // even a "verified"-looking answer with no name is none
    expect(gptTierFor(true, 0.95, "   ")).toBe("none"); // whitespace-only is still empty
  });
});

describe("gptFromScratch", () => {
  test("default abort cap is 35 seconds (owner-set 2026-07-06; exhaustion band tops out ~28s)", async () => {
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
      elapsed = 34_900;
      await vi.advanceTimersByTimeAsync(34_900);
      expect(abortedAt, "must NOT abort before 35s (a shorter cap would have fired here)").toBe(-1);
      elapsed = 35_100;
      await vi.advanceTimersByTimeAsync(200); // 35_100ms: the 35s cap must have fired
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
    const body = JSON.parse(vi.mocked(f).mock.calls[0][1]!.body as string);
    expect(body.model).toBe("gpt-5.4-mini");
    expect(body.tools).toEqual([{ type: "web_search", search_context_size: "medium" }]);
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body.max_output_tokens).toBe(6000);
    expect(body.max_tool_calls).toBe(5); // the owner-set probe cap, server-enforced by OpenAI
    expect(body.input).toContain("848983006257");
    expect(body.input).toContain("exactCodeFound");
    expect(r.category).toBe("Tires"); // parser reads the new category field
  });

  test("prompt v3 forbids invented products and drops the always-answer clause", async () => {
    const f = okFetch(respBody(MODEL_JSON));
    await gptFromScratch("848983006257", { apiKey: "k", fetchImpl: f });
    const body = JSON.parse(vi.mocked(f).mock.calls[0][1]!.body as string);
    expect(body.input).toContain("Never invent a product");
    expect(body.input).not.toContain("Never leave productName empty");
    expect(body.input).toContain("category"); // category is part of the JSON contract now
  });

  test("honest-empty: an empty productName is tier none (not a suggestion), category still surfaced", async () => {
    const f = okFetch(respBody({
      brand: "", productName: "", category: "music CD", confidence: 0,
      exactCodeFound: false, basis: "searched go-upc/tirerack, no listing carried this code",
    }));
    const r = await gptFromScratch("049000000000", { apiKey: "k", fetchImpl: f });
    expect(r.tier).toBe("none");
    expect(r.productName).toBe("");
    expect(r.category).toBe("music CD"); // UI can label the weak barcode even with no product
  });

  test("weak best-guess maps to suggested and keeps the guess text (info_only deleted 2026-07-06)", async () => {
    const f = okFetch(respBody({ ...MODEL_JSON, confidence: 0.3, exactCodeFound: false }));
    const r = await gptFromScratch("049000000000", { apiKey: "k", fetchImpl: f });
    expect(r.tier).toBe("suggested");
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

  describe("wave-3 Item E: 4xx pre-execution rejections bill $0, not worst case (2026-07-20 owner-approved)", () => {
    test.each([400, 401, 403, 404, 422])("HTTP %i is rejected pre-execution: usdActual is 0 (nothing was billable)", async (status) => {
      const f = vi.fn(async () => ({ ok: false, status, json: async () => ({ error: { message: "rejected" } }) })) as unknown as typeof fetch;
      const r = await gptFromScratch("049000000000", { apiKey: "k", fetchImpl: f });
      expect(r.tier).toBe("none");
      expect(r.usdActual).toBe(0);
      // usdWorstCase is always the documented worst-case CONSTANT (0.39) regardless of what was
      // actually billed - it is not a claim about this call's actual spend.
      expect(r.usdWorstCase).toBe(0.39);
    });

    test("401 sets the exact honest error message for the ladder's skip reason", async () => {
      const f = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: { message: "invalid_api_key" } }) })) as unknown as typeof fetch;
      const r = await gptFromScratch("049000000000", { apiKey: "bad-key", fetchImpl: f });
      expect(r.error).toBe("openai_auth_failed (check OPENAI_API_KEY)");
      expect(r.usdActual).toBe(0);
    });

    test.each([429, 500, 502, 503])("HTTP %i still bills worst case (may have executed or is ambiguous per cost-truth rule)", async (status) => {
      const f = vi.fn(async () => ({ ok: false, status, json: async () => ({ error: { message: "server-side" } }) })) as unknown as typeof fetch;
      const r = await gptFromScratch("049000000000", { apiKey: "k", fetchImpl: f });
      expect(r.tier).toBe("none");
      expect(r.usdActual).toBe(GPT_LADDER_WORST_CASE_USD);
    });

    test("a network error (not an HTTP response at all) still bills worst case, unaffected by the 4xx carve-out", async () => {
      const f = vi.fn(async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
      const r = await gptFromScratch("049000000000", { apiKey: "k", fetchImpl: f });
      expect(r.usdActual).toBe(GPT_LADDER_WORST_CASE_USD);
    });

    test("abort still bills worst case, unaffected by the 4xx carve-out", async () => {
      const f = vi.fn(async (_u: string, init: RequestInit) => {
        return await new Promise((_res, rej) => {
          init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
        });
      }) as unknown as typeof fetch;
      const r = await gptFromScratch("049000000000", { apiKey: "k", fetchImpl: f, timeoutMs: 20 });
      expect(r.aborted).toBe(true);
      expect(r.usdActual).toBe(GPT_LADDER_WORST_CASE_USD);
    });
  });

  test("abort: fetch rejecting with AbortError -> aborted true, usdActual = worst case", async () => {
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

  describe("wave-3: external signal threading (2026-07-20 owner-ratified)", () => {
    test("aborts the HTTP call when an externally-passed signal fires, even before the internal 35s timeout", async () => {
      let sawSignal: AbortSignal | undefined;
      const f = ((_u: string, init: RequestInit) =>
        new Promise((_res, rej) => {
          sawSignal = init.signal ?? undefined;
          init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
        })) as unknown as typeof fetch;
      const external = new AbortController();
      const p = gptFromScratch("848983006257", { apiKey: "k", fetchImpl: f, signal: external.signal });
      external.abort();
      const r = await p;
      expect(r.aborted).toBe(true);
      expect(sawSignal?.aborted).toBe(true);
    });

    test("with no external signal passed, behaves exactly as before (internal 35s timeout still governs)", async () => {
      const f = ((_u: string, init: RequestInit) =>
        new Promise((_res, rej) => {
          init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
        })) as unknown as typeof fetch;
      const r = await gptFromScratch("848983006257", { apiKey: "k", fetchImpl: f, timeoutMs: 10 });
      expect(r.aborted).toBe(true);
    });
  });

  test("Z4: prompt teaches GTIN zero-padding equivalence (code property, not an answer hint)", async () => {
    const captured = captureGptRequest();
    await gptFromScratch("0049000006346", { apiKey: "k", fetchImpl: captured.fetchImpl });
    expect(captured.body().input).toContain("zero-padding variants");
    expect(captured.body().input).toContain("shortest form");
  });

  describe("wave-3: GPT_SEARCH_CONTEXT env override (2026-07-20 owner-ratified)", () => {
    afterEach(() => { delete process.env.GPT_SEARCH_CONTEXT; });
    test("defaults to medium when unset (raised from low - low starved the model of search context)", async () => {
      const f = okFetch(respBody(MODEL_JSON));
      await gptFromScratch("848983006257", { apiKey: "k", fetchImpl: f });
      const body = JSON.parse(vi.mocked(f).mock.calls[0][1]!.body as string);
      expect(body.tools).toEqual([{ type: "web_search", search_context_size: "medium" }]);
    });
    test("uses the env override when set", async () => {
      process.env.GPT_SEARCH_CONTEXT = "high";
      const f = okFetch(respBody(MODEL_JSON));
      await gptFromScratch("848983006257", { apiKey: "k", fetchImpl: f });
      const body = JSON.parse(vi.mocked(f).mock.calls[0][1]!.body as string);
      expect(body.tools).toEqual([{ type: "web_search", search_context_size: "high" }]);
    });
  });

  describe("G2: GPT_LADDER_MODEL env override", () => {
    afterEach(() => { delete process.env.GPT_LADDER_MODEL; });
    test("defaults to gpt-5.4-mini when unset", async () => {
      const c = captureGptRequest();
      await gptFromScratch("049000006346", { apiKey: "k", fetchImpl: c.fetchImpl });
      expect(c.body().model).toBe("gpt-5.4-mini");
    });
    test("uses the env model when set", async () => {
      process.env.GPT_LADDER_MODEL = "gpt-6-preview";
      const c = captureGptRequest();
      await gptFromScratch("049000006346", { apiKey: "k", fetchImpl: c.fetchImpl });
      expect(c.body().model).toBe("gpt-6-preview");
    });
  });

  test("G1: requests structured output via json_schema so non-JSON replies are impossible", async () => {
    const captured = captureGptRequest();
    await gptFromScratch("049000006346", { apiKey: "k", fetchImpl: captured.fetchImpl });
    expect(captured.body().text?.format?.type).toBe("json_schema");
    expect(captured.body().text?.format?.name).toBe("product_identity");
    expect(captured.body().text?.format?.strict).toBe(true);
    expect(captured.body().text?.format?.schema?.additionalProperties).toBe(false);
    expect(captured.body().text?.format?.schema?.required).toEqual(
      expect.arrayContaining(["brand", "productName", "confidence", "exactCodeFound", "basis", "sourceUrls"]),
    );
  });
});
