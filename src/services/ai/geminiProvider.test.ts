import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createGeminiProvider } from "@/services/ai/geminiProvider";
import type { AiLookupRequest } from "@/services/ai/provider";

// Gemini "thinking" is ON by default for 2.5 Flash, which makes grounded calls take 10-30s and burn
// thinking tokens. These tests pin the request config: thinking OFF + a maxOutputTokens cap for FLASH
// models (fast + cheap), but NEVER thinkingBudget:0 for a PRO model (2.5 Pro rejects a 0 budget).

const REQ: AiLookupRequest = { rawCodeSanitized: "012345678905", cleanCodeSanitized: "012345678905" };

function mockFetchCapture() {
  const bodies: Array<Record<string, unknown>> = [];
  const fn = vi.fn(async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    return {
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: '{"productName":"Test"}' }] }, groundingMetadata: {} }] }),
      text: async () => "",
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fn);
  return bodies;
}

describe("geminiProvider thinking/cost config", () => {
  beforeEach(() => {
    process.env.GEMINI_API_KEY = "test-key";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GEMINI_API_KEY;
  });

  it("disables thinking and caps output tokens for a FLASH model", async () => {
    const bodies = mockFetchCapture();
    await createGeminiProvider({ model: "gemini-flash-latest" }).lookup(REQ);
    const gc = (bodies[0].generationConfig ?? {}) as Record<string, unknown>;
    expect(gc.thinkingConfig).toEqual({ thinkingBudget: 0 });
    expect(typeof gc.maxOutputTokens).toBe("number");
    expect(gc.maxOutputTokens as number).toBeGreaterThan(0);
  });

  it("does NOT force thinkingBudget:0 on a PRO model (2.5 Pro rejects it)", async () => {
    const bodies = mockFetchCapture();
    await createGeminiProvider({ model: "gemini-2.5-pro" }).lookup(REQ);
    const gc = (bodies[0].generationConfig ?? {}) as Record<string, unknown>;
    const tc = gc.thinkingConfig as { thinkingBudget?: number } | undefined;
    expect(tc?.thinkingBudget).not.toBe(0);
  });
});
