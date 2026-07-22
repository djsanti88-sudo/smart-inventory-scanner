import { test, expect, type Page } from "@playwright/test";

// Proves the scanner-focus fix: the Scan page has no Clear Cache control (so the scanner's trailing
// Enter can never trigger a confirm dialog), the scan input stays focused, and continuous scanning
// works without clicking the page. Clear Cache lives only on Settings.

const PROOF = "e2e/proof";

async function scan(page: Page, code: string) {
  const input = page.getByTestId("scanner-input");
  await input.pressSequentially(code, { delay: 2 });
  await input.press("Enter");
}

test("scanner focus: no Clear Cache on Scan page, input stays focused, no dialog on Enter", async ({
  page,
}) => {
  // Fail loudly if ANY browser dialog (e.g. a Clear Cache confirm) appears during scanning.
  let dialogOpened = false;
  page.on("dialog", async (d) => {
    dialogOpened = true;
    await d.dismiss();
  });

  await page.goto("/login");
  await page.getByTestId("login-button").click();
  await page.waitForURL("**/scan");

  // 2. Clear Cache button absent on the Scan page.
  await expect(page.getByTestId("clear-cache")).toHaveCount(0);

  // 3. Scan input auto-focused on load.
  await expect(page.getByTestId("scanner-input")).toBeFocused();

  // 4-6. Scan a code -> appears in the feed -> input still focused (no click needed).
  await scan(page, "6419440485331");
  await expect(page.getByTestId("scan-feed-body")).toContainText("6419440485331");
  await expect(page.getByTestId("scanner-input")).toBeFocused();

  // Continuous scanning stays focused.
  await scan(page, "T432119");
  await scan(page, "UNKNOWNZZZ");
  await expect(page.getByTestId("scanner-input")).toBeFocused();

  // 7-8. Press Enter while the scanner input is active -> NO dialog appears.
  await page.getByTestId("scanner-input").press("Enter");
  await page.getByTestId("scanner-input").press("Enter");
  expect(dialogOpened).toBe(false);

  await page.screenshot({ path: `${PROOF}/scanner-focus-fix.png`, fullPage: true });

  // 9-10. Clear Cache exists on Settings.
  await page.goto("/settings");
  await expect(page.getByTestId("clear-cache")).toBeVisible();
});

// P6 C2: the first-run banner (GC-D) must never steal focus from the scanner input, and must
// disappear the instant a scan lands (feed non-empty / firstScanAt set) - proven through a fresh,
// unscanned session (separate browser context so localStorage starts empty).
test("first-run banner: visible before any scan, never steals scanner focus, gone after one scan", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto("/login");
  await page.getByTestId("login-button").click();
  await page.waitForURL("**/scan");

  // Banner visible on a fresh, never-scanned session.
  await expect(page.getByTestId("first-run-banner")).toBeVisible();
  await expect(page.getByTestId("first-run-banner")).toContainText(
    "Scan your first barcode to start counting. The scan box is already focused and ready.",
  );

  // GC-D: the scanner input keeps focus while the banner is visible - it is a passive div, never
  // focusable, never intercepts keys.
  await expect(page.getByTestId("scanner-input")).toBeFocused();

  // After one scan: the row appears + counts, and the banner is gone.
  await scan(page, "6419440485331");
  await expect(page.getByTestId("scan-feed-body")).toContainText("6419440485331");
  await expect(page.getByTestId("first-run-banner")).toHaveCount(0);
  await expect(page.getByTestId("scanner-input")).toBeFocused();

  await page.screenshot({ path: `${PROOF}/first-run-banner.png`, fullPage: true });

  await context.close();
});
