import { describe, it, expect } from "vitest";
import { discoverViaFirecrawl, urlPreferenceScore, type FcFetch } from "@/services/ai/firecrawlProvider";

// Mock the Firecrawl REST API (no live calls / credits). Real shapes confirmed against api.firecrawl.dev/v2.
function mockFc(search: Array<{ url: string; title: string }>, scrapeMap: Record<string, { markdown: string; title: string }>): { fetchImpl: FcFetch; scraped: string[] } {
  const scraped: string[] = [];
  const fetchImpl = (async (url: string, init?: { body?: string }) => {
    if (url.endsWith("/search")) {
      return { ok: true, status: 200, json: async () => ({ success: true, data: { web: search } }) };
    }
    if (url.endsWith("/scrape")) {
      const body = JSON.parse(init?.body ?? "{}") as { url: string };
      scraped.push(body.url);
      const page = scrapeMap[body.url] ?? { markdown: "", title: "" };
      return { ok: true, status: 200, json: async () => ({ success: true, data: { markdown: page.markdown, metadata: { title: page.title } } }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }) as unknown as FcFetch;
  return { fetchImpl, scraped };
}

const FAIRE = "https://www.faire.com/product/p_uxqrb39cyu";
const FAIRE_TITLE = "Wholesale Acrylic Paint Markers Set – 24 Metallic Colors, 2mm Bullet Tip";

describe("discoverViaFirecrawl (Stage-2 fallback, mocked)", () => {
  it("finds the product even when the real listing ranks #4 (regression: old code only scraped top 3)", async () => {
    // Mirrors the live failure: barcode-DB noise + marketplaces rank above Faire, which is result #4.
    const { fetchImpl, scraped } = mockFc(
      [
        { url: "https://go-upc.com/search?q=810118139604", title: "Product Not Found - Go-UPC" },
        { url: "https://hdsupplysolutions.com/p/squeegee", title: "Libman Squeegee" },
        { url: "https://www.ebay.com/p/123", title: "Bowling Bag" },
        { url: FAIRE, title: FAIRE_TITLE }, // <-- #4, missed by the old slice(0,3)
      ],
      {
        "https://go-upc.com/search?q=810118139604": { markdown: "Sorry, we were not able to find a product for UPC 810118139604", title: "Product Not Found - Go-UPC" },
        "https://hdsupplysolutions.com/p/squeegee": { markdown: "Libman squeegee, no barcode here", title: "Libman Squeegee" },
        "https://www.ebay.com/p/123": { markdown: "bowling bag listing", title: "Bowling Bag" },
        [FAIRE]: { markdown: "Details. SKU: 409-24M ... UPC 810118139604 ... 24 metallic colors", title: FAIRE_TITLE },
      },
    );
    const disc = await discoverViaFirecrawl("810118139604", "upc_a", { apiKey: "k", fetchImpl });
    expect(disc.status).toBe("ok");
    expect(disc.result?.productName).toContain("Acrylic Paint Markers");
    expect(disc.evidence.verified).toBe(true);
    expect(scraped).toContain(FAIRE); // the #4 candidate WAS opened
    // The go-upc "not found" page echoes the code but yields no usable product -> correctly skipped.
    expect(disc.result?.sourceUrls?.[0]).toBe(FAIRE);
  });

  it("recovers the match when an earlier candidate's scrape fails (parallel resilience)", async () => {
    const FAIL = "https://flaky.example.com/p/x";
    const baseImpl = mockFc(
      [{ url: FAIL, title: "Flaky" }, { url: FAIRE, title: FAIRE_TITLE }],
      { [FAIRE]: { markdown: "UPC 810118139604 SKU 409-24M 24 metallic colors", title: FAIRE_TITLE } },
    ).fetchImpl;
    // Wrap so scraping FAIL throws, but the search + the FAIRE scrape still work.
    const fetchImpl = (async (url: string, init?: { body?: string }) => {
      if (url.endsWith("/scrape") && JSON.parse(init?.body ?? "{}").url === FAIL) throw new Error("scrape boom");
      return baseImpl(url, init);
    }) as unknown as FcFetch;
    const disc = await discoverViaFirecrawl("810118139604", "upc_a", { apiKey: "k", fetchImpl });
    expect(disc.status).toBe("ok");
    expect(disc.result?.productName).toContain("Acrylic Paint Markers");
  });

  it("returns no_match when no scraped page contains the exact code", async () => {
    const { fetchImpl } = mockFc(
      [{ url: "https://store.com/p/1", title: "Some Other Thing" }],
      { "https://store.com/p/1": { markdown: "a different product entirely", title: "Some Other Thing" } },
    );
    const disc = await discoverViaFirecrawl("810118139604", "upc_a", { apiKey: "k", fetchImpl });
    expect(disc.status).toBe("no_match");
    expect(disc.result).toBeNull();
  });

  it("reports rate_limited when search returns 429 (not a fake not-found)", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 429, json: async () => ({}) })) as unknown as FcFetch;
    const disc = await discoverViaFirecrawl("810118139604", "upc_a", { apiKey: "k", fetchImpl });
    expect(disc.status).toBe("rate_limited");
  });

  it("flags coverageMissed when the search returned more results than maxScrape and none matched", async () => {
    // 5 safe results, none with the code, but maxScrape=2 -> we only opened 2, the product MIGHT be on
    // one of the 3 we never reached. That is a coverage gap, distinct from "searched everything".
    const results = Array.from({ length: 5 }, (_, i) => ({ url: `https://store${i}.com/item/${i}`, title: `Thing ${i}` }));
    const scrapeMap = Object.fromEntries(results.map((r) => [r.url, { markdown: "no barcode here", title: r.title }]));
    const { fetchImpl } = mockFc(results, scrapeMap);
    const disc = await discoverViaFirecrawl("810118139604", "upc_a", { apiKey: "k", fetchImpl }, { maxScrape: 2 });
    expect(disc.status).toBe("no_match");
    expect(disc.coverageMissed).toBe(true);
  });

  it("does NOT flag coverageMissed when every safe result was opened", async () => {
    const { fetchImpl } = mockFc(
      [{ url: "https://store.com/item/1", title: "Other" }],
      { "https://store.com/item/1": { markdown: "a different product", title: "Other" } },
    );
    const disc = await discoverViaFirecrawl("810118139604", "upc_a", { apiKey: "k", fetchImpl }, { maxScrape: 6 });
    expect(disc.status).toBe("no_match");
    expect(disc.coverageMissed).toBe(false);
  });

  it("prefers product/listing URLs over search/cart/login noise (urlPreferenceScore)", () => {
    expect(urlPreferenceScore("https://www.faire.com/product/p_uxqrb39cyu")).toBeGreaterThan(0);
    expect(urlPreferenceScore("https://shop.com/dp/B000")).toBeGreaterThan(0);
    expect(urlPreferenceScore("https://go-upc.com/search?q=810118139604")).toBeLessThan(0);
    expect(urlPreferenceScore("https://store.com/cart")).toBeLessThan(0);
    expect(urlPreferenceScore("https://store.com/account/login")).toBeLessThan(0);
    // a product URL outranks a search URL
    expect(urlPreferenceScore("https://x.com/product/abc")).toBeGreaterThan(urlPreferenceScore("https://x.com/search?q=abc"));
  });

  it("opens the product page before a higher-ranked search page (preference beats raw rank)", async () => {
    // The search page is result #1 but is low value; the real product is #2. Preference reorders so the
    // product page is opened first - and with maxScrape=1 the search-only page would otherwise win.
    const { fetchImpl, scraped } = mockFc(
      [
        { url: "https://go-upc.com/search?q=810118139604", title: "Search" },
        { url: FAIRE, title: FAIRE_TITLE },
      ],
      {
        "https://go-upc.com/search?q=810118139604": { markdown: "Sorry, not found 810118139604", title: "Search" },
        [FAIRE]: { markdown: "UPC 810118139604 SKU 409-24M 24 metallic colors", title: FAIRE_TITLE },
      },
    );
    const disc = await discoverViaFirecrawl("810118139604", "upc_a", { apiKey: "k", fetchImpl }, { maxScrape: 1 });
    expect(disc.status).toBe("ok");
    expect(scraped).toContain(FAIRE); // the product page was chosen over the search page
    expect(scraped).not.toContain("https://go-upc.com/search?q=810118139604");
  });

  it("SSRF: never scrapes an unsafe candidate URL", async () => {
    const { fetchImpl, scraped } = mockFc(
      [
        { url: "http://169.254.169.254/latest/meta-data", title: "metadata" },
        { url: FAIRE, title: FAIRE_TITLE },
      ],
      { [FAIRE]: { markdown: "UPC 810118139604 SKU 409-24M", title: FAIRE_TITLE } },
    );
    const disc = await discoverViaFirecrawl("810118139604", "upc_a", { apiKey: "k", fetchImpl });
    expect(disc.status).toBe("ok");
    expect(scraped).not.toContain("http://169.254.169.254/latest/meta-data"); // blocked by SSRF guard
  });
});
