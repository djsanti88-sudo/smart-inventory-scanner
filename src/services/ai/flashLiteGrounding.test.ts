import { describe, it, expect, vi } from "vitest";
import { groundIdentify } from "@/services/ai/flashLiteGrounding";

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

describe("flash-lite grounding", () => {
  it("returns text + grounded on a usable answer, using flash-lite + google_search", async () => {
    const f = mockFetch(geminiOk);
    const r = await groundIdentify("086699087829", { apiKey: "k", fetch: f });
    expect(r?.text).toMatch(/Michelin/);
    const call = (f as any).mock.calls[0];
    expect(call[0]).toContain("gemini-flash-lite-latest");
    expect(JSON.parse(call[1].body).tools[0]).toHaveProperty("google_search");
  });
  it("uses url_context when a url is provided", async () => {
    const f = mockFetch(geminiOk);
    await groundIdentify("086699087829", { url: "https://x/y", apiKey: "k", fetch: f });
    expect(JSON.parse((f as any).mock.calls[0][1].body).tools[0]).toHaveProperty("url_context");
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
});
