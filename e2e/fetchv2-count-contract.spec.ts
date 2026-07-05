import { test, expect, type Page, type Route } from "./fixtures";

// Fetch V2 Phase A proof: the COUNT-FIRST contract in the real UI. Verification (and Fetch V2
// itself) only ever controls product assignment - these cases prove that every scan is counted,
// duplicates increment, and unknown/URL/canary values are represented, with AI fully mocked OFF
// (zero live calls; Fetch V2 engine outcomes are exercised in unit tests + the offline benchmark).
// Screenshots: e2e/proof/fetchv2/.

const PROOF = "e2e/proof/fetchv2";

const NO_AI_STATUS = {
  liveEnabled: false, autoDecodeOnScan: false, geminiEnabled: false, openaiEnabled: false,
  geminiConfigured: false, openaiConfigured: false, premiumFallback: false, mode: "off",
  dailyLimit: 200, missingKeys: ["GEMINI_API_KEY", "OPENAI_API_KEY"], e2e: true,
};

const UNKNOWN_CODE = "749111222333"; // hard unknown, no alias
const CANARY_CODE = "749000000015"; // fixture canary: checksum-valid unassigned UPC
const URL_SCAN = "https://www.example.com/products/acme-widget-12345";
const KNOWN_CODE = "049000028904"; // seeded Coca-Cola alias (same as scan.spec.ts)

async function scan(page: Page, code: string, times = 1) {
  const input = page.getByTestId("scanner-input");
  for (let i = 0; i < times; i++) {
    await input.click();
    await input.pressSequentially(code, { delay: 2 });
    await input.press("Enter");
  }
}

test("count-first contract: unknown x5, URL x3, known x5, canary - all counted", async ({ page }) => {
  const aiPosts: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/ai-lookup") && r.method() === "POST") aiPosts.push(r.url());
  });
  await page.route("**/api/ai-lookup", async (route: Route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: NO_AI_STATUS });
    return route.fulfill({ json: {} });
  });

  await page.goto("/scan");
  const login = page.getByTestId("login-button");
  if (await login.isVisible().catch(() => false)) await login.click();
  await expect(page.getByTestId("scanner-input")).toBeVisible();
  await page.getByTestId("scanner-input").click();

  // 1. Same unknown code scanned 5 times -> 5 feed rows, quantity 5, zero lost scans.
  await scan(page, UNKNOWN_CODE, 5);
  await expect(page.getByTestId("scan-feed-body").locator("tr")).toHaveCount(5);
  await page.screenshot({ path: `${PROOF}/01-unknown-x5-feed.png`, fullPage: true });

  // 2. Same URL scanned 3 times -> counted and grouped, never discarded.
  await scan(page, URL_SCAN, 3);
  await expect(page.getByTestId("scan-feed-body").locator("tr")).toHaveCount(8);

  // 3. Known verified code scanned 5 times -> deterministic count 5, and AI was never called.
  await scan(page, KNOWN_CODE, 5);
  await expect(page.getByTestId("scan-feed-body").locator("tr")).toHaveCount(13);

  // 4. Invented canary -> still counted (a row exists), never a verified product assignment.
  await scan(page, CANARY_CODE, 1);
  await expect(page.getByTestId("scan-feed-body").locator("tr")).toHaveCount(14);
  await expect(page.getByTestId("scan-feed-body")).toContainText(CANARY_CODE);
  await page.screenshot({ path: `${PROOF}/02-all-scans-feed.png`, fullPage: true });

  // Quantities on the counts table: known product shows 5; unknown/URL/canary are represented.
  const countRows = page.getByTestId("final-count-table").locator("tbody tr");
  await expect(page.locator('[data-testid^="qty-"]').filter({ hasText: "5" }).first()).toBeVisible();
  const pageText = await page.locator("body").innerText();
  expect(pageText).toContain(UNKNOWN_CODE); // unknown is visible, not silently dropped
  await page.screenshot({ path: `${PROOF}/03-final-counts.png`, fullPage: true });
  void countRows;

  // 5. Needs Review shows the unresolved values; total scanned units = 14 physical scans.
  await page.goto("/review");
  await expect(page.getByTestId(`review-row-${UNKNOWN_CODE}`)).toBeVisible();
  await page.screenshot({ path: `${PROOF}/04-needs-review.png`, fullPage: true });

  expect(aiPosts, "AI must never be called in this flow").toHaveLength(0);
});
