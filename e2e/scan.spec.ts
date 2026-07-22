import { test, expect, type Page, type Route } from "./fixtures";

// End-to-end proof of the Smart Inventory Scanner. One serial flow so local state (Zustand) is
// preserved across pages. Screenshots are written to e2e/proof/.

const PROOF = "e2e/proof";

// AI is OFF for this deterministic proof. master defaults AI on + auto-enables it when a provider key is
// configured, so we mock a NO-KEYS status: the auto-decode gate fails on hasKey -> zero AI calls.
const NO_AI_STATUS = {
  liveEnabled: false, autoDecodeOnScan: false, geminiEnabled: false, openaiEnabled: false,
  geminiConfigured: false, openaiConfigured: false, premiumFallback: false, mode: "off",
  dailyLimit: 200, missingKeys: ["GEMINI_API_KEY", "OPENAI_API_KEY"], e2e: true,
};

const SEQUENCE = [
  "6419440485331",
  "T432119%RU1%",
  "T432119",
  "848983012906",
  "2881-6861",
  "28816861",
  "049000028904",
  "7262",
  "UNKNOWN123",
];

async function scan(page: Page, code: string) {
  const input = page.getByTestId("scanner-input");
  await input.click();
  // Simulate a hardware scanner: fast keystrokes then Enter.
  await input.pressSequentially(code, { delay: 2 });
  await input.press("Enter");
}

test("full inventory scan proof", async ({ page }) => {
  // Track AI calls so we can prove the known codes never triggered AI.
  const aiCalls: string[] = [];
  page.on("request", (r) => {
    // Only POST is an AI lookup; GET is the (cheap, no-secret) capability/status check.
    if (r.url().includes("/api/ai-lookup") && r.method() === "POST") aiCalls.push(r.url());
  });
  await page.route("**/api/ai-lookup", async (route: Route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: NO_AI_STATUS });
    return route.fulfill({ json: {} }); // a POST must never fire on this deterministic, no-key flow
  });

  // 1. Login screen
  await page.goto("/login");
  await expect(page.getByTestId("login-button")).toBeVisible();
  await page.screenshot({ path: `${PROOF}/01-login.png`, fullPage: true });

  await page.getByTestId("login-button").click();
  await page.waitForURL("**/scan");

  // 2. Scan screen before scanning. The dedicated scanner input is auto-focused.
  await expect(page.getByTestId("scanner-input")).toBeFocused();
  await page.screenshot({ path: `${PROOF}/02-scan-before.png`, fullPage: true });

  // 3. Run the acceptance sequence (rapid input).
  for (const code of SEQUENCE) await scan(page, code);

  // Grouped quantities (proves aliases collapse many codes into one product, no truncation).
  await expect(page.getByTestId("qty-prod-nokian")).toHaveText("3");
  await expect(page.getByTestId("qty-prod-falken")).toHaveText("3");
  await expect(page.getByTestId("qty-prod-coke")).toHaveText("2");

  // Raw feed kept every event; rapid input was not truncated.
  await expect(page.getByTestId("scan-feed-body").locator("tr")).toHaveCount(SEQUENCE.length);
  await expect(page.getByTestId("scan-feed-body")).toContainText("UNKNOWN123");
  await expect(page.getByTestId("scan-feed-body")).toContainText("T432119%RU1%");

  // AI was NOT called for any known code.
  expect(aiCalls).toHaveLength(0);
  await expect(page.getByTestId("ai-status")).toContainText("Off");

  await page.screenshot({ path: `${PROOF}/03-live-feed.png`, fullPage: true });
  await page.screenshot({ path: `${PROOF}/04-final-counts.png`, fullPage: true });

  // 4. Image hover preview (front-end only; falls back gracefully for unreachable URLs). Owner rule
  // (fc2188a, 2026-07-01, predates this test's last update) dropped the Image column from the scan
  // page's Final Count table - the image-hover preview now lives on the Products page instead.
  await page.goto("/products");
  await page.getByTestId("image-link").first().hover();
  await expect(page.getByTestId("image-hover-card").first()).toBeVisible();
  await page.screenshot({ path: `${PROOF}/06-image-hover.png`, fullPage: true });
  await page.goto("/scan");

  // 5. CSV export works from local state (even before any sync concerns). Exports now live in the
  // unified "Export" dropdown; open it first. The CSV chip keeps the legacy export-final-counts testid.
  await page.getByTestId("export-menu-trigger").click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-final-counts").click(),
  ]);
  expect(download.suggestedFilename()).toBe("final-counts.csv");
  await download.saveAs(`${PROOF}/final-counts.csv`);

  // 6. Pending sync proof: simulate a sync failure, scan a known code, see it saved locally + pending.
  await page.getByTestId("toggle-sync-failure").check();
  await scan(page, "T432119"); // Nokian 3 -> 4 locally
  await expect(page.getByTestId("qty-prod-nokian")).toHaveText("4");
  await expect(page.getByTestId("pending-warning")).toBeVisible();
  await expect(page.getByTestId("pending-count")).not.toContainText("Waiting to save: 0");
  await page.screenshot({ path: `${PROOF}/08-pending-sync.png`, fullPage: true });

  // 7. Retry proof: stop failing, retry repeatedly, confirm queue drains and count never doubles.
  await page.getByTestId("toggle-sync-failure").uncheck();
  await page.getByTestId("retry-sync").click();
  // Retry button disables once the queue is empty; run it again if still enabled.
  if (await page.getByTestId("retry-sync").isEnabled()) {
    await page.getByTestId("retry-sync").click();
  }
  await expect(page.getByTestId("pending-count")).toContainText("Waiting to save: 0");
  await expect(page.getByTestId("qty-prod-nokian")).toHaveText("4"); // not doubled
  await page.screenshot({ path: `${PROOF}/09-retry-sync.png`, fullPage: true });

  // 8. Needs Review + permanent alias learning.
  await page.goto("/review");
  await expect(page.getByTestId("review-row-UNKNOWN123")).toBeVisible();
  await page.screenshot({ path: `${PROOF}/05-needs-review.png`, fullPage: true });

  const row = page.getByTestId("review-row-UNKNOWN123");
  await row.getByLabel("link to product").selectOption({ label: "Coca-Cola 12 pack 12 oz cans" });
  await row.getByTestId("link-existing").click();
  // Owner rule (fc2188a, 2026-07-01, predates this test's last update): Needs Review hides items that
  // are already resolved AND synced, so the row disappears from the queue entirely instead of lingering
  // with a "Resolved" badge.
  await expect(row).toHaveCount(0);

  // Future scans of the learned code are deterministic (match Coca-Cola, no new review).
  await page.goto("/scan");
  await scan(page, "UNKNOWN123");
  await expect(page.getByTestId("qty-prod-coke")).toHaveText("4"); // 2 + applyToCount + re-scan
  await page.screenshot({ path: `${PROOF}/10-alias-learned.png`, fullPage: true });
});
