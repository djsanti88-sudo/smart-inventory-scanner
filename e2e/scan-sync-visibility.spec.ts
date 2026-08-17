import { test, expect, type Page } from "@playwright/test";

// loop2-ui report, finding UI2-1: SyncStatusBar (online/offline, pending count, "Saved locally, not
// synced yet", the Retry button) is the ONLY aggregate sync surface on /scan, but it lives inside a
// <details> that is collapsed by default for every real user - only Playwright's E2E auth-bypass webServer
// expands it. Every OTHER mock e2e config sets NEXT_PUBLIC_E2E_AUTH_BYPASS=1 for its whole process, which
// also drives that collapse/expand state, so no spec running under those configs could ever prove this.
// This spec runs under playwright.no-bypass.config.ts (port 3101, no bypass flag, mock/open-access auth -
// see that file's header comment for why that is a faithful "real user" load, not a synthetic shortcut).
//
// Run with: npx playwright test --config=playwright.no-bypass.config.ts e2e/scan-sync-visibility.spec.ts

const NO_AI_STATUS = {
  liveEnabled: false, autoDecodeOnScan: false, geminiEnabled: false, openaiEnabled: false,
  geminiConfigured: false, openaiConfigured: false, premiumFallback: false, mode: "off",
  dailyLimit: 200, missingKeys: ["GEMINI_API_KEY", "OPENAI_API_KEY"], e2e: true,
};

async function stubAiLookup(page: Page) {
  await page.route("**/api/ai-lookup", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: NO_AI_STATUS });
    return route.fulfill({ json: {} });
  });
}

async function scan(page: Page, code: string) {
  const input = page.getByTestId("scanner-input");
  await input.click();
  await input.pressSequentially(code, { delay: 2 });
  await input.press("Enter");
}

test("real (non-E2E) session: offline sync state is visible above the fold without expanding any panel or scrolling", async ({ page }) => {
  await stubAiLookup(page);
  await page.goto("/scan");
  await expect(page.getByTestId("scanner-input")).toBeVisible();

  // Confirm this really is the collapsed, real-user state (not the E2E-expanded one): the "Sessions and
  // export" panel's contents (SyncStatusBar's own testids) must NOT be visible yet.
  await expect(page.getByTestId("pending-warning")).toBeHidden();

  await page.context().setOffline(true);

  await scan(page, "6419440485331");

  // TOP-LEVEL LAW: the scan still appears and counts even while genuinely offline.
  await expect(page.getByTestId("scan-feed-body").locator("tr")).toHaveCount(1);

  // The fix: an honest sync-pending signal is visible WITHOUT expanding "Sessions and export" and
  // without any horizontal scroll (this assertion alone would fail before the fix - the only prior
  // signal was SyncStatusBar, hidden inside the collapsed <details>, and the per-row SyncBadge sits in
  // the feed's last, horizontally-scrolled column).
  const indicator = page.getByTestId("sync-status-indicator");
  await expect(indicator).toBeVisible();
  await expect(indicator).toContainText(/offline/i);

  // Still true: the panel itself remains collapsed (this indicator lives outside it).
  await expect(page.getByTestId("pending-warning")).toBeHidden();

  await page.context().setOffline(false);
});

test("real (non-E2E) session: the indicator is silent on the healthy path (no clutter)", async ({ page }) => {
  await stubAiLookup(page);
  await page.goto("/scan");
  await expect(page.getByTestId("scanner-input")).toBeVisible();

  // Online, nothing scanned yet, nothing pending: the indicator must render nothing at all.
  await expect(page.getByTestId("sync-status-indicator")).toHaveCount(0);
});
