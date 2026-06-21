import { test, expect, type Page } from "@playwright/test";

// Phase 9 proof: the scan page defaults to Tires, and scanning a non-tire product in Tires mode shows a
// non-blocking, dismissible warning banner (the item still routes to Needs Review).

const PROOF = "e2e/proof";

async function scan(page: Page, code: string) {
  const input = page.getByTestId("scanner-input");
  await input.pressSequentially(code, { delay: 2 });
  await input.press("Enter");
}

test("scan category defaults to Tires and warns on a non-tire scan", async ({ page }) => {
  await page.goto("/login");
  await page.getByTestId("login-button").click();
  await page.waitForURL("**/scan");

  // (a) The category selector is always visible on the scan page and defaults to Tires.
  const selector = page.getByTestId("scan-category");
  await expect(selector).toBeVisible();
  await expect(selector).toHaveValue("tire");
  await page.screenshot({ path: `${PROOF}/scan-category-default.png`, fullPage: true });

  // (b) Scan a seeded NON-tire product (Coca-Cola, 049000028904) in Tires mode -> blocked + banner.
  await scan(page, "049000028904");
  const banner = page.getByTestId("category-warning");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(/doesn.?t match your Tires category/i);
  await expect(banner.getByTestId("category-warning-switch")).toBeVisible();
  await expect(page.getByTestId("final-count-body")).not.toContainText("Coca");
  await page.screenshot({ path: `${PROOF}/scan-category-warning.png`, fullPage: true });
});
