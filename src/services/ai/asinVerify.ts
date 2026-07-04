import { type FetchImpl, fetchPages, extractTitleProduct } from "@/services/ai/pageFetch";

// OWNER RULE (2026-07-04): an ASIN whose amazon.com/dp/<ASIN> page loads as a REAL product page
// is deterministic identity proof -> verified. The code appearing in a URL alone proves nothing
// (URLs are constructible from any code); the page must actually load as a product page.
// FNSKUs (X00...) are NOT ASINs and are publicly unverifiable by Amazon's design - never here.

const ASIN_RE = /^B0[0-9A-Z]{8}$/i;

export function looksLikeAsin(code: string): boolean {
  return ASIN_RE.test((code ?? "").trim());
}

const BLOCKED_RE = /robot check|captcha|api-services-support@amazon|automated access/i;

export function isRealAmazonProductPage(html: string): boolean {
  if (!html) return false;
  if (BLOCKED_RE.test(html)) return false;
  return /id="productTitle"/i.test(html) || /<meta[^>]+property=["']og:title["']/i.test(html);
}

export async function verifyAsinPage(
  asin: string,
  deps?: { fetchImpl?: FetchImpl; signal?: AbortSignal },
): Promise<{ verified: boolean; productName: string; brand: string; url: string; reason: string }> {
  const clean = (asin ?? "").trim().toUpperCase();
  const url = `https://www.amazon.com/dp/${clean}`;
  if (!looksLikeAsin(clean)) return { verified: false, productName: "", brand: "", url, reason: "not_asin" };

  const pages = await fetchPages([url], { fetchImpl: deps?.fetchImpl, signal: deps?.signal, timeoutMs: 8000 });
  if (pages.length === 0) return { verified: false, productName: "", brand: "", url, reason: "no_page" };
  const page = pages[0];
  if (!isRealAmazonProductPage(page.html)) return { verified: false, productName: "", brand: "", url, reason: "blocked" };

  const t = extractTitleProduct(page.html);
  if (!t.productName) return { verified: false, productName: "", brand: t.brand, url, reason: "no_title" };
  return { verified: true, productName: t.productName, brand: t.brand, url, reason: "product_page" };
}
