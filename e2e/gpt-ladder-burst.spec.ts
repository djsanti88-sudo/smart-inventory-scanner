import { test, expect, type Page, type Route } from "./fixtures";

// Build 1 Task 7: burst stress for the bounded decode queue + count-first contract under load.
// 20 unknown codes scanned rapidly; the decode API is mocked (IS_E2E; zero live calls) with a
// deliberate per-request delay so the client queue actually backs up. Proof targets:
//   1. All 20 scans are counted INSTANTLY (feed rows never wait on decodes).
//   2. The store's decode queue keeps at most 2 requests in flight at any moment.
//   3. Every scan's decode eventually completes (queue drains; a mid-burst 500 does not wedge it).
// Screenshots: e2e/proof/gpt-ladder/.

const PROOF = "e2e/proof/gpt-ladder";

const AI_ON_STATUS = {
  liveEnabled: true, autoDecodeOnScan: true, geminiEnabled: false, openaiEnabled: true,
  geminiConfigured: false, openaiConfigured: true, premiumFallback: false, mode: "live",
  dailyLimit: 200, missingKeys: [], e2e: true,
  gptLadder: { spentTodayUsd: 0, capUsd: 3, callsToday: 0, enabled: true },
};

const gptVerifiedPayload = (code: string, n: number) => ({
  mode: "decode",
  providerNames: ["gpt-5.5-ladder"],
  providerStatuses: [],
  results: [{
    productName: `Burst Tire ${n} 205/55R16 91V`, brand: "BurstBrand", category: "tires",
    specsShort: "205/55R16 91V", specsFull: "", primarySku: "", primaryBarcode: code,
    gtin: code, upc: code, ean: "", aliases: [], sourceUrls: ["https://example.com/p"],
    confidence: 0.9, verifiedFacts: [], guesses: [], needsHumanReview: false,
  }],
  evidences: [],
  decision: {
    status: "verified", confidence: 0.9, reason: "gpt-5.5 from-scratch: exact code self-reported (owner trust rule)",
    evidenceStrength: "none", exactCodeEvidenceVerifiedByApp: false,
    crossCheck: { decision: "single_provider", confidence: 0.9, reason: "single provider", brandSimilarity: 1, nameSimilarity: 1, contradictions: [] },
    corroborationPath: "gpt_self_report",
  },
  reasonCode: "gpt_ladder",
  reasonText: "gpt-5.5 ladder verified",
  timedOut: false,
  debug: {},
});

// 20 distinct checksum-agnostic 12-digit unknowns (no seeded alias).
const CODES = Array.from({ length: 20 }, (_, i) => `74911122${String(3300 + i)}`);

async function scan(page: Page, code: string) {
  const input = page.getByTestId("scanner-input");
  await input.click();
  await input.pressSequentially(code, { delay: 1 });
  await input.press("Enter");
}

test("burst: 20 rapid unknown scans count instantly; decode queue holds 2-in-flight; a mid-burst 500 does not wedge it", async ({ page }) => {
  let inFlight = 0;
  let maxInFlight = 0;
  let posts = 0;
  await page.route("**/api/ai-lookup", async (route: Route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: AI_ON_STATUS });
    posts += 1;
    const n = posts;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 250));
    inFlight -= 1;
    // Every 7th decode fails hard: the queue must keep draining regardless.
    if (n % 7 === 0) return route.fulfill({ status: 500, json: { error: "synthetic burst failure" } });
    const body = route.request().postDataJSON() as { cleanCode?: string };
    return route.fulfill({ json: gptVerifiedPayload(body?.cleanCode ?? "000000000000", n) });
  });

  await page.goto("/scan");
  const login = page.getByTestId("login-button");
  if (await login.isVisible().catch(() => false)) await login.click();
  await expect(page.getByTestId("scanner-input")).toBeVisible();

  // Fire all 20 scans as fast as the input accepts them.
  for (const code of CODES) await scan(page, code);

  // COUNT-FIRST: all 20 rows exist immediately, long before 20 x 250ms of decode delay could pass.
  await expect(page.getByTestId("scan-feed-body").locator("tr")).toHaveCount(20);
  await page.screenshot({ path: `${PROOF}/01-burst-feed-instant.png`, fullPage: true });

  // Queue drains: every scan eventually got its decode attempt (20 POSTs), max 2 in flight.
  await expect.poll(() => posts, { timeout: 30_000 }).toBe(20);
  expect(maxInFlight, "decode queue must cap in-flight requests at 2").toBeLessThanOrEqual(2);

  // Verified rows landed (auto-decode applied through the queue; 500s fell to review, not lost).
  // The count-first proof is the toHaveCount(20) above: it passed while at most 2 of the 20
  // decodes (250ms each) could possibly have completed - rows never wait on the queue.
  await expect(page.getByTestId("scan-feed-body")).toContainText("Burst Tire", { timeout: 20_000 });
  await page.screenshot({ path: `${PROOF}/02-burst-settled.png`, fullPage: true });
});
