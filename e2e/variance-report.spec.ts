import { test, expect, type Page, type Route } from "./fixtures";

// SDD Task 3.5 e2e proof: seed scans -> save a count snapshot -> change counts -> save a second
// snapshot -> the variance table shows the delta. Run + fixed during the 2026-07-12 merge-train
// gate (see task-3.5-variance-report.md for the original controller decision): the confirm-dialog
// handling and remove-row targeting needed spec-side fixes, documented above each fix.
// Screenshot proof: e2e/proof/variance-report.png.

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

test("count snapshots + variance report: save, change counts, compare, and export", async ({ page }) => {
  await page.route("**/api/ai-lookup", async (route: Route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: NO_AI_STATUS });
    return route.fulfill({ json: {} });
  });

  // FinalCountTable's remove action uses window.confirm(); Playwright dismisses dialogs by default
  // (does NOT auto-accept), so this listener is required for the remove-count click below to work.
  page.on("dialog", (d) => d.accept());

  await page.goto("/login");
  await page.getByTestId("login-button").click();
  await page.waitForURL("**/scan");

  // 1. Seed some counts (known codes from the generic fixture seed).
  await scan(page, "848983012906"); // Falken tire (qty 1)
  await scan(page, "049000028904"); // Coca-Cola (qty 1)

  // Expand the "Sessions and export" details region (VarianceReport lives with the counts UI).
  const details = page.locator("details", { hasText: "Sessions and export" });
  if (await details.getAttribute("open")) {
    // already open under E2E auth bypass
  } else {
    await details.locator("summary").click();
  }

  // 2. Save the first snapshot ("Before").
  await page.getByLabel("snapshot label").fill("Before");
  await page.getByTestId("save-count-snapshot").click();

  // 3. Change counts: scan the Falken tire again (qty 1 -> 2) and remove the Coca-Cola row.
  await scan(page, "848983012906");
  // Scope to the Coca-Cola row specifically (not `.first()`, which depends on DOM order and does
  // not reliably mean "the Coca-Cola row").
  const cokeRow = page.locator("tr", { hasText: "Coca-Cola" });
  await cokeRow.getByTestId(/^remove-count-/).click(); // triggers window.confirm - accepted by the page.on("dialog") listener above

  // 4. Save the second snapshot ("After").
  await page.getByLabel("snapshot label").fill("After");
  await page.getByTestId("save-count-snapshot").click();

  // 5. Compare the two snapshots.
  // Option labels include the snapshot's timestamp (e.g. "Before (7/12/2026, 10:00:00 AM)"), so
  // select by the option's visible text containing the label rather than an exact string match.
  const fromValue = await page.locator("#variance-from option", { hasText: "Before" }).getAttribute("value");
  const toValue = await page.locator("#variance-to option", { hasText: "After" }).getAttribute("value");
  await page.getByLabel(/compare from/i).selectOption(fromValue!);
  await page.getByLabel(/compare to/i).selectOption(toValue!);

  const table = page.getByTestId("variance-table");
  await expect(table).toBeVisible();
  // Falken row: qty went up (delta +1).
  await expect(table).toContainText("+1");
  // Coca-Cola row: removed from the count (delta -1, currQty 0).
  await expect(table).toContainText("-1");

  await page.screenshot({ path: `${PROOF}/variance-report.png`, fullPage: true });

  // 6. CSV export produces a real file.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-variance-csv").click(),
  ]);
  expect(download.suggestedFilename()).toBe("variance-report.csv");
});
