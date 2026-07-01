import { test, expect, type Page } from "./fixtures";

const NO_AI_STATUS = {
  liveEnabled: false, autoDecodeOnScan: false, geminiEnabled: false, openaiEnabled: false,
  geminiConfigured: false, openaiConfigured: false, premiumFallback: false, mode: "off",
  dailyLimit: 200, missingKeys: ["GEMINI_API_KEY", "OPENAI_API_KEY"], e2e: true,
};

// Six unique codes from the owner's real 174-code batch, none in the seed catalog.
const UNKNOWNS = ["697662129691", "697662131854", "697662137658", "086699368492", "715459275427", "5452000649706"];

async function scan(page: Page, code: string) {
  const input = page.getByTestId("scanner-input");
  await input.click();
  await input.pressSequentially(code, { delay: 2 });
  await input.press("Enter");
}

test("every unknown scan counts, even with AI off (scan N = count N)", async ({ page }) => {
  await page.route("**/api/ai-lookup", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: NO_AI_STATUS });
    return route.fulfill({ json: {} }); // a POST must never fire on this no-key flow
  });
  await page.goto("/login");
  await page.getByTestId("login-button").click();
  await page.waitForURL("**/scan");
  await expect(page.getByTestId("scanner-input")).toBeFocused();

  for (const code of UNKNOWNS) await scan(page, code);

  // Raw feed kept every event.
  await expect(page.getByTestId("scan-feed-body").locator("tr")).toHaveCount(UNKNOWNS.length);
  // Plan A invariant: every unknown was COUNTED -> one final-count row per unique code.
  await expect(page.getByTestId("final-count-body").locator("tr")).toHaveCount(UNKNOWNS.length);
  await page.screenshot({ path: "e2e/proof/count-always.png", fullPage: true });
});
