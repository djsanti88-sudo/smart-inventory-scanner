import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { adminDb, clearLocalCorpusTenant, LOCAL_CORPUS_BUSINESS_ID, LOCAL_CORPUS_EMAIL, LOCAL_CORPUS_PASSWORD } from "./admin";

// File-level skip: the private corpus source is never committed, so this proof only runs on
// machines that hold it (CI does not). Must sit at file scope so the admin-SDK afterEach hook
// never runs either.
test.skip(!process.env.BOSS_RECONCILIATION_PATH, "BOSS_RECONCILIATION_PATH not set");

const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const SCANNER_INTERVAL_MS = 100; // declared local keyboard-wedge arrival rate: 10 scans/s
const SETTLEMENT_TIMEOUT_MS = 2_000;

function manifest() { return JSON.parse(readFileSync(join(process.cwd(), "src", "server", "tire-knowledge", "exact-index", "manifest.json"), "utf8")); }

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

async function assertVisibleUiSettlement(page: Page, expectedCodes: readonly string[], expectedEvents: number) {
  const feed = page.getByTestId("scan-feed-body");
  await expect(feed.locator("tr")).toHaveCount(expectedEvents, { timeout: 30_000 });
  await expect.poll(async () => page.locator("td[data-testid^='feed-barcode-']").evaluateAll((cells, expected) =>
    cells.filter((cell) => expected.includes(cell.textContent ?? "")).length,
  expectedCodes), { timeout: 30_000 }).toBe(expectedEvents);
  await expect.poll(async () => feed.locator("tr").evaluateAll((rows, codes) => codes.every((code) => {
    const row = rows.find((candidate) =>
      candidate.querySelector("td[data-testid^='feed-barcode-']")?.textContent === code,
    );
    const text = row?.textContent ?? "";
    return /Verified \(app-confirmed\)|Counted/.test(text) && !/Suggested|Needs Review|Conflict|Vendor/i.test(text);
  }), expectedCodes), { timeout: 30_000 }).toBe(true);
  await expect(feed).not.toContainText(/Suggested|Needs Review|Conflict|Vendor/i);
  await expect(page.getByTestId("pending-count")).toHaveText(/^(?:Waiting to save|All saved): 0$/, { timeout: 30_000 });
  await expect(page.getByTestId("final-count-body").locator("td[data-testid^='qty-']")).not.toHaveCount(0);
  await expect.poll(async () => page.getByTestId("final-count-body").locator("td[data-testid^='qty-']").evaluateAll((cells) =>
    cells.reduce((total, cell) => total + Number(cell.textContent?.trim() ?? 0), 0),
  )).toBe(expectedEvents);
  await expect(page.getByTestId("final-count-body")).not.toContainText(/Suggested|Needs Review|Conflict|Vendor/i);
  await expect(page.locator('a[href="/review"] span')).toHaveCount(0);
  await expect(page.getByTestId("scanner-input")).toBeFocused();
}

test.afterEach(async () => {
  await clearLocalCorpusTenant();
});

async function settlementSnapshot(expectedEvents: number, expectedIdentities: Map<string, string>) {
  const db = adminDb();
  const [events, products, reviews, counts] = await Promise.all([
      db.collection(`businesses/${LOCAL_CORPUS_BUSINESS_ID}/scanEvents`).get(), db.collection(`businesses/${LOCAL_CORPUS_BUSINESS_ID}/products`).get(),
      db.collection(`businesses/${LOCAL_CORPUS_BUSINESS_ID}/unknownCodeReviews`).get(), db.collection(`businesses/${LOCAL_CORPUS_BUSINESS_ID}/inventoryCounts`).get(),
  ]);
  const productById = new Map(products.docs.map((doc) => [doc.id, doc.data()]));
  let knownEvents = 0; let badDecode = 0; let productLinkMismatch = 0;
  for (const doc of events.docs) {
    const event = doc.data(); const product = productById.get(String(event.matchedProductId));
    if (event.status === "known") knownEvents++; else badDecode++;
    if (event.decodeStatus === "needs_review" || event.decodeStatus === "suggested") badDecode++;
    if (typeof event.rawCode !== "string" || expectedIdentities.get(event.rawCode) !== product?.trustedExactCanonicalId) productLinkMismatch++;
  }
  const activeReviews = reviews.docs.filter((doc) => !["resolved", "ignored"].includes(String(doc.data().status))).length;
  const counted = counts.docs.reduce((sum, doc) => sum + Number(doc.data().countedQuantity ?? doc.data().quantity ?? 0), 0);
  return { expectedEvents, events: events.size, knownEvents, badDecode, productLinkMismatch, activeReviews, counted, products: productById.size };
}

