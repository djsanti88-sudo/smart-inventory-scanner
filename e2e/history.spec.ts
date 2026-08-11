import { test, expect, type Page, type Route } from "./fixtures";

// History page proof: scan a couple of codes, open History from the nav, confirm the active
// session shows a live unit count, then click into the session detail page and confirm it opened
// (loosely - the detail page's search/filter UI is owned by a parallel change, so this only checks
// for a search input and the counts table being present, not their exact behavior).

const PROOF = "e2e/proof";

const NO_AI_STATUS = {
  liveEnabled: false, autoDecodeOnScan: false, geminiEnabled: false, openaiEnabled: false,
  geminiConfigured: false, openaiConfigured: false, premiumFallback: false, mode: "off",
  dailyLimit: 200, missingKeys: ["GEMINI_API_KEY", "OPENAI_API_KEY"], e2e: true,
};

async function scan(page: Page, code: string) {
  const input = page.getByTestId("scanner-input");
  await input.click();
  await input.pressSequentially(code, { delay: 2 });
  await input.press("Enter");
}

test("scan two codes, view them in History, open the session detail page", async ({ page }) => {
  await page.route("**/api/ai-lookup", async (route: Route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: NO_AI_STATUS });
    return route.fulfill({ json: {} });
  });

  await page.goto("/login");
  await page.getByTestId("login-button").click();
  await page.waitForURL("**/scan");

  await scan(page, "6419440485331");
  await scan(page, "848983012906");
  await expect(page.getByText("2 scans", { exact: true })).toBeVisible({ timeout: 15_000 });

  // Navigate via the nav link (not a direct goto) to prove the nav wiring.
  await page.getByRole("link", { name: "History" }).click();
  await page.waitForURL("**/history");
  await expect(page.getByTestId("history-table")).toBeVisible();
  await page.screenshot({ path: `${PROOF}/history-01-list.png`, fullPage: true });

  // The active session's row shows units 2 (both scans landed, one product each so far).
  const activeRow = page.locator('[data-testid^="history-row-"]').first();
  const testid = await activeRow.getAttribute("data-testid");
  const sessionId = (testid ?? "").replace("history-row-", "");
  await expect(page.getByTestId(`history-units-${sessionId}`)).toHaveText("2");
  await expect(page.getByTestId(`history-products-${sessionId}`)).toHaveText("2");

  // Clicking the row (not the download button) opens the session detail page.
  await activeRow.click();
  await page.waitForURL(`**/sessions/${sessionId}`);
  await page.screenshot({ path: `${PROOF}/history-02-detail.png`, fullPage: true });

  // A search input exists somewhere on the detail page, and a counts table is present. Loose on
  // purpose: the search/filter UI itself is built in a parallel change.
  const searchInput = page.locator('input[type="search"], input[placeholder*="search" i], [data-testid*="search"]');
  await expect(searchInput.first()).toBeVisible();
  await expect(page.locator('table, [data-testid*="counts-table"]').first()).toBeVisible();
});
