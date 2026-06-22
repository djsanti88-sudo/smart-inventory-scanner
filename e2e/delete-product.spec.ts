import { test, expect } from "@playwright/test";

// Phase 1 proof (UI): a saved product can be deleted from the Products window with a plain-language
// confirm, the row disappears, an Undo banner appears, and Undo restores it. Runs as the platform owner
// (delete is platformOwner-gated). Screenshots the delete + the undo.

const PROOF = "e2e/proof";

test("delete a product from the UI, then Undo restores it", async ({ page }) => {
  page.on("dialog", (d) => d.accept()); // accept the plain-language confirm

  await page.goto("/login");
  await page.getByTestId("login-button").click();
  await page.waitForURL("**/scan");
  await page.goto("/products");

  const body = page.getByTestId("products-body");
  await expect(body).toBeVisible();
  const before = await body.locator('tr[data-testid^="product-row-"]').count();
  expect(before).toBeGreaterThan(0);

  // Delete the first product (capture its testid so we can assert it disappears).
  const firstDelete = page.locator('[data-testid^="delete-product-"]').first();
  const testid = await firstDelete.getAttribute("data-testid");
  const productId = (testid ?? "").replace("delete-product-", "");
  await firstDelete.click();

  // Row gone; Undo banner shown.
  await expect(page.getByTestId(`product-row-${productId}`)).toHaveCount(0);
  await expect(page.getByTestId("undo-delete-banner")).toBeVisible();
  expect(await body.locator('tr[data-testid^="product-row-"]').count()).toBe(before - 1);
  await page.screenshot({ path: `${PROOF}/delete-product-01-deleted.png`, fullPage: true });

  // Undo restores it exactly.
  await page.getByTestId("undo-delete").click();
  await expect(page.getByTestId(`product-row-${productId}`)).toBeVisible();
  expect(await body.locator('tr[data-testid^="product-row-"]').count()).toBe(before);
  await page.screenshot({ path: `${PROOF}/delete-product-02-undone.png`, fullPage: true });
});
