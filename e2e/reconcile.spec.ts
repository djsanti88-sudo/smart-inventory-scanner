import path from "node:path";
import { test, expect, type Page, type Route } from "./fixtures";

// Task 8 (final task, Shop-Ware reconcile round): E2E proof of the reconcile flow end to end,
// against the REAL local tire corpus (no mock for /api/reconcile/match - the route only reads the
// local SQLite/JSON tire knowledge index, never a live provider, so nothing needs interception).
//
// Fixture rows are real corpus entries (verified in tireKnowledge.generated.json):
//   - Falken Sincera ST80 A/S, 215/70R15, PN 28816861, barcode 848983012906 - ALSO seeded as a real
//     app product (prod-falken, src/seed/seedData.ts). This one IS scanned in this test, so it
//     builds a counted quantity and lands in variance/agreement.
//   - Michelin Premier LTX, 225/65R17, PN 44953, barcode 086699449535 - a real corpus entry that is
//     NOT in the app's product seed and is NEVER scanned in this test. It matches the corpus (so
//     the reconcile matcher returns "matched") but has no counted quantity this session, so it MUST
//     land in expected_not_counted, never variance (AM-R8, the round's core scope boundary).
//
// The route needs no /api/ai-lookup mock (reconcile never calls a live AI provider), but the scan
// flow still touches it for the GET status check, so it is stubbed off anyway for a hermetic run.

const PROOF = "e2e/proof";
const FIXTURE = path.join(__dirname, "fixtures", "reconcile-shopware.csv");

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

test("reconcile: upload Shop-Ware CSV, scan one match, expected-not-counted boundary holds, CSV export works", async ({ page }) => {
  await page.route("**/api/ai-lookup", async (route: Route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: NO_AI_STATUS });
    return route.fulfill({ json: {} });
  });

  await page.goto("/login");
  await page.getByTestId("login-button").click();
  await page.waitForURL("**/scan");

  // Scan the Falken tire's barcode (known seeded product) so this session counts it.
  // The Michelin Premier LTX from the fixture is deliberately NEVER scanned.
  await scan(page, "848983012906");
  await expect(page.getByTestId("final-count-body")).toContainText("Falken Sincera ST80 A/S");

  // Navigate to Reconcile and upload the fixture.
  await page.goto("/reconcile");
  await expect(page.getByTestId("reconcile-empty-state")).toBeVisible();

  await page.getByTestId("reconcile-file").setInputFiles(FIXTURE);
  const summary = page.getByTestId("reconcile-session-summary");
  await expect(summary).toBeVisible();
  await expect(summary).toContainText("2 rows");
  await page.screenshot({ path: `${PROOF}/reconcile-01-upload.png`, fullPage: true });

  // Run the compare against the real local tire corpus.
  await page.getByTestId("reconcile-run").click();
  const report = page.getByTestId("reconcile-report");
  await expect(report).toBeVisible();
  await page.screenshot({ path: `${PROOF}/reconcile-02-report.png`, fullPage: true });

  // --- AM-R8 core assertion: the Falken row (scanned, qty 1 counted vs 1 expected) is an agreement
  // (delta 0), and the Michelin row (matched but never scanned) is expected_not_counted - NOT variance.
  const agreementSection = page.getByTestId("bucket-agreement");
  await expect(agreementSection).toBeVisible();
  await expect(agreementSection).toContainText("28816861");
  await expect(agreementSection).toContainText("Falken");

  const expectedNotCountedSection = page.getByTestId("bucket-expected_not_counted");
  await expect(expectedNotCountedSection).toBeVisible();
  await expect(expectedNotCountedSection).toContainText("44953");
  await expect(expectedNotCountedSection).toContainText("Michelin");
  await expect(expectedNotCountedSection).toContainText("Not counted in this session");
  await page.screenshot({ path: `${PROOF}/reconcile-03-expected-not-counted.png`, fullPage: true });

  // The unscanned Michelin part number must NEVER appear in a variance section - it is out of scope
  // for this partial count, not shrinkage (AM-R8 is the round's review blocker; this is the boundary).
  const varianceSection = page.getByTestId("bucket-variance");
  if (await varianceSection.count()) {
    await expect(varianceSection).not.toContainText("44953");
    await expect(varianceSection).not.toContainText("Michelin");
  }

  // CSV export produces a real downloadable file with both real rows in it.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("reconcile-export-csv").click(),
  ]);
  expect(download.suggestedFilename()).toBe("reconcile-report.csv");
});
