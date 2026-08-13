import { expect, test, type Page } from "@playwright/test";
import { initializePreviewAdmin } from "./admin.mjs";
import * as previewConfig from "./config.mjs";
import { PREVIEW_LANES, previewBusinessId, previewEmail, previewLaneFixtures, previewPassword } from "./fixtures.mjs";
import { persistedPreviewLaneIsTrusted } from "./persistence.mjs";
import { markCalibration, waitForAllCalibrated, waitForCalibrationTurn } from "./calibration-barrier.mjs";

const trustedExternalHost = (host: string, previewHost: string) => host === previewHost || [
  "identitytoolkit.googleapis.com",
  "securetoken.googleapis.com",
  "firestore.googleapis.com",
  // Vercel injects its own Preview toolbar from this exact platform host. It is not a decode,
  // catalog, AI, UPC, or page-fetch provider, so keep it explicitly scoped rather than wildcarding.
  "vercel.live",
].includes(host);
const COLD_MAX_MS = 2_000;
const WARM_MAX_MS = 2_000;
const VISIBLE_FEED_LIMIT = 100;
// Keep the latency sample deliberately small. Everything after it is one continuous keyboard-wedge
// burst, so this certifies the real queue/backpressure behavior instead of serializing the corpus.
const CALIBRATION_SCANS_PER_LANE = 4;

async function signIn(page: Page, runId: string, lane: number) {
  await page.goto("/login");
  await page.getByTestId("login-email").fill(previewEmail(runId, lane));
  await page.getByTestId("login-password").fill(previewPassword);
  await page.getByTestId("login-button").click();
  await page.waitForURL("**/scan");
  await expect(page.getByTestId("scanner-input")).toBeFocused({ timeout: 30_000 });
}

async function waitForTrustedLane(page: Page, expectedEvents: number, expectedCanonicalGroups: number) {
  await expect.poll(() => page.evaluate(() => {
    const rows = document.querySelectorAll('[data-testid="scan-feed-body"] tr').length;
    const statuses = [...document.querySelectorAll('[data-testid="scan-feed-body"] [data-testid="decode-row-status"]')].map((node) => node.textContent?.trim() ?? "");
    const forbidden = statuses.some((text) => /suggested|needs review|conflict|vendor label/i.test(text));
    const countRows = [...document.querySelectorAll('[data-testid="final-count-body"] tr')];
    const countStatuses = countRows.flatMap((row) => [...row.querySelectorAll('[data-testid="decode-row-status"]')].map((node) => node.textContent?.trim() ?? ""));
    const countedTotal = countRows.reduce((sum, row) => sum + Number(row.querySelector("td")?.textContent?.trim() ?? 0), 0);
    const finalCountsVerified = countStatuses.length === countRows.length && countStatuses.every((text) => /^Verified match$/i.test(text));
    return { rows, badges: statuses.length, forbidden, countRows: countRows.length, countedTotal, finalCountsVerified };
  }), { timeout: 300_000, intervals: [100, 250, 500, 1_000] }).toEqual({ rows: Math.min(expectedEvents, VISIBLE_FEED_LIMIT), badges: Math.min(expectedEvents, VISIBLE_FEED_LIMIT), forbidden: false, countRows: expectedCanonicalGroups, countedTotal: expectedEvents, finalCountsVerified: true });
  await expect(page.getByText(`${expectedEvents} scans`, { exact: true })).toBeVisible();
  if (expectedEvents > VISIBLE_FEED_LIMIT) {
    await expect(page.getByTestId("scan-feed-window")).toHaveText(`Showing most recent ${VISIBLE_FEED_LIMIT}; all scans are retained.`);
  }
}

async function beginForbiddenHistory(page: Page) {
  await page.evaluate(() => {
    const feed = document.querySelector('[data-testid="scan-feed-body"]'); if (!feed) throw new Error("Preview scan feed unavailable.");
    const state = { forbidden: false, observer: null as MutationObserver | null };
    const inspect = (node: Node) => { if (/suggested|needs review|conflict|vendor label/i.test(node.textContent ?? "")) state.forbidden = true; };
    state.observer = new MutationObserver((mutations) => mutations.forEach((mutation) => { inspect(mutation.target); mutation.addedNodes.forEach(inspect); }));
    state.observer.observe(feed, { subtree: true, childList: true, characterData: true });
    (window as typeof window & { __previewForbiddenHistory?: typeof state }).__previewForbiddenHistory = state;
  });
}

async function assertNoForbiddenHistory(page: Page) {
  const forbidden = await page.evaluate(() => { const holder = window as typeof window & { __previewForbiddenHistory?: { forbidden: boolean; observer: MutationObserver | null } }; const state = holder.__previewForbiddenHistory; state?.observer?.disconnect(); delete holder.__previewForbiddenHistory; return state?.forbidden; });
  expect(forbidden).toBe(false);
}

