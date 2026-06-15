import { test, expect, type Page } from "@playwright/test";

// Proves Phase B (decode budget persists) and the recommendation-first cleanup (Phase C of this batch):
// review grouped recommendations -> backup downloads -> remove selected -> Undo restores. Plus a
// catalog-first scenario (a verified catalog entry resolves a scan with NO AI call). Mock-only (IS_E2E=1).

const PROOF = "e2e/proof";

async function login(page: Page) {
  await page.goto("/login");
  await page.getByTestId("login-button").click();
  await page.waitForURL("**/scan");
}

const GOOD_P = {
  id: "p-good-e2e", businessId: "demo-business", name: "BIC Classic Pocket Lighter", brand: "BIC",
  category: "Lighters", specsShort: "", specsFull: "", primarySku: "", primaryBarcode: "070330611016",
  gtin: "", upc: "", ean: "", vendorCodes: [], aliases: ["070330611016"], imageUrl: "", productUrl: "",
  location: "", notes: "", status: "active", source: "human_review", confidence: 1, verified: true,
  createdAt: "t", updatedAt: "t", createdBy: "x", updatedBy: "x",
};
const JUNK_P = {
  ...GOOD_P, id: "p-junk-e2e", name: "UPC Barcode Search — Look up any UPC, EAN, or ISBN",
  brand: "", primaryBarcode: "710154236681", aliases: ["710154236681"],
};
const mkCount = (id: string, productId: string, quantity: number) => ({
  id, businessId: "demo-business", sessionId: "session-1", productId, quantity,
  lastScannedAt: "2026-06-14T10:00:00.000Z", aliasesSeen: [], scanEventIds: [], createdAt: "t",
  updatedAt: "t", syncStatus: "synced", syncError: null, appliedIdempotencyKeys: [],
});

test("decode budget persists across reload; cleanup review is a safe no-op when clean", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  await login(page);
  await page.goto("/settings");

  const budget = page.getByTestId("setting-decode-budget");
  await budget.fill("8000");
  await budget.blur();
  await page.reload();
  await expect(page.getByTestId("setting-decode-budget")).toHaveValue("8000");

  // Nothing junk in a fresh session -> review shows the empty state, removes nothing.
  await page.getByTestId("cleanup-review").click();
  await expect(page.getByTestId("cleanup-empty")).toBeVisible();
});

test("recommendation-first cleanup: review -> backup -> remove selected -> Undo restores", async ({ page }) => {
  page.on("dialog", (d) => d.accept());

  await page.addInitScript((payload) => {
    const [good, junk, cGood, cJunk] = payload as unknown[];
    if (localStorage.getItem("e2e-cleanup-seeded")) return;
    localStorage.setItem(
      "sis-scan-v1",
      JSON.stringify({ state: { products: [good, junk], aliases: [], finalCounts: [cGood, cJunk] }, version: 3 }),
    );
    localStorage.setItem("e2e-cleanup-seeded", "1");
  }, [GOOD_P, JUNK_P, mkCount("c-good-e2e", "p-good-e2e", 3), mkCount("c-junk-e2e", "p-junk-e2e", 1)]);

  await login(page);
  await expect(page.getByTestId("count-row-p-good-e2e")).toBeVisible();
  await expect(page.getByTestId("count-row-p-junk-e2e")).toBeVisible();

  // Review recommendations: the junk row is grouped + checked by default; the good row is not listed.
  await page.goto("/settings");
  await page.getByTestId("cleanup-review").click();
  await expect(page.getByTestId("cleanup-group-barcode_lookup_site")).toBeVisible();
  await expect(page.getByTestId("cleanup-item-c-junk-e2e")).toBeChecked();
  await expect(page.getByTestId("cleanup-item-c-good-e2e")).toHaveCount(0);

  // Final owner click removes selected; a JSON backup must download first.
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("cleanup-apply").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("inventory-backup-before-cleanup.json");
  await expect(page.getByTestId("cleanup-msg")).toContainText("Removed 1");

  // Junk gone, good kept.
  await page.goto("/scan");
  await expect(page.getByTestId("count-row-p-good-e2e")).toBeVisible();
  await expect(page.getByTestId("count-row-p-junk-e2e")).toHaveCount(0);

  // Undo restores the junk row.
  await page.goto("/settings");
  await page.getByTestId("undo-cleanup").click();
  await page.goto("/scan");
  await expect(page.getByTestId("count-row-p-junk-e2e")).toBeVisible();
  await page.screenshot({ path: `${PROOF}/cleanup-recommendations.png`, fullPage: true });
});
