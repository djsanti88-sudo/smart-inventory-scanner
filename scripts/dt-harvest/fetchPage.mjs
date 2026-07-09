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
 * Fetch a single Discount Tire product page with an injected, already-configured Playwright page.
 *
 * @param {import('playwright').Page} browserPage - a page from a context the caller configured
 *   with realistic UA/viewport/locale/timezone. This function does not touch context settings.
 * @param {string} url
 * @returns {Promise<{ status: "ok"|"blocked"|"error", html?: string }>}
 */
export async function fetchProductPage(browserPage, url) {
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
  let bodyText = "";
  try {
    title = await browserPage.title();
  } catch {
    title = "";
  }

  if (isCaptchaMarker(title)) {
    return { status: "blocked" };
  }

  let ldJsonFound = false;
  try {
    await browserPage.waitForSelector(LDJSON_SELECTOR, { timeout: LDJSON_WAIT_MS });
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

  try {
    bodyText = await browserPage.evaluate(() => document.body?.innerText ?? "");
  } catch {
    bodyText = "";
  }

  if (isCaptchaMarker(bodyText)) {
    return { status: "blocked" };
  }

  return { status: "error" };
}

function isCaptchaMarker(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return CAPTCHA_MARKERS.some((marker) => lower.includes(marker));
}
