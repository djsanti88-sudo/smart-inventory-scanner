// e2e/teach/lessonHelpers.mjs
//
// Teach Bot browser helpers for driving the LIVE PRODUCTION Scanbin app via
// Playwright. NODE_ENV=production in that deployment, so `window.__scanStore`
// is NOT exposed - every assertion in every lesson MUST go through visible
// DOM testids (data-testid) rather than reaching into app state.
//
// A small handful of pure, unit-testable helpers live at the top; the rest
// are thin Playwright page-driving wrappers (not unit-tested here - proven
// by the lessons themselves running against a real page).

import { parseDecodeTraceTrace, decodeTraceTableRow } from './decodeTrace.mjs';

// ---------------------------------------------------------------------------
// PURE helpers (unit-testable, no page/browser dependency)
// ---------------------------------------------------------------------------

/**
 * Build the individual keystrokes a hardware keyboard-wedge barcode scanner
 * would emit for a given code: one entry per character, then the terminator
 * key ('Enter' or 'Tab').
 * @param {string} code
 * @param {'Enter'|'Tab'} [suffix]
 * @returns {string[]}
 */
export function buildWedgeKeys(code, suffix = 'Enter') {
  const chars = typeof code === 'string' ? code.split('') : [];
  return [...chars, suffix];
}

/**
 * Numeric median of an array. Sorts a copy (never mutates input).
 * Even-length arrays average the two middle values. Empty input -> NaN.
 * @param {number[]} nums
 */
