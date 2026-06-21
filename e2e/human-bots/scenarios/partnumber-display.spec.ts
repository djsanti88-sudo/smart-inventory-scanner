import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";

// PartNumberBot (Window 2 demo-readiness proof). Runs in CUSTOMER ("business") mode under the bots config
// (NEXT_PUBLIC_E2E_PLATFORM_OWNER is NOT set). Proves the customer sees the SKU (primarySku) AND the
// just-scanned BARCODE number in the Live Scan Feed (owner-restored), while the catalog barcode/alias
// DATABASE on the Products page stays hidden. Report-only; non-destructive.

const PROOF = "e2e/proof/demo-readiness";

// Nokian Outpost APT seed product: part number (primarySku) "T432119", barcode "6419440485331".
const NOKIAN_BARCODE = "6419440485331";
const NOKIAN_PART_NUMBER = "T432119";
const NOKIAN_NAME = "Nokian Outpost APT";

test("PartNumberBot: customer sees part number, not barcode (scan feed + products)", async ({ page }) => {
  mkdirSync(PROOF, { recursive: true });

  // 1. Scan a known product as a customer.
  await page.goto("/scan");
  const input = page.getByTestId("scanner-input");
  await input.click();
  await input.fill(NOKIAN_BARCODE);
  await input.press("Enter");

  const feed = page.getByTestId("scan-feed-body");
  await expect(feed).toContainText(NOKIAN_NAME);

  // 2. Part number (SKU) IS visible to the customer in the feed.
  await expect(feed).toContainText(NOKIAN_PART_NUMBER);

  // 3. The SCANNED barcode number IS now visible to the customer in the Live Scan Feed (owner-restored
  //    "Barcode" column). This is the code the customer just physically scanned - their own input, held
  //    in-memory only and never persisted - NOT the catalog/alias database.
  await expect(feed).toContainText(NOKIAN_BARCODE);

  await page.screenshot({ path: `${PROOF}/01-customer-scan-part-number.png`, fullPage: true });

  // 4. Products table: customer sees the "SKU" column, but the catalog barcode database stays HIDDEN
  //    (the products page must never expose the stored barcode/alias DB for every product).
  await page.goto("/products");
  const productsBody = page.getByTestId("products-body");
  await expect(productsBody).toContainText(NOKIAN_NAME);
  await expect(productsBody).toContainText(NOKIAN_PART_NUMBER);
  await expect(page.locator("body")).not.toContainText(NOKIAN_BARCODE);
  await page.screenshot({ path: `${PROOF}/02-customer-products-part-number.png`, fullPage: true });

  // 5. Mobile-width scan flow still shows the part number.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/scan");
  await page.getByTestId("scanner-input").click();
  await page.getByTestId("scanner-input").fill(NOKIAN_BARCODE);
  await page.getByTestId("scanner-input").press("Enter");
  await expect(page.getByTestId("scan-feed-body")).toContainText(NOKIAN_PART_NUMBER);
  await page.screenshot({ path: `${PROOF}/03-customer-mobile-part-number.png`, fullPage: true });
});
