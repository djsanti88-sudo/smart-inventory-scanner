import { test, expect, type Page } from "@playwright/test";

// Phase 9 proof, UPDATED for the current contract: the scan-page category dropdown + the "wrong
// category" warning banner are hidden by owner request (SHOW_CATEGORY = false in
// src/app/(app)/scan/page.tsx, commit aeb3218, 2026-06-25) - scanning is category-agnostic in the UI
// now, so there is no visible selector and no blocking/warning banner on this page. The underlying
// scanContext still defaults to "tire" (DEFAULT_SETTINGS) and is settable on Settings; a known Coca-Cola
// alias resolves deterministically and counts regardless of scanContext (the tire-context firewall only
// ever gates AI-decoded results, see e2e/firewall.spec.ts + e2e/auto-count-tire.spec.ts for that proof).
// Re-enable the assertions below (set SHOW_CATEGORY = true) if the selector/banner ever come back.

const PROOF = "e2e/proof";

async function scan(page: Page, code: string) {
  const input = page.getByTestId("scanner-input");
  await input.pressSequentially(code, { delay: 2 });
  await input.press("Enter");
}

test("scan category selector + warning banner are hidden; a known non-tire alias still counts normally", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByTestId("login-button").click();
  await page.waitForURL("**/scan");

  // (a) The category selector and the "wrong category" banner are both hidden (feature flag off).
  await expect(page.getByTestId("scan-category")).toHaveCount(0);
  await page.screenshot({ path: `${PROOF}/scan-category-default.png`, fullPage: true });

  // (b) A seeded NON-tire product (Coca-Cola, 049000028904) is a KNOWN approved alias, so it resolves
  // deterministically and counts - no category conflict banner exists to block or warn about it.
  await scan(page, "049000028904");
  await expect(page.getByTestId("category-warning")).toHaveCount(0);
  await expect(page.getByTestId("final-count-body")).toContainText("Coca");
  await page.screenshot({ path: `${PROOF}/scan-category-warning.png`, fullPage: true });
});