export function median(nums) {
  if (!Array.isArray(nums) || nums.length === 0) return NaN;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

/**
 * Convert a raw `<tr>` count under the scan-feed body into the real number
 * of scan rows, subtracting the synthetic "No scans yet" empty-state row
 * when present.
 * @param {number} rawCount
 * @param {boolean} emptyStatePresent
 */
export function feedRowsFromCount(rawCount, emptyStatePresent) {
  return emptyStatePresent ? rawCount - 1 : rawCount;
}

// ---------------------------------------------------------------------------
// BROWSER helpers (Playwright page API - not unit-tested in this file)
// ---------------------------------------------------------------------------

/**
 * Navigate to a path under baseURL.
 * @param {import('playwright').Page} page
 * @param {string} baseURL
 * @param {string} path
 */
export async function gotoApp(page, baseURL, path) {
  return page.goto(baseURL + path, { waitUntil: 'domcontentloaded' });
}

/**
 * Drive the scanner input the way a real scan (or a keyboard-wedge hardware
 * scanner) would: focus '#scanner-input', then either simulate individual
 * keystrokes (wedge mode) or type the whole code at once, then submit with
 * the terminator key. The input is uncontrolled and refocuses itself after
 * submit, per app design.
 * @param {import('playwright').Page} page
 * @param {string} code
 * @param {{ wedge?: boolean, suffix?: 'Enter'|'Tab', delayMs?: number }} [options]
 */
export async function scan(page, code, { wedge = false, suffix = 'Enter', delayMs = 15 } = {}) {
  const input = page.locator('#scanner-input');
  await input.click();

  if (wedge) {
    // A real hardware wedge scanner bursts every character in well under
    // 80ms, then sends the terminator key - it is NOT slowed down by
    // Playwright's slowMo. insertText injects the whole string as one
    // action (unaffected by per-keystroke slowMo), so it reproduces a
    // real burst instead of splitting into one submission per character.
    await page.keyboard.insertText(code);
    await page.keyboard.press(suffix);
    return;
  }

  await input.pressSequentially(code, { delay: delayMs });
  await input.press(suffix);
}

/**
 * Count real scan-feed rows (subtracting the empty-state row if present).
 * @param {import('playwright').Page} page
 */
export async function feedCount(page) {
  const rows = page.locator('[data-testid="scan-feed-body"] > tr');
  const rawCount = await rows.count();
  const bodyText = await page.locator('[data-testid="scan-feed-body"]').innerText().catch(() => '');
  const emptyPresent = bodyText.includes('No scans yet');
  return feedRowsFromCount(rawCount, emptyPresent);
}

/**
 * Poll the scan feed until it has at least `n` real rows, or throw once
 * `timeout` ms have elapsed.
 * @param {import('playwright').Page} page
 * @param {number} n
 * @param {number} [timeout]
 */
export async function waitFeedAtLeast(page, n, timeout = 15000) {
  const start = Date.now();
  for (;;) {
    const count = await feedCount(page);
    if (count >= n) return count;
    if (Date.now() - start >= timeout) {
      throw new Error(`waitFeedAtLeast: timed out after ${timeout}ms waiting for >= ${n} feed rows (last saw ${count})`);
    }
    await page.waitForTimeout(200);
  }
}

/**
 * Sum the integer text of every element with a testid starting 'qty-'.
 * Non-numeric text contributes 0.
 * @param {import('playwright').Page} page
 */
export async function countedTotal(page) {
  const nodes = page.locator('[data-testid^="qty-"]');
  const count = await nodes.count();
  let total = 0;
  for (let i = 0; i < count; i += 1) {
    const text = await nodes.nth(i).innerText().catch(() => '');
    const n = parseInt(text, 10);
    total += Number.isNaN(n) ? 0 : n;
  }
  return total;
}

/**
 * Parse the integer text of a single testid element (NaN -> 0).
 * @param {import('playwright').Page} page
 * @param {string} testId
 */
export async function qtyByTestId(page, testId) {
  const text = await page.getByTestId(testId).innerText().catch(() => '');
  const n = parseInt(text, 10);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Locator for a Needs Review row keyed by the clean/normalized scanned code.
 * Caller is responsible for awaiting .waitFor() / .isVisible() as needed.
 * @param {import('playwright').Page} page
 * @param {string} cleanCode
 */
export function reviewRow(page, cleanCode) {
  return page.getByTestId(`review-row-${cleanCode}`);
}

/**
 * Best-effort read of the product identity (name/brand) the running app
 * attached to a scanned code, for the correctness oracle. Looks first at the
 * counted feed rows ([data-testid^="feed-product-"] / [data-testid^="count-row-"]),
 * mirroring the existing locators in lessons/2-scan-n-count-n.mjs, then falls
 * back to the Needs Review row. Never throws: on any locator failure it returns
 * empty strings so the caller can record an honest "no identity observed".
 *
 * The returned shape feeds compareIdentity() in ./oracle.mjs. `name` is the
 * primary product label, `brand` is a best-effort brand slice, and `raw` is the
 * full text of the matched row for debugging.
 *
 * @param {import('playwright').Page} page
 * @param {string} code raw or clean scanned code (matched as row text)
 * @returns {Promise<{ name: string, brand: string, raw: string }>}
 */
export async function productIdentityForCode(page, code) {
  const empty = { name: '', brand: '', raw: '' };
  if (!page || !code) return empty;

  // Preferred: the identified feed/count row for this code.
  const rowSelectors = ['[data-testid^="feed-product-"]', '[data-testid^="count-row-"]'];
  for (const selector of rowSelectors) {
    try {
      const row = page.locator(selector).filter({ hasText: code }).first();
      const count = await row.count().catch(() => 0);
      if (!count) continue;
      const raw = (await row.innerText({ timeout: 5000 }).catch(() => '')) || '';
      if (!raw.trim()) continue;

      // Prefer explicit name/brand sub-cells when present, else use the row text.
      const nameCell = row.locator('[data-testid^="product-name-"]').first();
      const brandCell = row.locator('[data-testid^="product-brand-"]').first();
      const name =
        (await nameCell.innerText({ timeout: 1000 }).catch(() => '')) || firstLine(raw);
      const brand = (await brandCell.innerText({ timeout: 1000 }).catch(() => '')) || '';
      return { name: name.trim(), brand: brand.trim(), raw: raw.trim() };
    } catch {
      // fall through to next selector / fallback
    }
  }

  // Fallback: a Needs Review row still carries whatever partial identity exists.
  try {
    const review = page.locator('[data-testid^="review-row-"]').filter({ hasText: code }).first();
    const count = await review.count().catch(() => 0);
    if (count) {
      const raw = (await review.innerText({ timeout: 5000 }).catch(() => '')) || '';
      if (raw.trim()) return { name: firstLine(raw).trim(), brand: '', raw: raw.trim() };
    }
  } catch {
    // ignore
  }

  return empty;
}

/** First non-empty line of a multi-line innerText blob. */
function firstLine(text) {
  if (!text) return '';
  for (const line of String(text).split('\n')) {
    if (line.trim()) return line.trim();
  }
  return '';
}

/**
 * Toggle the browser context's offline simulation.
 * @param {import('playwright').Page} page
 * @param {boolean} offline
 */
export async function setOffline(page, offline) {
  return page.context().setOffline(Boolean(offline));
}

/**
 * Measure wall-clock time-to-usable across `samples` repeated runs of
 * `actionFn` (which is expected to navigate/reload), waiting each time for
 * `readySelector` to become visible.
 * @param {import('playwright').Page} page
 * @param {() => Promise<void>} actionFn
 * @param {string} readySelector
 * @param {{ samples?: number }} [options]
 */
export async function timeToUsable(page, actionFn, readySelector, { samples = 3 } = {}) {
  const all = [];
  for (let i = 0; i < samples; i += 1) {
    const start = performance.now();
    await actionFn();
    await page.locator(readySelector).waitFor({ state: 'visible' });
    all.push(performance.now() - start);
  }
  return { medianMs: median(all), samples: all };
}

/**
 * Extract a response's latency in milliseconds from Playwright's
 * ResourceTiming (`request.timing()`), which is relative to request start.
 * Prefers `responseEnd`; falls back to `responseStart` when `responseEnd` is
 * unavailable (-1 or non-numeric, e.g. the response was aborted or the
 * browser never reported it). Returns null when no usable timing exists.
 * @param {{ responseStart?: number, responseEnd?: number } | null | undefined} timing
 */
function extractLatencyMs(timing) {
  if (!timing || typeof timing !== 'object') return null;
  const { responseEnd, responseStart } = timing;
  if (typeof responseEnd === 'number' && responseEnd >= 0) return responseEnd;
  if (typeof responseStart === 'number' && responseStart >= 0) return responseStart;
  return null;
}

/**
 * True when a URL's path (query string ignored) starts with '/api/'.
 * @param {string} url
 */
function isApiPath(url) {
  try {
    const { pathname } = new URL(url);
    return pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

/**
 * Register a response listener that captures every POST /api/ai-lookup
 * response, parses it into a decodeTrace trace (with latency), and feeds paid-source
 * usage into `limits` for run-size enforcement. Also tallies EVERY /api/*
 * response (any method) into a lightweight call-coverage list, independent of
 * the ai-lookup-specific parsing, so a lesson can assert on which backend
 * calls fired at all. Fully defensive: response bodies may be non-JSON, HTML
 * error pages, or otherwise malformed; timing may be unavailable.
 * @param {import('playwright').Page} page
 * @param {import('./limits.mjs').RunLimits} limits
 */
export function attachDecodeTraceCapture(page, limits) {
  const traces = [];
  const apiCallList = [];

  const handler = async (response) => {
    try {
      const url = response.url();
      const request = response.request();
      const timing = extractLatencyMs(request.timing?.());

      if (isApiPath(url)) {
        let pathOnly = url;
        try {
          pathOnly = new URL(url).pathname;
        } catch {
          // keep raw url if it fails to parse
        }
        apiCallList.push({
          urlPath: pathOnly,
          method: request.method(),
          status: typeof response.status === 'function' ? response.status() : null,
          latencyMs: timing,
        });
      }

      if (request.method() !== 'POST') return;
      if (!url.includes('/api/ai-lookup')) return;

      let code = null;
      try {
        const postData = request.postData();
        if (postData) {
          const parsedBody = JSON.parse(postData);
          code = parsedBody?.code ?? parsedBody?.rawCode ?? null;
        }
      } catch {
        code = null;
      }

      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }

      const parsed = parseDecodeTraceTrace(body);
      traces.push({ code, parsed, latencyMs: timing });

      if (parsed.reachedGpt) {
        limits.recordPaidLookup('gpt');
      }
      limits.recordRequest();
    } catch {
      // Fully defensive: never let capture failures break the run.
    }
  };

  page.on('response', handler);

  return {
    traces,
    rows() {
      return traces.map((t) => decodeTraceTableRow(t.code, t.parsed, { latencyMs: t.latencyMs }));
    },
    apiCalls() {
      return apiCallList;
    },
    stop() {
      page.off('response', handler);
    },
  };
}

/**
 * Save a full-page screenshot to an absolute path.
 * @param {import('playwright').Page} page
 * @param {string} absPath
 */
export async function screenshot(page, absPath) {
  return page.screenshot({ path: absPath, fullPage: true });
}

/**
 * Start Playwright tracing on a browser context.
 * @param {import('playwright').BrowserContext} context
 */
export async function startTracing(context) {
  return context.tracing.start({ screenshots: true, snapshots: true });
}

/**
 * Stop tracing and write the trace zip to an absolute path.
 * @param {import('playwright').BrowserContext} context
 * @param {string} absPath
 */
export async function stopTracing(context, absPath) {
  return context.tracing.stop({ path: absPath });
}

// A visible fake cursor + click ripple so a human watching a headed run can SEE where the bot
// clicks. Injected via context.addInitScript so it survives navigations. Purely cosmetic overlay,
// pointer-events:none, never interferes with the page.
export const MOUSE_HELPER_SCRIPT = `(() => {
  if (window.__teachCursor) return; window.__teachCursor = true;
  const install = () => {
    if (!document.body) return;
    const dot = document.createElement('div');
    dot.setAttribute('data-teach-cursor','1');
    dot.style.cssText = 'position:fixed;top:0;left:0;width:20px;height:20px;margin:-10px 0 0 -10px;border-radius:50%;background:rgba(255,45,45,.55);border:2px solid #fff;box-shadow:0 0 8px rgba(0,0,0,.5);z-index:2147483647;pointer-events:none;transition:transform .06s ease;';
    document.body.appendChild(dot);
    addEventListener('mousemove', e => { dot.style.left = e.clientX + 'px'; dot.style.top = e.clientY + 'px'; }, true);
    addEventListener('mousedown', e => {
      dot.style.transform = 'scale(1.7)';
      const r = document.createElement('div');
      r.style.cssText = 'position:fixed;left:'+e.clientX+'px;top:'+e.clientY+'px;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;border:2px solid rgba(255,45,45,.9);z-index:2147483647;pointer-events:none;';
      document.body.appendChild(r);
      r.animate([{transform:'scale(1)',opacity:1},{transform:'scale(4)',opacity:0}],{duration:450}).onfinish = () => r.remove();
    }, true);
    addEventListener('mouseup', () => { dot.style.transform = 'scale(1)'; }, true);
  };
  if (document.body) install(); else addEventListener('DOMContentLoaded', install);
})();`;

export async function installCursor(context) {
  try {
    await context.addInitScript(MOUSE_HELPER_SCRIPT);
  } catch {
    // cosmetic only - never fail a run because the cursor overlay could not attach
  }
}
