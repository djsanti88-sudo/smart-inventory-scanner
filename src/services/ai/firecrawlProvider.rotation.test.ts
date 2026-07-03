import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { firecrawlScrapeCheap, firecrawlKeysFromEnv, type FcFetch } from "@/services/ai/firecrawlProvider";

// Plan D Task 1: cost-optimized 1-credit basic scrape + 4-key rotation. ZERO live Firecrawl calls -
// fetch is always mocked here. Env keys are fake test strings, never real credentials.

const ORIGINAL_ENV = { ...process.env };

function resetEnvKeys() {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.FIRECRAWL_API_KEY_1;
  delete process.env.FIRECRAWL_API_KEY_2;
  delete process.env.FIRECRAWL_API_KEY_3;
  delete process.env.FIRECRAWL_API_KEY_4;
  delete process.env.FIRECRAWL_API_KEY;
}

describe("firecrawlScrapeCheap (cost-optimized scrape + 4-key rotation)", () => {
  beforeEach(() => {
    resetEnvKeys();
    process.env.FIRECRAWL_API_KEY_1 = "test-key-1";
    process.env.FIRECRAWL_API_KEY_2 = "test-key-2";
    process.env.FIRECRAWL_API_KEY_3 = "test-key-3";
    process.env.FIRECRAWL_API_KEY_4 = "test-key-4";
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("firecrawlKeysFromEnv reads FIRECRAWL_API_KEY_1..4 in order", () => {
    expect(firecrawlKeysFromEnv()).toEqual(["test-key-1", "test-key-2", "test-key-3", "test-key-4"]);
  });

  it("scrapes with markdown + onlyMainContent (basic proxy), NEVER json/LLM-extract mode", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    const fetchImpl = (async (_url: string, init?: { body?: string }) => {
      capturedBody = JSON.parse(init?.body ?? "{}");
      return { ok: true, status: 200, json: async () => ({ data: { markdown: "# Widget\nUPC 810118139604", metadata: { title: "Widget" } } }) };
    }) as unknown as FcFetch;

    const result = await firecrawlScrapeCheap("https://store.example.com/p/widget", { fetchImpl });

    expect(result?.markdown).toContain("Widget");
    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.formats).toEqual(["markdown"]);
    expect(capturedBody!.onlyMainContent).toBe(true);
    expect(capturedBody!.proxy).toBe("basic");
    // NEVER the expensive json/LLM-extract mode.
    expect(capturedBody!.formats).not.toContain("json");
    expect(capturedBody).not.toHaveProperty("extract");
    expect(capturedBody).not.toHaveProperty("jsonOptions");
  });

  it("rotates key 1 -> 402, key 2 -> 429, key 3 -> 200 and returns key 3's content, trying keys in order", async () => {
    const triedAuthHeaders: string[] = [];
    const fetchImpl = (async (_url: string, init?: { headers?: Record<string, string> }) => {
      const auth = init?.headers?.Authorization ?? "";
      triedAuthHeaders.push(auth);
      if (auth === "Bearer test-key-1") return { ok: false, status: 402, json: async () => ({}) };
      if (auth === "Bearer test-key-2") return { ok: false, status: 429, json: async () => ({}) };
      if (auth === "Bearer test-key-3") {
        return { ok: true, status: 200, json: async () => ({ data: { markdown: "found via key 3", metadata: { title: "Key3 Product" } } }) };
      }
      return { ok: false, status: 500, json: async () => ({}) };
    }) as unknown as FcFetch;

    const result = await firecrawlScrapeCheap("https://store.example.com/p/widget", { fetchImpl });

    expect(result?.markdown).toBe("found via key 3");
    expect(result?.title).toBe("Key3 Product");
    expect(result?.keyIndex).toBe(2); // 0-based: key 3 is index 2
    expect(triedAuthHeaders).toEqual(["Bearer test-key-1", "Bearer test-key-2", "Bearer test-key-3"]);
  });

  it("returns a clean null (never throws) when all 4 keys are exhausted (402/429)", async () => {
    const triedAuthHeaders: string[] = [];
    const fetchImpl = (async (_url: string, init?: { headers?: Record<string, string> }) => {
      triedAuthHeaders.push(init?.headers?.Authorization ?? "");
      return { ok: false, status: 402, json: async () => ({}) };
    }) as unknown as FcFetch;

    await expect(firecrawlScrapeCheap("https://store.example.com/p/widget", { fetchImpl })).resolves.toBeNull();
    expect(triedAuthHeaders).toEqual([
      "Bearer test-key-1",
      "Bearer test-key-2",
      "Bearer test-key-3",
      "Bearer test-key-4",
    ]);
  });

  it("returns null without ever calling fetch when no keys are configured", async () => {
    resetEnvKeys();
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as FcFetch;

    const result = await firecrawlScrapeCheap("https://store.example.com/p/widget", { fetchImpl });

    expect(result).toBeNull();
    expect(called).toBe(false);
  });

  it("supports the Firecrawl maxAge server-side cache param", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    const fetchImpl = (async (_url: string, init?: { body?: string }) => {
      capturedBody = JSON.parse(init?.body ?? "{}");
      return { ok: true, status: 200, json: async () => ({ data: { markdown: "cached page", metadata: { title: "T" } } }) };
    }) as unknown as FcFetch;

    await firecrawlScrapeCheap("https://store.example.com/p/widget", { fetchImpl }, { maxAge: 3600000 });

    expect(capturedBody!.maxAge).toBe(3600000);
  });

  it("blocks an unsafe/internal URL before spending any credit (SSRF)", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as FcFetch;

    const result = await firecrawlScrapeCheap("http://169.254.169.254/latest/meta-data", { fetchImpl });

    expect(result).toBeNull();
    expect(called).toBe(false);
  });

  it("explicit apiKeys deps override env keys", async () => {
    const triedAuthHeaders: string[] = [];
    const fetchImpl = (async (_url: string, init?: { headers?: Record<string, string> }) => {
      triedAuthHeaders.push(init?.headers?.Authorization ?? "");
      return { ok: true, status: 200, json: async () => ({ data: { markdown: "ok", metadata: { title: "T" } } }) };
    }) as unknown as FcFetch;

    await firecrawlScrapeCheap("https://store.example.com/p/widget", { fetchImpl, apiKeys: ["explicit-key"] });

    expect(triedAuthHeaders).toEqual(["Bearer explicit-key"]);
  });
});
