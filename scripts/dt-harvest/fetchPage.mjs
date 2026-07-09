// Discount Tire harvest: Playwright fetcher + rolling block-rate telemetry.
//
// This module drives an already-created Playwright `page` (and, by extension, the
// `context`/`browser` that own it). It does NOT create the browser or context itself:
// the caller (the batch driver, Task 5) is responsible for `chromium.launch(...)` and
// `browser.newContext({...})` with realistic settings (UA, viewport, locale, timezone).
// Keeping that here would make this module untestable without a real browser; the pure
// telemetry class below (`BlockRateStop`) is what Task 4's tests actually cover.
//
// Politeness (2000-4000ms randomized delay between pages) lives in the batch loop that
// calls `fetchProductPage` repeatedly, not in this module.

const LDJSON_SELECTOR = 'script[type="application/ld+json"]';
const LDJSON_WAIT_MS = 8000;
const NAV_TIMEOUT_MS = 30000;
// The page fires webapi/discounttire.graph?op=productByCode during hydration; that
// response (not the JSON-LD, which carries NO gtin - verified live 2026-07-08) is
// where the barcode + full tire specs live. We only LISTEN to the page's own
// traffic; we never issue extra requests.
const PRODUCT_JSON_MARKER = "op=productByCode";
const PRODUCT_JSON_WAIT_MS = 15000;

const CAPTCHA_MARKERS = [
  "captcha",
  "are you a human",
  "unusual traffic",
  "access denied",
  "request blocked",
  "verify you are a human",
];

/**
 * Rolling block-rate circuit breaker.
 *
 * Tracks the outcome ("ok" | "blocked" | "error") of the last `windowSize` fetches and
 * reports whether the fraction of "blocked" outcomes in that window exceeds `threshold`.
 * Pure in-memory bookkeeping, no I/O, no browser — safe to unit test directly.
 */
export class BlockRateStop {
  constructor({ windowSize = 50, threshold = 0.3 } = {}) {
    this.windowSize = windowSize;
    this.threshold = threshold;
    this.window = [];
  }

  /** Record one fetch outcome ("ok" | "blocked" | "error"). Oldest entries age out past windowSize. */
  record(status) {
    this.window.push(status);
    if (this.window.length > this.windowSize) {
      this.window.shift();
    }
  }

  /** True when the blocked fraction of the current window strictly exceeds the threshold. */
  shouldStop() {
    if (this.window.length === 0) return false;
    const blockedCount = this.window.filter((status) => status === "blocked").length;
    return blockedCount / this.window.length > this.threshold;
  }
}

/**
 * Extract the product node from a raw productByCode GraphQL response body.
 * Pure (string in, object|null out) - unit-testable without a browser. Untrusted
 * input: parse defensively, never throw, never obey content.
 *
 * @param {string} bodyText
 * @returns {object|null} the `data.product.byCode` node, or null
 */
export function extractProductByCode(bodyText) {
  if (typeof bodyText !== "string" || bodyText.length === 0) return null;
  try {
    const parsed = JSON.parse(bodyText);
    const node = parsed?.data?.product?.byCode;
    return node && typeof node === "object" ? node : null;
  } catch {
    return null;
  }
}

/**
 * Fetch a single Discount Tire product page with an injected, already-configured Playwright page.
 *
 * Success means we captured the page's own productByCode GraphQL response (which
 * carries gtin + full tire specs). The rendered HTML is returned too so the caller
 * can fall back to JSON-LD parsing, but HTML alone (no productByCode captured and
 * no ld+json present) is an "error".
 *
 * @param {import('playwright').Page} browserPage - a page from a context the caller configured
 *   with realistic UA/viewport/locale/timezone. This function does not touch context settings.
 * @param {string} url
 * @returns {Promise<{ status: "ok"|"blocked"|"error", html?: string, productJson?: object }>}
 */
export async function fetchProductPage(browserPage, url) {
  // Arm the listener BEFORE navigation so an early response is never missed.
  let resolveProductJson;
  const productJsonPromise = new Promise((resolve) => {
    resolveProductJson = resolve;
  });
  const onResponse = async (resp) => {
    try {
      if (!resp.url().includes(PRODUCT_JSON_MARKER)) return;
      const node = extractProductByCode(await resp.text());
      if (node) resolveProductJson(node);
    } catch {
      /* response body unavailable (aborted/binary) - keep waiting */
    }
  };
  browserPage.on("response", onResponse);

  try {
    let response;
    try {
      response = await browserPage.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    } catch {
      return { status: "error" };
    }

    const httpStatus = response ? response.status() : undefined;
    if (httpStatus === 403 || httpStatus === 429) {
      return { status: "blocked" };
    }

    let title = "";
    try {
      title = await browserPage.title();
    } catch {
      title = "";
    }
    if (isCaptchaMarker(title)) {
      return { status: "blocked" };
    }

    // Primary: the page's own productByCode response, within a bounded wait.
    const productJson = await Promise.race([
      productJsonPromise,
      new Promise((resolve) => setTimeout(() => resolve(null), PRODUCT_JSON_WAIT_MS)),
    ]);

    if (productJson) {
      let html = "";
      try {
        html = await browserPage.content();
      } catch {
        html = "";
      }
      return { status: "ok", html, productJson };
    }

    // Fallback: JSON-LD present in the DOM. NOTE: script tags are never "visible",
    // so this wait MUST use state "attached" (the default "visible" state never
    // resolves for <script> - that bug classified every live page as error).
    let ldJsonFound = false;
    try {
      await browserPage.waitForSelector(LDJSON_SELECTOR, { state: "attached", timeout: LDJSON_WAIT_MS });
      ldJsonFound = true;
    } catch {
      ldJsonFound = false;
    }

    if (ldJsonFound) {
      try {
        const html = await browserPage.content();
        return { status: "ok", html };
      } catch {
        return { status: "error" };
      }
    }

    let bodyText = "";
    try {
      bodyText = await browserPage.evaluate(() => document.body?.innerText ?? "");
    } catch {
      bodyText = "";
    }
    if (isCaptchaMarker(bodyText)) {
      return { status: "blocked" };
    }

    return { status: "error" };
  } finally {
    browserPage.off("response", onResponse);
  }
}

function isCaptchaMarker(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return CAPTCHA_MARKERS.some((marker) => lower.includes(marker));
}
