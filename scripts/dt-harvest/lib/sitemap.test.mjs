import { describe, it, expect } from "vitest";
import { parseSitemapXml, filterTireProductUrls } from "./sitemap.mjs";

const SITEMAP_INDEX = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>https://www.discounttire.com/sitemap-products-1.xml</loc>
  </sitemap>
  <sitemap>
    <loc>https://www.discounttire.com/sitemap-products-2.xml</loc>
  </sitemap>
</sitemapindex>`;

const CHILD_SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://www.discounttire.com/tires/michelin/defender-t-h-p123456</loc>
  </url>
  <url>
    <loc>https://www.discounttire.com/tires/goodyear/eagle-sport-p654321</loc>
  </url>
  <url>
    <loc>https://www.discounttire.com/store-locator/az/phoenix</loc>
  </url>
  <url>
    <loc>https://www.discounttire.com/tires-101/how-to-read-a-tire</loc>
  </url>
  <url>
    <loc>https://www.discounttire.com/about-us</loc>
  </url>
</urlset>`;

describe("parseSitemapXml", () => {
  it("extracts urls from a sitemap index (child sitemap locs)", () => {
    const urls = parseSitemapXml(SITEMAP_INDEX);
    expect(urls).toEqual([
      "https://www.discounttire.com/sitemap-products-1.xml",
      "https://www.discounttire.com/sitemap-products-2.xml",
    ]);
  });

  it("extracts urls from a child sitemap (product + non-product locs)", () => {
    const urls = parseSitemapXml(CHILD_SITEMAP);
    expect(urls).toEqual([
      "https://www.discounttire.com/tires/michelin/defender-t-h-p123456",
      "https://www.discounttire.com/tires/goodyear/eagle-sport-p654321",
      "https://www.discounttire.com/store-locator/az/phoenix",
      "https://www.discounttire.com/tires-101/how-to-read-a-tire",
      "https://www.discounttire.com/about-us",
    ]);
  });

  it("returns [] for malformed XML without throwing", () => {
    expect(() => parseSitemapXml("<not><valid<xml")).not.toThrow();
    expect(parseSitemapXml("<not><valid<xml")).toEqual([]);
  });

  it("returns [] for empty string", () => {
    expect(parseSitemapXml("")).toEqual([]);
  });

  it("returns [] for null/undefined input without throwing", () => {
    expect(() => parseSitemapXml(null)).not.toThrow();
    expect(parseSitemapXml(null)).toEqual([]);
    expect(parseSitemapXml(undefined)).toEqual([]);
  });
});

describe("filterTireProductUrls", () => {
  it("keeps only tire product pages and drops store/article/category pages", () => {
    const urls = [
      "https://www.discounttire.com/tires/michelin/defender-t-h-p123456",
      "https://www.discounttire.com/tires/goodyear/eagle-sport-p654321",
      "https://www.discounttire.com/store-locator/az/phoenix",
      "https://www.discounttire.com/tires-101/how-to-read-a-tire",
      "https://www.discounttire.com/about-us",
    ];
    expect(filterTireProductUrls(urls)).toEqual([
      "https://www.discounttire.com/tires/michelin/defender-t-h-p123456",
      "https://www.discounttire.com/tires/goodyear/eagle-sport-p654321",
    ]);
  });

  it("returns [] when given []", () => {
    expect(filterTireProductUrls([])).toEqual([]);
  });

  it("returns [] when given a non-array without throwing", () => {
    expect(() => filterTireProductUrls(null)).not.toThrow();
    expect(filterTireProductUrls(null)).toEqual([]);
    expect(filterTireProductUrls(undefined)).toEqual([]);
  });
});
