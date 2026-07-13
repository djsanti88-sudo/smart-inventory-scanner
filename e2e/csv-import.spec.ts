import path from "node:path";
import { test, expect } from "./fixtures";

// Task 3.6 proof (E2E): the onboarding CSV import panel on /products. Uploads a fixture file with
// 2 valid rows + 2 bad rows (missing name, unparseable qty), verifies the preview table and error
// list render, confirms the import, and asserts the resulting summary. Screenshots to e2e/proof/.
//
// NOTE: Playwright compiles e2e specs as CommonJS (no "type": "module" in package.json), so
// __dirname is available natively here - do not use fileURLToPath(import.meta.url) in this
// project's e2e specs, it breaks Playwright's loader (import.meta is undefined under CJS compile).

const PROOF = "e2e/proof";
const FIXTURE = path.join(__dirname, "fixtures", "csv-import-onboarding.csv");

test("CSV import onboarding: preview, error list, explicit confirm, summary", async ({ page }) => {
  await page.goto("/login");
  await page.getByTestId("login-button").click();
  await page.waitForURL("**/scan");
  await page.goto("/products");

  const panel = page.getByTestId("csv-import-panel");
  await expect(panel).toBeVisible();

  // Upload the fixture (2 valid rows, 2 bad rows) via the hidden file input.
  await page.getByTestId("csv-import-file-input").setInputFiles(FIXTURE);

  // Preview table renders the valid rows before anything is imported.
  const preview = page.getByTestId("csv-import-preview");
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("Widget Deluxe");
  await expect(preview).toContainText("Gizmo Standard");

  // Error list renders both bad rows with line numbers + reasons.
  const errors = page.getByTestId("csv-import-errors");
  await expect(errors).toBeVisible();
  await expect(errors).toContainText("Line 4");
  await expect(errors).toContainText("Line 5");
  await page.screenshot({ path: `${PROOF}/csv-import-01-preview.png`, fullPage: true });

  // Confirm button shows the exact count of valid rows about to be applied, and import has NOT
  // happened yet (no summary shown).
  const confirm = page.getByTestId("csv-import-confirm");
  await expect(confirm).toHaveText("Import 2 products");
  await expect(page.getByTestId("csv-import-summary")).toHaveCount(0);

  // Confirm applies the import and shows the summary.
  await confirm.click();
  const summary = page.getByTestId("csv-import-summary");
  await expect(summary).toBeVisible();
  await expect(summary).toContainText("2");
  await page.screenshot({ path: `${PROOF}/csv-import-02-summary.png`, fullPage: true });
});
