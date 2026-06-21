import { test, expect, type Page, type Route } from "./fixtures";

// Proof for the product-identity hotfix. The three previously-poisoned codes must NEVER resolve to
// the wrong products; they must go to Needs Review. A human approval then makes the code
// deterministic on the next scan, with no AI call.

const PROOF = "e2e/proof";

// This flow proves the DETERMINISTIC resolver with NO AI. master defaults AI on and auto-enables it when
// a provider key is configured, so we run it in a NO-KEYS environment: the auto-decode gate fails on
// hasKey, so unknown scans go straight to Needs Review with zero AI calls.
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

test("resolver never maps codes to wrong products; human approval makes them deterministic", async ({
  page,
}) => {
  const aiCalls: string[] = [];
  page.on("request", (r) => {
    // Only POST is an AI lookup; GET is the no-secret capability/status check.
    if (r.url().includes("/api/ai-lookup") && r.method() === "POST") aiCalls.push(r.url());
  });
  page.on("dialog", (d) => d.accept()); // auto-accept the Clear cache confirmation
  await page.route("**/api/ai-lookup", async (route: Route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: NO_AI_STATUS });
    return route.fulfill({ json: {} }); // a POST must never fire on this deterministic, no-key flow
  });

  await page.goto("/login");
  await page.getByTestId("login-button").click();
  await page.waitForURL("**/scan");

  // Start from a guaranteed-clean cache. Clear Cache now lives only on Settings (off the Scan page).
  await page.goto("/settings");
  await page.getByTestId("clear-cache").click();
  await page.goto("/scan");
  await expect(page.getByTestId("final-count-body")).toContainText("No counts yet.");
  await page.screenshot({ path: `${PROOF}/resolver-01-clean.png`, fullPage: true });

  // Scan the three formerly-misresolved codes.
  await scan(page, "855724007602");
  await scan(page, "078742051451");
  await scan(page, "X004DY7YUT");

  // None of them were counted (no wrong product rows at all).
  await expect(page.getByTestId("final-count-body")).toContainText("No counts yet.");
  // The page must NOT contain the wrong product identities anywhere.
  await expect(page.locator("body")).not.toContainText("Laird");
  await expect(page.locator("body")).not.toContainText("Leviton");

  // All three are in Needs Review.
  await page.goto("/review");
  await expect(page.getByTestId("review-row-855724007602")).toBeVisible();
  await expect(page.getByTestId("review-row-078742051451")).toBeVisible();
  await expect(page.getByTestId("review-row-X004DY7YUT")).toBeVisible();
  // The Amazon label explains itself as a vendor label.
  await expect(page.getByTestId("review-row-X004DY7YUT")).toContainText(/label/i);
  await page.screenshot({ path: `${PROOF}/resolver-02-needs-review.png`, fullPage: true });

  // Human approves a correction: link 855724007602 to a real verified product (Coca-Cola).
  const row = page.getByTestId("review-row-855724007602");
  await row.getByLabel("link to product").selectOption({ label: "Coca-Cola 12 pack 12 oz cans" });
  await row.getByTestId("link-existing").click();
  await expect(row).toContainText("Resolved");
  await page.screenshot({ path: `${PROOF}/resolver-03-approved.png`, fullPage: true });

  // Re-scan the approved code: now it is deterministic Known and counts (no AI involved).
  await page.goto("/scan");
  await scan(page, "855724007602");
  await expect(page.getByTestId("qty-prod-coke")).toHaveText("2"); // 1 from approve+count, 1 from re-scan
  // The other two stay unresolved (still Needs Review), never wrongly counted.
  await expect(page.getByTestId("final-count-body")).not.toContainText("Laird");
  await page.screenshot({ path: `${PROOF}/resolver-04-deterministic.png`, fullPage: true });

  // AI was never called at any point in this flow.
  expect(aiCalls).toHaveLength(0);
});
