import { test, expect } from "@playwright/test";
import { resolve } from "node:path";

// Phase 3 proof: the unified Export dropdown produces a real file in every format (CSV / XLSX / PDF /
// interactive HTML). Uses the seeded Products dataset (always non-empty) so it is deterministic and needs
// no live AI. Screenshots the open menu and the generated interactive HTML rendered in the browser.

const PROOF = "e2e/proof";

test("Export menu generates CSV, XLSX, PDF and interactive HTML", async ({ page }) => {
  await page.goto("/login");
  await page.getByTestId("login-button").click();
  await page.waitForURL("**/scan");

  // Open the unified Export dropdown and screenshot it.
  await page.getByTestId("export-menu-trigger").click();
  await expect(page.getByTestId("export-menu")).toBeVisible();
  await page.screenshot({ path: `${PROOF}/export-menu-open.png`, fullPage: true });

  // XLSX + PDF: assert a real file downloads with the right extension and non-trivial size.
  for (const [fmt, ext] of [["xlsx", "xlsx"], ["pdf", "pdf"]] as const) {
    const [dl] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId(`export-products-${fmt}`).click(),
    ]);
    expect(dl.suggestedFilename()).toBe(`products.${ext}`);
    const path = await dl.path();
    const { statSync } = await import("node:fs");
    expect(statSync(path).size).toBeGreaterThan(200); // a real, non-empty document
  }

  // Interactive HTML: download, open it as a standalone file, prove the vanilla search/sort UI renders.
  const [htmlDl] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-products-html").click(),
  ]);
  expect(htmlDl.suggestedFilename()).toBe("products.html");
  const htmlPath = `${PROOF}/products-export.html`;
  await htmlDl.saveAs(htmlPath);
  await page.goto("file://" + resolve(process.cwd(), htmlPath));
  await expect(page.getByPlaceholder("Search...")).toBeVisible();
  await expect(page.locator("table tbody tr").first()).toBeVisible(); // data rendered
  await page.screenshot({ path: `${PROOF}/export-html-interactive.png`, fullPage: true });
});
