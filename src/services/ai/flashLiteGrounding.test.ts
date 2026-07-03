import { describe, it, expect, vi } from "vitest";
import { groundIdentify, getLastGroundingStatus } from "@/services/ai/flashLiteGrounding";

const geminiOk = { candidates: [{ content: { parts: [{ text: "Michelin LTX M/S2 tire" }] } }] };
const geminiEmpty = { candidates: [{ content: { role: "model" } }] };
// Real shape of a grounded response: groundingMetadata.groundingChunks[].web.{uri,title}.
const geminiGrounded = {
  candidates: [
    {
      content: { parts: [{ text: "Michelin LTX M/S2 tire" }] },
      groundingMetadata: {
        groundingChunks: [
          { web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc", title: "UPC 086699087829 - Michelin LTX M/S2 | go-upc" } },
          { web: { uri: "https://example.com/p/086699087829", title: "Michelin LTX" } },
          { web: {} }, // malformed chunk must not crash extraction
        ],
      },
    },
  ],
};
function mockFetch(json: unknown) { return vi.fn(async (url: string, init: RequestInit) => ({ ok: true, status: 200, json: async () => json, _url: url, _init: init })) as unknown as typeof fetch; }
const callsOf = (f: unknown) => (f as ReturnType<typeof vi.fn>).mock.calls;

describe("flash-lite grounding", () => {
  it("returns text + grounded on a usable answer, using flash-lite + google_search", async () => {
    const f = mockFetch(geminiOk);
    const r = await groundIdentify("086699087829", { apiKey: "k", fetch: f });
    expect(r?.text).toMatch(/Michelin/);
    const call = callsOf(f)[0];
    // default grounding model is Gemini 2.5 Flash-Lite (1,500 free grounding req/day; owner decision 2026-07-01)
    expect(call[0]).toContain("gemini-2.5-flash-lite");
    expect(JSON.parse(call[1].body).tools[0]).toHaveProperty("google_search");
  });
  it("uses url_context when a url is provided", async () => {
    const f = mockFetch(geminiOk);
    await groundIdentify("086699087829", { url: "https://x/y", apiKey: "k", fetch: f });
    expect(JSON.parse(callsOf(f)[0][1].body).tools[0]).toHaveProperty("url_context");
  });
  it("returns the grounding sources (chunk titles + uris) so the APP can verify code-in-sources", async () => {
    const r = await groundIdentify("086699087829", { apiKey: "k", fetch: mockFetch(geminiGrounded) });
    expect(r?.sources).toBeDefined();
    const joined = (r?.sources ?? []).join(" ");
    expect(joined).toContain("UPC 086699087829 - Michelin LTX M/S2 | go-upc");
    expect(joined).toContain("https://example.com/p/086699087829");
  });
  it("returns sourceUrls = ONLY the grounding chunk web.uri values (fetchable/redirect URLs)", async () => {
    const r = await groundIdentify("086699087829", { apiKey: "k", fetch: mockFetch(geminiGrounded) });
    expect(r?.sourceUrls).toEqual([
      "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc",
      "https://example.com/p/086699087829",
    ]);
    // titles are NOT in sourceUrls (those are fetched, not text-matched)
    expect((r?.sourceUrls ?? []).join(" ")).not.toContain("go-upc");
  });
  it("returns empty sources + sourceUrls when the response has no grounding metadata (never undefined)", async () => {
    const r = await groundIdentify("086699087829", { apiKey: "k", fetch: mockFetch(geminiOk) });
    expect(r?.sources).toEqual([]);
    expect(r?.sourceUrls).toEqual([]);
  });
  it("returns null on empty content", async () => {
    const r = await groundIdentify("086699087829", { apiKey: "k", fetch: mockFetch(geminiEmpty) });
    expect(r).toBeNull();
  });

  // Regression (2026-07-02): a live gemini-2.5-flash-lite 503 outage silently nulled EVERY grounding
  // vote, degrading the 3-source consensus to 2 correlated DBs (preview recall fell 18/21 -> 3/21).
  // A retryable provider failure must automatically fall back to the designated backup model.
  describe("model fallback on provider failure", () => {
    function mockFetchSeq(responses: Array<{ status: number; json?: unknown }>) {
      let i = 0;
      return vi.fn(async (url: string) => {
        const r = responses[Math.min(i++, responses.length - 1)];
        return { ok: r.status === 200, status: r.status, json: async () => r.json ?? { error: { message: "overloaded" } }, _url: url };
      }) as unknown as typeof fetch;
    }

    it("falls back to gemini-2.5-flash when the primary model returns 503, and still answers", async () => {
      const f = mockFetchSeq([{ status: 503 }, { status: 200, json: geminiOk }]);
      const r = await groundIdentify("086699087829", { apiKey: "k", fetch: f });
      expect(r?.text).toMatch(/Michelin/);
      const calls = callsOf(f);
      expect(calls.length).toBe(2);
      expect(calls[0][0]).toContain("gemini-2.5-flash-lite");
      // the 2.0 line is decommissioned for generateContent (live 404, 2026-07-02); fall back within 2.5
      expect(calls[1][0]).toContain("gemini-2.5-flash:");
      expect(getLastGroundingStatus()).toBe("fallback_hit");
    });

    it("returns null when primary AND fallback both fail, and surfaces the failure status", async () => {
      const f = mockFetchSeq([{ status: 503 }, { status: 503 }]);
      const r = await groundIdentify("086699087829", { apiKey: "k", fetch: f });
      expect(r).toBeNull();
      expect(getLastGroundingStatus()).toBe("error_503");
    });

    it("does NOT call the fallback model on a primary success", async () => {
      const f = mockFetch(geminiOk);
      await groundIdentify("086699087829", { apiKey: "k", fetch: f });
      expect(callsOf(f).length).toBe(1);
      expect(getLastGroundingStatus()).toBe("hit");
    });
  });
});
