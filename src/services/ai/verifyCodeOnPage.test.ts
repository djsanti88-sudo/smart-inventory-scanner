// @vitest-environment node
//
// verifyCodeOnPage: the grounding-first FETCH verification. Fetches up to 2 candidate URLs and returns the
// first page whose text carries the exact code (or a GTIN zero-padding variant). All network is mocked -
// ZERO live fetch is ever made here.

import { describe, it, expect, vi } from "vitest";
import { verifyCodeOnPage, pageTextHasCode } from "@/services/ai/verifyCodeOnPage";

const CODE = "737870166917"; // the glycine code from the owner's live test

function pageFetch(map: Record<string, { ok?: boolean; status?: number; body?: string; throws?: boolean }>) {
  return vi.fn(async (url: string) => {
    const entry = map[url];
    if (!entry || entry.throws) throw new Error("network down");
    return {
      ok: entry.ok ?? true,
      status: entry.status ?? 200,
      text: async () => entry.body ?? "",
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("pageTextHasCode", () => {
  it("matches the exact code", () => {
    expect(pageTextHasCode(`Glycine 1000mg UPC ${CODE} by Life Extension`, CODE)).toBe(true);
  });
  it("matches a zero-padded GTIN-13 variant of a UPC-12", () => {
    const upc12 = "086699087829";
    expect(pageTextHasCode(`EAN 0${upc12} listing`, upc12)).toBe(true);
  });
  it("matches when the printed code is spaced/hyphenated", () => {
    expect(pageTextHasCode("barcode 7 37870 16691 7 on label", CODE)).toBe(true);
  });
  it("does NOT match the code as a substring of a longer digit run", () => {
    expect(pageTextHasCode(`SKU 9${CODE}9 unrelated`, CODE)).toBe(false);
  });
  it("returns false for empty inputs", () => {
    expect(pageTextHasCode("", CODE)).toBe(false);
    expect(pageTextHasCode("anything", "")).toBe(false);
  });
});

describe("verifyCodeOnPage", () => {
  it("returns the first url whose page text contains the code", async () => {
    const f = pageFetch({
      "https://a.com": { body: "unrelated page, no barcode" },
      "https://b.com": { body: `Glycine by Life Extension - UPC ${CODE}` },
    });
    const r = await verifyCodeOnPage(["https://a.com", "https://b.com"], CODE, { fetch: f });
    expect(r?.url).toBe("https://b.com");
    expect(r?.pageText).toMatch(/Life Extension/);
  });

  it("returns the url when the page prints a zero-padded variant", async () => {
    const upc12 = "086699087829";
    const f = pageFetch({ "https://x.com": { body: `GTIN 0${upc12} Michelin listing` } });
    const r = await verifyCodeOnPage(["https://x.com"], upc12, { fetch: f });
    expect(r?.url).toBe("https://x.com");
  });

  it("returns null when no fetched page contains the code", async () => {
    const f = pageFetch({
      "https://a.com": { body: "nothing here" },
      "https://b.com": { body: "still nothing" },
    });
    const r = await verifyCodeOnPage(["https://a.com", "https://b.com"], CODE, { fetch: f });
    expect(r).toBeNull();
  });

  it("skips a throwing fetch (not fatal) and still finds the code on the next url", async () => {
    const f = pageFetch({
      "https://boom.com": { throws: true },
      "https://good.com": { body: `code ${CODE} here` },
    });
    const r = await verifyCodeOnPage(["https://boom.com", "https://good.com"], CODE, { fetch: f });
    expect(r?.url).toBe("https://good.com");
  });

  it("returns null (never throws) when every fetch throws", async () => {
    const f = pageFetch({ "https://boom.com": { throws: true } });
    await expect(verifyCodeOnPage(["https://boom.com"], CODE, { fetch: f })).resolves.toBeNull();
  });

  it("skips a non-OK response", async () => {
    const f = pageFetch({ "https://err.com": { ok: false, status: 500, body: `code ${CODE}` } });
    const r = await verifyCodeOnPage(["https://err.com"], CODE, { fetch: f });
    expect(r).toBeNull();
  });

  it("fetches AT MOST the first 2 urls (cost guard)", async () => {
    const calls: string[] = [];
    const f = vi.fn(async (url: string) => {
      calls.push(url);
      return { ok: true, status: 200, text: async () => "no code" } as unknown as Response;
    }) as unknown as typeof fetch;
    await verifyCodeOnPage(["https://1.com", "https://2.com", "https://3.com"], CODE, { fetch: f });
    expect(calls).toEqual(["https://1.com", "https://2.com"]); // 3rd url is never fetched
  });

  it("uses redirect:follow + a browser User-Agent + an abort signal", async () => {
    let seenInit: RequestInit | undefined;
    const f = vi.fn(async (_url: string, init: RequestInit) => {
      seenInit = init;
      return { ok: true, status: 200, text: async () => `code ${CODE}` } as unknown as Response;
    }) as unknown as typeof fetch;
    await verifyCodeOnPage(["https://x.com"], CODE, { fetch: f });
    expect(seenInit?.redirect).toBe("follow");
    expect((seenInit?.headers as Record<string, string>)["User-Agent"]).toMatch(/Mozilla/);
    expect(seenInit?.signal).toBeTruthy();
  });
});
