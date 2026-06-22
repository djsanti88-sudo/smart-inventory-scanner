import { test, expect } from "@playwright/test";

// Phase 2 proof: a browser whose localStorage holds the POISONED v4 cache (many duplicate "Manstel rivet
// kit" products saved on the non-matching code 745125495781) must auto-purge to clean seed on next load,
// because the persist version was bumped (4 -> 5) and the migrate resets products/aliases to verified seed.
// After a fresh load the Products window shows the clean seed set with NO Manstel rows and no rivet count.

const PROOF = "e2e/proof";
const KEY = "sis-scan-v1";

function poisonedV4Cache() {
  const products = Array.from({ length: 30 }, (_, i) => ({
    id: `poison-${i}`, businessId: "demo-business", name: "Manstel 200 Pcs Aluminum Rivet Screw Kit", brand: "Manstel",
    category: "Hardware", specsShort: "", specsFull: "", primarySku: "", primaryBarcode: "745125495781", gtin: "",
    upc: "745125495781", ean: "", vendorCodes: [], aliases: ["745125495781"], imageUrl: "", productUrl: "", location: "",
    notes: "", status: "active", source: "ai_gemini", confidence: 0.9, verified: true, createdAt: "t", updatedAt: "t",
    createdBy: "ai", updatedBy: "ai",
  }));
  const finalCounts = [{ id: "pc-0", businessId: "demo-business", sessionId: "s", productId: "poison-0", quantity: 235,
    lastScannedAt: "t", aliasesSeen: ["745125495781"], scanEventIds: [], createdAt: "t", updatedAt: "t",
    syncStatus: "synced", syncError: null, appliedIdempotencyKeys: [] }];
  return JSON.stringify({ state: { products, finalCounts, settings: { businessId: "demo-business", scanContext: "any", aiLookupEnabled: false } }, version: 4 });
}

test("poisoned v4 cache auto-purges to clean seed on load (no Manstel rows)", async ({ page }) => {
  // Plant the corrupt cache BEFORE the app boots (runs on every navigation, before page scripts).
  await page.addInitScript(([key, val]) => { try { window.localStorage.setItem(key, val); } catch { /* ignore */ } }, [KEY, poisonedV4Cache()]);

  await page.goto("/login");
  await page.getByTestId("login-button").click();
  await page.waitForURL("**/scan");
  await page.goto("/products");

  const body = page.getByTestId("products-body");
  await expect(body).toBeVisible();
  // The 235 Manstel duplicates are GONE; the clean seed set remains (some rows present).
  await expect(body).not.toContainText(/manstel|rivet/i);
  expect(await body.locator("tr").count()).toBeGreaterThan(0);

  // And the rivet-kit count is gone from the scan page's Your counts.
  await page.goto("/scan");
  await expect(page.getByTestId("final-count-body")).not.toContainText(/manstel|rivet/i);
  await page.screenshot({ path: `${PROOF}/products-clean-after-purge.png`, fullPage: true });
});
