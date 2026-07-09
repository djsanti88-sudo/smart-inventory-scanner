// Discount Tire harvest: deterministic sitemap parsing. Pure, no XML dependency
// (regex <loc> extraction is sufficient for sitemap files and avoids adding a
// dependency for a well-known, simple format). Untrusted input (fetched sitemap
// bytes) - parse defensively, never throw, never eval/obey content.

/**
 * Extract every <loc>...</loc> URL from raw sitemap XML (works for both a
 * <sitemapindex> pointing at child sitemaps and a <urlset> of page urls -
 * both use the same <loc> tag, so one regex handles both shapes).
 * @param {string} xml
 * @returns {string[]}
 */
export function parseSitemapXml(xml) {
  if (typeof xml !== "string" || xml.length === 0) return [];

  try {
    const urls = [];
    const locRegex = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
    let match;
    while ((match = locRegex.exec(xml)) !== null) {
      const url = decodeXmlEntities(match[1].trim());
      if (url) urls.push(url);
    }
    return urls;
  } catch {
    return [];
  }
}

function decodeXmlEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

// Discount Tire product page urls live under /tires/<brand>/<model-slug> and end
// in a part-number style suffix (e.g. -p123456). Non-product pages we must drop:
// store locator, "tires-101" article/guide content, generic marketing pages, etc.
const PRODUCT_PATH_PATTERN = /\/tires\/[^/]+\/[^/]+-p\d+/i;
const NON_PRODUCT_SEGMENTS = ["/store-locator", "/tires-101", "/about-us"];

/**
 * Keep only urls that look like individual tire product pages; drop store,
 * article, and category/marketing pages.
 * @param {string[]} urls
 * @returns {string[]}
 */
export function filterTireProductUrls(urls) {
  if (!Array.isArray(urls)) return [];

  return urls.filter((url) => {
    if (typeof url !== "string" || url.length === 0) return false;
    if (NON_PRODUCT_SEGMENTS.some((segment) => url.includes(segment))) return false;
    return PRODUCT_PATH_PATTERN.test(url);
  });
}
