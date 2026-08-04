import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { adminDb, LOCAL_CORPUS_BUSINESS_ID, LOCAL_CORPUS_EMAIL, LOCAL_CORPUS_PASSWORD } from "./admin";

const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const SCANNER_INTERVAL_MS = 100; // declared local keyboard-wedge arrival rate: 10 scans/s
const SETTLEMENT_TIMEOUT_MS = 2_000;
const redactedCode = (value: string) => Buffer.from(value).toString("base64url").slice(0, 16);

function manifest() { return JSON.parse(readFileSync(join(process.cwd(), "src", "server", "tire-knowledge", "exact-index", "manifest.json"), "utf8")); }
function percentile(values: number[], fraction: number) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0; }

async function blockExternalEgress(page: Page) {
  const blocked: Array<{ method: string; hostname: string; pathname: string }> = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol !== "data:" && !ALLOWED_HOSTS.has(url.hostname)) { blocked.push({ method: route.request().method(), hostname: url.hostname, pathname: url.pathname }); await route.abort("blockedbyclient"); return; }
    await route.continue();
  });
  return blocked;
}

async function login(page: Page) {
  await page.goto("/login");
  await page.getByTestId("login-email").fill(LOCAL_CORPUS_EMAIL);
  await page.getByTestId("login-password").fill(LOCAL_CORPUS_PASSWORD);
  await page.getByTestId("login-button").click();
  await page.waitForURL("**/scan");
  await expect(page.getByTestId("scanner-input")).toBeFocused({ timeout: 30_000 });
}

async function settledCount(expectedEvents: number, expectedIdentities: Map<string, string>) {
  const db = adminDb(); const started = Date.now();
  while (Date.now() - started < SETTLEMENT_TIMEOUT_MS) {
    const [events, products, reviews, counts] = await Promise.all([
      db.collection(`businesses/${LOCAL_CORPUS_BUSINESS_ID}/scanEvents`).get(), db.collection(`businesses/${LOCAL_CORPUS_BUSINESS_ID}/products`).get(),
      db.collection(`businesses/${LOCAL_CORPUS_BUSINESS_ID}/unknownCodeReviews`).get(), db.collection(`businesses/${LOCAL_CORPUS_BUSINESS_ID}/inventoryCounts`).get(),
    ]);
    const productById = new Map(products.docs.map((doc) => [doc.id, doc.data()]));
    const eventOk = events.size === expectedEvents && events.docs.every((doc) => {
      const event = doc.data(); const product = productById.get(String(event.matchedProductId));
      return event.status === "known" && event.decodeStatus !== "needs_review" && event.decodeStatus !== "suggested"
        && typeof event.rawCode === "string" && expectedIdentities.get(event.rawCode) === product?.trustedExactCanonicalId;
    });
    const activeReviews = reviews.docs.filter((doc) => !["resolved", "ignored"].includes(String(doc.data().status))).length;
    const counted = counts.docs.reduce((sum, doc) => sum + Number(doc.data().countedQuantity ?? doc.data().quantity ?? 0), 0);
    if (eventOk && activeReviews === 0 && counted === expectedEvents) return { events: events.size, counted, activeReviews, products: productById.size };
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Synthetic local trusted-exact scans did not settle within 2 seconds.");
}

test("synthetic normal-member UI proves short and boundary trusted exact barcode settlement", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const fixtureModule = await import("./fixtures.mjs");
  const fixtures = fixtureModule.loadCorpusFixtures(process.env.BOSS_RECONCILIATION_PATH, manifest());
  const selected = fixtureModule.selectUiCorpusSample(fixtures);
  const expectedIdentities = new Map(selected.map((entry) => [entry.code, fixtureModule.runtimeCanonicalIdFor(entry)]));
  const blocked = await blockExternalEgress(page);
  await login(page);
  const input = page.getByTestId("scanner-input");
  const feed = page.getByTestId("scan-feed-body");
  const history = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="scan-feed-body"]'); if (!root) throw new Error("scan feed missing");
    const value = { forbidden: false, observer: null as MutationObserver | null };
    value.observer = new MutationObserver((mutations) => { for (const mutation of mutations) for (const node of mutation.addedNodes) if (/Suggested|Needs Review|Conflict|Vendor/i.test(node.textContent ?? "")) value.forbidden = true; });
    value.observer.observe(root, { childList: true, subtree: true, characterData: true }); (window as Window & { __localCorpusHistory?: typeof value }).__localCorpusHistory = value;
    return true;
  });
  expect(history).toBe(true);
  const immediateMs: number[] = []; const settledMs: number[] = []; const queueMs: number[] = [];
  for (let index = 0; index < selected.length; index += 1) {
    if (index % 20 === 0) await expect(input).toBeFocused();
    const entry = selected[index]; const started = performance.now();
    await page.keyboard.insertText(entry.code); await page.keyboard.press("Enter");
    await expect(page.getByText(`${index + 1} scans`, { exact: true })).toBeVisible({ timeout: 2_000 });
    immediateMs.push(performance.now() - started);
    const settleStart = performance.now();
    await expect.poll(async () => {
      const row = feed.locator("tr").first(); const status = await row.getByTestId("decode-row-status").textContent().catch(() => "");
      return /Verified \(app-confirmed\)|Counted/.test(status ?? "");
    }, { timeout: SETTLEMENT_TIMEOUT_MS, intervals: [10, 20, 50] }).toBe(true);
    settledMs.push(performance.now() - started); queueMs.push(performance.now() - settleStart);
    await new Promise((resolve) => setTimeout(resolve, SCANNER_INTERVAL_MS));
  }
  await expect(input).toBeFocused();
  await expect(page.getByTestId("pending-count")).toHaveText(/^(?:Waiting to save|All saved): 0$/, { timeout: 30_000 });
  const settled = await settledCount(selected.length, expectedIdentities);
  const visual = await page.evaluate(() => { const state = (window as Window & { __localCorpusHistory?: { forbidden: boolean; observer: MutationObserver | null } }).__localCorpusHistory; state?.observer?.disconnect(); return state?.forbidden ?? true; });
  expect(visual, "trusted exact UI must not transiently show Suggested, Needs Review, Conflict, or Vendor").toBe(false);
  expect(page.url()).toContain("/scan");
  await page.reload(); await expect(input).toBeFocused({ timeout: 30_000 });
  await expect(page.getByText(`${selected.length} scans`, { exact: true })).toBeVisible({ timeout: 30_000 });
  expect(blocked, "local proof must make no external browser requests").toEqual([]);
  const summary = { scope: "synthetic-normal-member-local-emulator", selected: selected.length, shortest: 20, boundary: selected.length - 20, events: settled.events, counted: settled.counted, activeReviews: settled.activeReviews, identities: [...expectedIdentities.entries()].map(([code, canonicalId]) => ({ code: redactedCode(code), canonicalId: redactedCode(canonicalId) })), scannerIntervalMs: SCANNER_INTERVAL_MS, latencyMs: { immediate: { p50: percentile(immediateMs, .5), p95: percentile(immediateMs, .95) }, settlement: { p50: percentile(settledMs, .5), p95: percentile(settledMs, .95), max: Math.max(...settledMs) }, queue: { p50: percentile(queueMs, .5), p95: percentile(queueMs, .95) } } };
  await testInfo.attach("local-corpus-summary", { contentType: "application/json", body: Buffer.from(JSON.stringify(summary)) });
});
