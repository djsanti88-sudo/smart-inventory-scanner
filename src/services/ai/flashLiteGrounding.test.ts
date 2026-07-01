import { describe, it, expect, vi } from "vitest";
import { groundIdentify } from "@/services/ai/flashLiteGrounding";

const geminiOk = { candidates: [{ content: { parts: [{ text: "Michelin LTX M/S2 tire" }] } }] };
const geminiEmpty = { candidates: [{ content: { role: "model" } }] };
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
  it("returns null on empty content", async () => {
    const r = await groundIdentify("086699087829", { apiKey: "k", fetch: mockFetch(geminiEmpty) });
    expect(r).toBeNull();
  });
});
