import { test, expect, type Page, type Locator } from "@playwright/test";
import { mkdirSync } from "node:fs";

// P4 (2026-06-22): elderly-readable daily controls. Every action control a customer touches in Needs
// Review ("Check these") and the Counts table must be at least 44px tall (Apple/Material minimum touch
// target). This bot scans an unknown (review actions) + a known code (count actions) as a customer and
// asserts each control's rendered height, plus captures screenshots.

const PROOF = "e2e/proof/daily-2026-06-22";

async function scan(page: Page, code: string) {
  const i = page.getByTestId("scanner-input");
  await i.click(); await i.fill(code); await i.press("Enter");
  await page.waitForTimeout(150);
}

async function expectTall(loc: Locator, label: string) {
  await expect(loc, `${label} should be visible`).toBeVisible();
  const box = await loc.boundingBox();
  expect(box, `${label} has a box`).not.toBeNull();
  expect(box!.height, `${label} must be >= 44px (got ${box!.height})`).toBeGreaterThanOrEqual(44);
}

test("CustomerReadableControlsBot: Needs Review + Counts controls are >= 44px (P4)", async ({ page }) => {
  mkdirSync(PROOF, { recursive: true });

  await page.goto("/scan");

  // Counts actions (scan a known TIRE seed -> a count row; default scanContext is "tire").
  await scan(page, "6419440485331"); // seed tire
  const countBody = page.getByTestId("final-count-body");
  await expect(countBody.getByRole("button", { name: "Correct" }).first()).toBeVisible();
  await expectTall(countBody.getByRole("button", { name: "Correct" }).first(), "Correct button");
  await expectTall(countBody.getByRole("button", { name: "Remove from count" }).first(), "Remove-from-count button");
  await page.screenshot({ path: `${PROOF}/08-counts-controls.png`, fullPage: true });

  // Needs Review actions (scan an unknown -> a review row).
  await scan(page, "555000111222");
  await page.goto("/review");
  const row = page.locator('[data-testid^="review-row-"]').first();
  await expect(row).toBeVisible();
  await expectTall(row.getByTestId("link-existing"), "Link button");
  await expectTall(row.getByTestId("open-create"), "Create new button");
  await expectTall(row.getByTestId("ignore-review"), "Ignore button");
  await expectTall(row.getByLabel("link to product"), "Link-to-product select");
  await page.screenshot({ path: `${PROOF}/07-review-controls.png`, fullPage: true });
});