async function waitForNewestTrustedRow(page: Page, expectedRows: number) {
  await expect(page.getByTestId("scan-feed-body").locator("tr")).toHaveCount(expectedRows, { timeout: 30_000 });
  const newest = page.getByTestId("scan-feed-body").locator("tr").first();
  await expect.poll(async () => {
    const decodedBadge = newest.getByTestId("decode-row-status");
    const status = await decodedBadge.count()
      ? ((await decodedBadge.textContent()) ?? "").trim()
      : ((await newest.locator("td").nth(-3).textContent()) ?? "").trim();
    return /^(Verified \(app-confirmed\)|Counted)$/i.test(status);
  }, { timeout: 30_000, intervals: [25, 50, 100, 250] }).toBe(true);
}

for (let lane = 0; lane < PREVIEW_LANES; lane++) {
  test(`Preview exhaustive trusted-exact scanner lane ${String(lane).padStart(2, "0")}`, async ({ page }, testInfo) => {
    test.setTimeout(3_600_000);
    const config = previewConfig.readPreviewCertificationConfig(process.env); const fixture = previewLaneFixtures(lane);
    const unexpectedEgress = new Set<string>();
    const exactResponses = new Map<string, { good: boolean; attempts: number }>();
    let badExactAttempts = 0;
    let authenticatedExactIdToken = "";
    page.on("request", (request) => { const host = new URL(request.url()).hostname; if (!trustedExternalHost(host, new URL(config.baseURL).hostname)) unexpectedEgress.add(host); });
    page.on("response", async (response) => {
      // The page also polls GET /api/ai-lookup for capability/status. It has no decode request body
      // or exact-result payload and must never be mistaken for a failed deterministic POST.
      if (new URL(response.url()).pathname !== "/api/ai-lookup" || response.request().method() !== "POST") return;
      let requestKey = "unparsed-request";
      try {
        const requestBody = response.request().postDataJSON() as { cleanCode?: unknown; idToken?: unknown };
        if (typeof requestBody?.idToken === "string" && requestBody.idToken) authenticatedExactIdToken = requestBody.idToken;
        if (typeof requestBody?.cleanCode === "string" && requestBody.cleanCode) requestKey = requestBody.cleanCode;
        const body = await response.json() as { debug?: { trustedExactIndex?: { contentDigest?: string }; aiCalled?: boolean; pageFetched?: boolean }; decision?: { status?: string; corroborationPath?: string; trustedExactCanonicalProductId?: string }; results?: unknown[] };
        const good = response.status() === 200 && body.debug?.aiCalled === false && body.debug?.pageFetched === false && body.decision?.status === "verified" && body.decision?.corroborationPath === "boss_trusted_exact_barcode" && Boolean(body.decision?.trustedExactCanonicalProductId) && body.results?.length === 1 && body.debug?.trustedExactIndex?.contentDigest?.toLowerCase() === fixture.manifest.contentDigest.toLowerCase();
        const prior = exactResponses.get(requestKey);
        exactResponses.set(requestKey, { good: Boolean(prior?.good || good), attempts: (prior?.attempts ?? 0) + 1 });
        if (!good) badExactAttempts++;
      } catch {
        const prior = exactResponses.get(requestKey);
        exactResponses.set(requestKey, { good: Boolean(prior?.good), attempts: (prior?.attempts ?? 0) + 1 });
        badExactAttempts++;
      }
    });
    const latenciesMs: number[] = [];
    let coldLatencyMs = Number.POSITIVE_INFINITY;
    let warmLatenciesMs: number[] = [];
    const calibrationCount = Math.min(CALIBRATION_SCANS_PER_LANE, fixture.uiSpellings.length);
    await waitForCalibrationTurn(config.runId, lane);
    try {
      await signIn(page, config.runId, lane);
      await beginForbiddenHistory(page);
      for (let index = 0; index < calibrationCount; index++) {
        const started = performance.now();
        await page.keyboard.insertText(fixture.uiSpellings[index]); await page.keyboard.press("Enter");
        await waitForNewestTrustedRow(page, index + 1);
        latenciesMs.push(performance.now() - started);
      }
      coldLatencyMs = latenciesMs[0] ?? Number.POSITIVE_INFINITY;
      warmLatenciesMs = latenciesMs.slice(1);
      expect(coldLatencyMs).toBeLessThanOrEqual(COLD_MAX_MS);
      expect(Math.max(...warmLatenciesMs)).toBeLessThanOrEqual(WARM_MAX_MS);
      markCalibration(config.runId, lane, "ready");
    } catch (error) {
      markCalibration(config.runId, lane, "failed");
      throw error;
    }
    await waitForAllCalibrated(config.runId);
    for (let index = calibrationCount; index < fixture.uiSpellings.length; index++) {
      await page.keyboard.insertText(fixture.uiSpellings[index]); await page.keyboard.press("Enter");
    }
    const expectedByCanonical = Object.fromEntries(fixture.groups.map((group: { canonicalKey: string; spellings: string[] }) => [`trusted-exact:${group.canonicalKey}`, group.spellings.length]));
    // No per-scan settlement barrier is allowed after calibration: this is the continuous scanner
    // burst. The assertions below prove all physical scans/counts survive it and focus recovers.
    await expect(page.getByTestId("scanner-input")).toBeFocused();
    await waitForTrustedLane(page, fixture.uiSpellings.length, fixture.groups.length);
    await expect(page.getByTestId("pending-count")).toHaveText(/^(?:Waiting to save|All saved): 0$/, { timeout: 300_000 });
    // Per-lane samples contain only three warm scans, so a per-lane "p95" is just that lane's
    // maximum and is statistically meaningless. Keep hard 2s outlier ceilings here; the reporter
    // aggregates all 60 warm samples and enforces the real Preview p95<=500ms and p99<=750ms gates.
    // Leading-zero aliases already learned by the trusted settlement can resolve synchronously
    // in the browser. They must not be forced back through the route just to paint a badge.
    // A bounded transport retry may yield an intermediate non-terminal response. Certify the outcome
    // per requested code: every code that entered the route must eventually produce a verified,
    // corpus-fingerprinted exact response, while the UI/history assertions prove it never surfaced as
    // Suggested or Needs Review. Keeping every attempt in the gate would incorrectly reject a recovered
    // retry even though the product contract explicitly retries it.
    expect(exactResponses.size).toBeGreaterThan(0);
    expect([...exactResponses.values()].filter((response) => !response.good)).toHaveLength(0);
    expect(unexpectedEgress).toEqual(new Set());
    const admin = await initializePreviewAdmin(config); const businessId = previewBusinessId(config.runId, lane);
    await expect.poll(async () => {
      const [events, products, reviews, aliases, counts] = await Promise.all([admin.db.collection(`businesses/${businessId}/scanEvents`).get(), admin.db.collection(`businesses/${businessId}/products`).get(), admin.db.collection(`businesses/${businessId}/unknownCodeReviews`).get(), admin.db.collection(`businesses/${businessId}/aliases`).get(), admin.db.collection(`businesses/${businessId}/inventoryCounts`).get()]);
      return aliases.size === 0 && persistedPreviewLaneIsTrusted({ events: events.docs.map((doc: { id: string; data(): object }) => ({ id: doc.id, ...doc.data() })), products: products.docs.map((doc: { id: string; data(): object }) => ({ id: doc.id, ...doc.data() })), reviews: reviews.docs.map((doc: { data(): object }) => doc.data()), counts: counts.docs.map((doc: { data(): object }) => doc.data()), expectedEvents: fixture.uiSpellings.length, expectedByCanonical });
    }, { timeout: 300_000, intervals: [250, 500, 1_000] }).toBe(true);
    await assertNoForbiddenHistory(page);
    await page.reload();
    await expect(page.getByTestId("scanner-input")).toBeFocused({ timeout: 30_000 });
    await waitForTrustedLane(page, fixture.uiSpellings.length, fixture.groups.length);
    // Negative API proofs use an approved corpus spelling only after the positive lane is
    // durable. They never permit a provider fallback and cross-tenant uses the real caller
    // token while changing only the claimed business id.
    const unauthenticated = await page.request.post("/api/ai-lookup", { data: { mode: "decode", deterministicOnly: true, rawCode: fixture.uiSpellings[0], cleanCode: fixture.uiSpellings[0] } });
    expect(unauthenticated.status()).toBe(401);
    const foreignBusinessId = previewBusinessId(config.runId, (lane + 1) % PREVIEW_LANES);
    expect(authenticatedExactIdToken, "positive exact traffic must expose the real caller token for the direct cross-tenant probe").not.toBe("");
    const crossTenant = await page.request.post("/api/ai-lookup", {
      data: {
        mode: "decode",
        deterministicOnly: true,
        idToken: authenticatedExactIdToken,
        businessId: foreignBusinessId,
        rawCode: fixture.uiSpellings[0],
        cleanCode: fixture.uiSpellings[0],
      },
    });
    expect(crossTenant.status()).toBe(403);
    await expect(page.getByTestId("scan-feed-body").locator("tr")).toHaveCount(Math.min(fixture.uiSpellings.length, VISIBLE_FEED_LIMIT));
    await testInfo.attach("boss-preview-lane-summary", { contentType: "application/json", body: Buffer.from(JSON.stringify({ lane, uiEvents: fixture.uiSpellings.length, canonicalGroups: fixture.groups.length, fingerprint: fixture.manifest.contentDigest, unexpectedEgress: unexpectedEgress.size, coldLatencyMs, warmLatenciesMs, exactRequestCodes: exactResponses.size, badExactAttempts, unauthenticatedStatus: unauthenticated.status(), crossTenantStatus: crossTenant.status() })) });
  });
}
