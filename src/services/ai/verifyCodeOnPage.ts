// GROUNDING-FIRST fetch verification. Google/grounding names the product; the APP then INDEPENDENTLY
// confirms it by FETCHING the candidate page and checking the exact scanned code is really printed on it.
// This is how we (a) reject a wrong barcode-DB answer and (b) pick which of several results truly owns the
// code. A grounding source TITLE/URI almost never carries the raw barcode, so checking titles falsely
// demotes correct answers - fetching the page is the real test.
//
// Cost/speed guards: fetch AT MOST the first 2 urls, plain `fetch` (FREE), follow redirects, ~5s timeout
// each, a browser User-Agent. Per-fetch try/catch -> a throw/timeout/non-OK is SKIPPED, never fatal.

const FETCH_TIMEOUT_MS = 5_000;
const MAX_URLS = 2;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** GTIN zero-padding variants (UPC-12 / EAN-13 / GTIN-14 + leading-zero-stripped) - same style as
 *  barcodeDbProvider / retailKnowledgeIndex so a page that prints a padded form still matches. */
function codeVariants(code: string): string[] {
  const stripped = code.replace(/^0+/, "") || "0";
  const set = new Set<string>([code, stripped]);
  for (const base of [code, stripped]) {
    if (base.length <= 12) set.add(base.padStart(12, "0"));
    if (base.length <= 13) set.add(base.padStart(13, "0"));
    if (base.length <= 14) set.add(base.padStart(14, "0"));
  }
  return [...set].filter((c) => c.length >= 8);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Does the exact code (or a zero-padding variant) appear on the page as a standalone digit run?
 *  Digits/spaces/hyphens are collapsed first so "0 86699 08782 9" style print still matches, and the
 *  digit boundaries stop a 12-digit code matching inside an unrelated longer number. */
export function pageTextHasCode(pageText: string, code: string): boolean {
  if (!pageText || !code) return false;
  const collapsed = pageText.replace(/[\s-]/g, "");
  return codeVariants(code).some((v) => new RegExp(`(?<![0-9])${escapeRe(v)}(?![0-9])`).test(collapsed));
}

/**
 * Fetch up to the first 2 urls and return the FIRST whose page text contains the exact code (or a
 * GTIN variant), as `{ url, pageText }`; else null. Never throws - each fetch is isolated so a slow or
 * broken candidate is skipped, not fatal. `deps.fetch` is injectable so tests mock all network.
 */
export async function verifyCodeOnPage(
  urls: string[],
  code: string,
  deps?: { fetch?: typeof fetch },
): Promise<{ url: string; pageText: string } | null> {
  const f = deps?.fetch ?? fetch;
  for (const url of (urls ?? []).filter(Boolean).slice(0, MAX_URLS)) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let res: Response;
      try {
        res = await f(url, {
          redirect: "follow",
          signal: controller.signal,
          headers: { "User-Agent": USER_AGENT },
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) continue;
      const pageText = await res.text();
      if (pageTextHasCode(pageText, code)) return { url, pageText };
    } catch {
      // timeout / network error / bad body -> skip this candidate, try the next.
    }
  }
  return null;
}
