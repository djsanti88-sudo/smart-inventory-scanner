import { describe, it, expect } from "vitest";
import { discoverViaFirecrawl, type FcFetch } from "@/services/ai/firecrawlProvider";

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
  it("finds the product on a scraped page that contains the exact code (Faire is not result #1)", async () => {
    const { fetchImpl } = mockFc(
      [
        { url: "https://hdsupplysolutions.com/p/squeegee", title: "Libman Squeegee" },
        { url: "https://www.ebay.com/p/123", title: "Bowling Bag" },
        { url: FAIRE, title: FAIRE_TITLE },
      ],
      {
        "https://hdsupplysolutions.com/p/squeegee": { markdown: "Libman squeegee, no barcode here", title: "Libman Squeegee" },
        "https://www.ebay.com/p/123": { markdown: "bowling bag listing", title: "Bowling Bag" },
        [FAIRE]: { markdown: "Details. SKU: 409-24M ... UPC 810118139604 ... 24 metallic colors", title: FAIRE_TITLE },
      },
    );
    const disc = await discoverViaFirecrawl("810118139604", "upc_a", { apiKey: "k", fetchImpl });
    expect(disc.status).toBe("ok");
    expect(disc.result?.productName).toContain("Acrylic Paint Markers");
    expect(disc.evidence.verified).toBe(true);
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