async function settledCount(expectedEvents: number, expectedIdentities: Map<string, string>) {
  const started = Date.now(); let last = await settlementSnapshot(expectedEvents, expectedIdentities);
  while (Date.now() - started < SETTLEMENT_TIMEOUT_MS) {
    last = await settlementSnapshot(expectedEvents, expectedIdentities);
    if (last.events === expectedEvents && last.knownEvents === expectedEvents && last.badDecode === 0 && last.productLinkMismatch === 0 && last.activeReviews === 0 && last.counted === expectedEvents) return last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const error = new Error("Synthetic local trusted-exact scans did not settle within 2 seconds.");
  Object.assign(error, { settlementDiagnostic: last }); throw error;
}

test("synthetic normal-member UI proves short and boundary trusted exact barcode settlement", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const fixtureModule = await import("./fixtures.mjs");
  const fixtures = fixtureModule.loadCorpusFixtures(process.env.BOSS_RECONCILIATION_PATH, manifest());
  const selected = fixtureModule.selectUiCorpusSample(fixtures);
  const selectedCodes = new Set(selected.map((entry) => entry.code));
  const warmEntry = [...fixtures.spellings.entries()].map(([code, value]) => ({ code, ...value })).find((entry) => !selectedCodes.has(entry.code));
  if (!warmEntry) throw new Error("Private corpus did not contain a distinct source-derived warm-up spelling.");
  const expectedIdentities = new Map(selected.map((entry) => [entry.code, fixtureModule.runtimeCanonicalIdFor(entry)]));
  const blocked = await blockExternalEgress(page);
  const consoleErrors: string[] = [];
  const unexpectedDialogs: string[] = [];
  page.on("dialog", async (dialog) => { unexpectedDialogs.push(dialog.type()); await dialog.dismiss(); });
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text().replace(/\d{5,}/g, "[redacted]").slice(0, 240)); });
  await login(page);
  const input = page.getByTestId("scanner-input");
  const feed = page.getByTestId("scan-feed-body");
  // This authenticated UI warm-up primes the exact index and route without being included in the
  // measured burst. Its persisted event/count is an explicit baseline, not silently discarded.
  // A hardware keyboard wedge terminates each burst with Enter. This works with both user-selectable
  // production submission modes without reaching into platform-only scanner settings.
  await page.keyboard.insertText(warmEntry.code); await page.keyboard.press("Enter");
  await expect(page.getByText("1 scans", { exact: true })).toBeVisible({ timeout: 2_000 });
  await expect.poll(async () => /Verified \(app-confirmed\)|Counted/.test(await feed.locator("tr").first().textContent() ?? ""), { timeout: SETTLEMENT_TIMEOUT_MS, intervals: [10, 20, 50] }).toBe(true);
  await expect(page.getByTestId("pending-count")).toHaveText(/^(?:Waiting to save|All saved): 0$/, { timeout: 30_000 });
  const warmExpected = new Map([[warmEntry.code, fixtureModule.runtimeCanonicalIdFor(warmEntry)]]);
  await settledCount(1, warmExpected);
  await expect(input).toBeFocused();
  const history = await page.evaluate((codes) => {
    const root = document.querySelector('[data-testid="scan-feed-body"]'); if (!root) throw new Error("scan feed missing");
    const value = { forbidden: false, scannerForbidden: false, scannerCounted: 0, reviewBadgeForbidden: false, measuring: false, lastScannerMessage: "", observer: null as MutationObserver | null, marks: {} as Record<string, { immediate?: number; settled?: number }> };
    const inspect = () => {
      for (const cell of root.querySelectorAll<HTMLTableCellElement>("td[data-testid^='feed-barcode-']")) for (const code of codes) if (cell.textContent === code) { const row = cell.closest("tr"); if (!row) throw new Error("Exact barcode cell is not contained by a feed row."); const text = row.textContent ?? ""; const mark = value.marks[code] ?? (value.marks[code] = {}); mark.immediate ??= performance.now(); if (/Verified \(app-confirmed\)|Counted/.test(text)) mark.settled ??= performance.now(); if (/Suggested|Needs Review|Conflict|Vendor/i.test(text)) value.forbidden = true; }
      if (!value.measuring) return;
      const reviewBadge = document.querySelector('a[href="/review"] span')?.textContent?.trim() ?? "";
      if (reviewBadge !== "") value.reviewBadgeForbidden = true;
      const message = document.querySelector('[data-testid="scan-status"]')?.textContent ?? "";
      if (!message || message === value.lastScannerMessage) return;
      value.lastScannerMessage = message;
      if (/Suggested|Needs Review|Conflict|Vendor|New code|Check the review list/i.test(message)) value.scannerForbidden = true;
      if (/^Counted:/.test(message)) value.scannerCounted += 1;
    };
    value.observer = new MutationObserver(inspect);
    value.observer.observe(document.body, { childList: true, subtree: true, characterData: true }); (window as Window & { __localCorpusHistory?: typeof value }).__localCorpusHistory = value;
    return true;
  }, selected.map((entry) => entry.code));
  expect(history).toBe(true);
  const starts = new Map<string, number>();
  await page.evaluate(() => {
    const state = (window as Window & { __localCorpusHistory?: { measuring: boolean; lastScannerMessage: string } }).__localCorpusHistory;
    if (!state) throw new Error("local corpus history missing");
    state.lastScannerMessage = document.querySelector('[data-testid="scan-status"]')?.textContent ?? "";
    state.measuring = true;
  });
  const burstStart = performance.now();
  for (let index = 0; index < selected.length; index += 1) {
    if (index % 20 === 0) await expect(input).toBeFocused();
    const deadline = burstStart + index * SCANNER_INTERVAL_MS;
    const remaining = deadline - performance.now(); if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    const entry = selected[index]; starts.set(entry.code, await page.evaluate(() => performance.now()));
    await page.keyboard.insertText(entry.code); await page.keyboard.press("Enter");
  }
  await expect(page.getByText(`${selected.length + 1} scans`, { exact: true })).toBeVisible({ timeout: 2_000 });
  await expect.poll(async () => await page.evaluate(() => Object.values((window as Window & { __localCorpusHistory?: { marks: Record<string, { settled?: number }> } }).__localCorpusHistory?.marks ?? {}).filter((mark) => mark.settled !== undefined).length), { timeout: SETTLEMENT_TIMEOUT_MS, intervals: [10, 20, 50] }).toBe(selected.length);
  const marks = await page.evaluate(() => (window as Window & { __localCorpusHistory?: { marks: Record<string, { immediate?: number; settled?: number }> } }).__localCorpusHistory?.marks ?? {});
  const immediateMs = selected.map((entry) => Number(marks[entry.code]?.immediate) - Number(starts.get(entry.code)));
  const settledMs = selected.map((entry) => Number(marks[entry.code]?.settled) - Number(starts.get(entry.code)));
  const queueMs = selected.map((entry) => Number(marks[entry.code]?.settled) - Number(marks[entry.code]?.immediate));
  const latencyGate = fixtureModule.trustedExactLatencyGate(settledMs);
  const latencyByFixtureClass = fixtureModule.summarizeMeasuredLatency(selected, immediateMs, settledMs, queueMs);
  await testInfo.attach("local-corpus-latency-diagnostic", { contentType: "application/json", body: Buffer.from(JSON.stringify({ latencyGate, latencyByFixtureClass })) });
  expect(latencyGate.maxMs, "every trusted exact scanner burst entry must settle within 2 seconds").toBeLessThanOrEqual(2_000);
  expect(latencyGate.warmP95Ms, "warm trusted exact P95 must remain under 500ms; the first measured scan is cold").toBeLessThanOrEqual(500);
  await expect(input).toBeFocused();
  try {
    await expect(page.getByTestId("pending-count")).toHaveText(/^(?:Waiting to save|All saved): 0$/, { timeout: 30_000 });
  } catch (error) {
    const diagnostic = await page.evaluate((browserConsoleErrors) => ({
      pending: document.querySelector('[data-testid="pending-count"]')?.textContent ?? "",
      syncError: document.querySelector('[data-testid="sync-error"]')?.textContent ?? "",
      selectedBusiness: window.localStorage.getItem("sis-selected-business-v1"),
      queue: (() => {
        try {
          const exposed = (window as Window & { __scanStore?: { getState?: () => unknown } }).__scanStore;
          const liveState = exposed?.getState?.() as { pendingSyncQueue?: unknown[] } | undefined;
          const state = liveState ?? JSON.parse(window.localStorage.getItem("sis-scan-v1") ?? "{}").state;
          const items = Array.isArray(state?.pendingSyncQueue) ? state.pendingSyncQueue : [];
          const byOperation: Record<string, number> = {}; const byStatus: Record<string, number> = {}; const errors: Record<string, number> = {};
          for (const item of items) { byOperation[String(item.operation)] = (byOperation[String(item.operation)] ?? 0) + 1; byStatus[String(item.status)] = (byStatus[String(item.status)] ?? 0) + 1; if (item.lastError) errors[String(item.lastError).replace(/\d{5,}/g, "[redacted]").slice(0, 160)] = (errors[String(item.lastError)] ?? 0) + 1; }
          return { source: liveState ? "window.__scanStore" : "localStorage", total: items.length, byOperation, byStatus, errors };
        } catch { return { unreadable: true }; }
      })(),
      consoleErrors: browserConsoleErrors,
    }), consoleErrors);
    await testInfo.attach("local-corpus-persistence-diagnostic", { contentType: "application/json", body: Buffer.from(JSON.stringify(diagnostic)) });
    throw error;
  }
  let settled;
  const allExpectedIdentities = new Map([...expectedIdentities, [warmEntry.code, fixtureModule.runtimeCanonicalIdFor(warmEntry)]]);
  try { settled = await settledCount(selected.length + 1, allExpectedIdentities); }
  catch (error) {
    const diagnostic = error as Error & { settlementDiagnostic?: unknown };
    await testInfo.attach("local-corpus-settlement-diagnostic", { contentType: "application/json", body: Buffer.from(JSON.stringify(diagnostic.settlementDiagnostic ?? { unavailable: true })) });
    throw error;
  }
  const visual = await page.evaluate(() => { const state = (window as Window & { __localCorpusHistory?: { forbidden: boolean; scannerForbidden: boolean; scannerCounted: number; reviewBadgeForbidden: boolean; observer: MutationObserver | null } }).__localCorpusHistory; state?.observer?.disconnect(); return { forbidden: state?.forbidden ?? true, scannerForbidden: state?.scannerForbidden ?? true, scannerCounted: state?.scannerCounted ?? 0, reviewBadgeForbidden: state?.reviewBadgeForbidden ?? true }; });
  expect(visual.forbidden, "trusted exact UI must not transiently show Suggested, Needs Review, Conflict, or Vendor").toBe(false);
  expect(visual.scannerForbidden, "scanner banner must not transiently claim review, conflict, vendor, or new-code status").toBe(false);
  expect(visual.scannerCounted, "scanner banner must show a terminal Counted confirmation during the measured burst").toBeGreaterThanOrEqual(1);
  expect(visual.reviewBadgeForbidden, "Review navigation badge must never transiently show an open item during the trusted-exact burst").toBe(false);
  expect(unexpectedDialogs, "local corpus proof must not trigger confirmation or session-control dialogs").toEqual([]);
  expect(page.url()).toContain("/scan");
  const allExpectedCodes = [...allExpectedIdentities.keys()];
  await assertVisibleUiSettlement(page, allExpectedCodes, selected.length + 1);
  await page.reload(); await expect(input).toBeFocused({ timeout: 30_000 });
  await expect(page.getByText(`${selected.length + 1} scans`, { exact: true })).toBeVisible({ timeout: 30_000 });
  await assertVisibleUiSettlement(page, allExpectedCodes, selected.length + 1);
  await page.goto("/review");
  const reviewBody = page.getByTestId("review-body");
  await expect(reviewBody.locator('[data-testid^="review-row-"]')).toHaveCount(0);
  await expect(reviewBody).toContainText("Nothing to review");
  await expect(page.locator('a[href="/review"] span')).toHaveCount(0);
  await page.goto("/scan");
  await expect(input).toBeFocused({ timeout: 30_000 });
  await expect(page.getByText(`${selected.length + 1} scans`, { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('a[href="/review"] span')).toHaveCount(0);
  expect(blocked, "local proof must make no external browser requests").toEqual([]);
  const summary = { scope: "synthetic-normal-member-local-emulator", measured: { events: selected.length, counted: selected.length }, warmupBaseline: { events: 1, counted: 1 }, shortest: 20, boundary: selected.length - 20, persisted: { events: settled.events, counted: settled.counted, activeReviews: settled.activeReviews }, identities: [...expectedIdentities.entries()].map(([code, canonicalId]) => ({ code: fixtureModule.redactForReceipt(code), canonicalId: fixtureModule.redactForReceipt(canonicalId) })), scannerIntervalMs: SCANNER_INTERVAL_MS, latencyGate, latencyByFixtureClass, latencyMs: { immediate: { p50: fixtureModule.percentile(immediateMs, .5), p95: fixtureModule.percentile(immediateMs, .95) }, settlement: { p50: fixtureModule.percentile(settledMs, .5), p95: fixtureModule.percentile(settledMs, .95), max: Math.max(...settledMs) }, queue: { p50: fixtureModule.percentile(queueMs, .5), p95: fixtureModule.percentile(queueMs, .95) } } };
  await testInfo.attach("local-corpus-summary", { contentType: "application/json", body: Buffer.from(JSON.stringify(summary)) });
});
