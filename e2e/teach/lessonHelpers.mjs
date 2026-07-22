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

import { parseLadderTrace, ladderTableRow } from './ladder.mjs';

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
    const keys = buildWedgeKeys(code, suffix);
    for (const key of keys) {
      await page.keyboard.press(key);
      await page.waitForTimeout(delayMs);
    }
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
 * Register a response listener that captures every POST /api/ai-lookup
 * response, parses it into a ladder trace, and feeds paid-rung usage into
 * `limits` for run-size enforcement. Fully defensive: response bodies may be
 * non-JSON, HTML error pages, or otherwise malformed.
 * @param {import('playwright').Page} page
 * @param {import('./limits.mjs').RunLimits} limits
 */
export function attachLadderCapture(page, limits) {
  const traces = [];

  const handler = async (response) => {
    try {
      const request = response.request();
      if (request.method() !== 'POST') return;
      if (!response.url().includes('/api/ai-lookup')) return;

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

      const parsed = parseLadderTrace(body);
      traces.push({ code, parsed });

      if (parsed.settledRung === 'goupc' || parsed.settledRung === 'fetchv2' || parsed.settledRung === 'gpt') {
        limits.recordPaidLookup(parsed.settledRung);
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
      return traces.map((t) => ladderTableRow(t.code, t.parsed));
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
