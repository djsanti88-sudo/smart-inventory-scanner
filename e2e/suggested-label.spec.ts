import { test, expect, type Page } from "./fixtures";

// Plan C, Task 4: browser proof that an unknown scan is COUNTED and shows the new "Suggested"
// label (never "Needs review" / "Conflict") - the two-state model from Task 1 (badges.tsx collapses
// needs_review/conflict into "Suggested") combined with the "scan N = count N" invariant from Plan A.
const NO_AI_STATUS = {
  liveEnabled: false, autoDecodeOnScan: false, openaiConfigured: false, mode: "off",
  dailyLimit: 200, missingKeys: ["OPENAI_API_KEY"], e2e: true,
};

// An unknown code not in the seed catalog (same batch used by count-always.spec.ts).
const UNKNOWN_CODE = "697662129691";

async function scan(page: Page, code: string) {
  const input = page.getByTestId("scanner-input");
  await input.click();
  await input.pressSequentially(code, { delay: 2 });
  await input.press("Enter");
}

test("unknown scan counts and shows Suggested, not Needs review or Conflict", async ({ page }) => {
  await page.route("**/api/ai-lookup", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: NO_AI_STATUS });
    return route.fulfill({ json: {} }); // a POST must never fire on this no-key flow
  });
  await page.goto("/login");
  await page.getByTestId("login-button").click();
  await page.waitForURL("**/scan");
  await expect(page.getByTestId("scanner-input")).toBeFocused();

  await scan(page, UNKNOWN_CODE);

  // Counted: the raw feed has the row, and it produced a final-count row (Plan A invariant).
  const feedRow = page.getByTestId("scan-feed-body").locator("tr").filter({ hasText: UNKNOWN_CODE });
  await expect(feedRow).toHaveCount(1);
  await expect(page.getByTestId("final-count-body").locator("tr")).toHaveCount(1);

  // Decode label reads "Suggested" - never the retired "Needs review" / "Conflict" wall copy.
  const decodeBadge = feedRow.getByTestId("decode-row-status");
  await expect(decodeBadge).toHaveText("Suggested");
  await expect(decodeBadge).not.toHaveText("Needs review");
  await expect(decodeBadge).not.toHaveText("Conflict");
  await expect(page.getByTestId("scan-feed-body")).not.toContainText("Needs review");
  await expect(page.getByTestId("scan-feed-body")).not.toContainText("Conflict");

  await page.screenshot({ path: "e2e/proof/plan-c-suggested.png", fullPage: true });
});
