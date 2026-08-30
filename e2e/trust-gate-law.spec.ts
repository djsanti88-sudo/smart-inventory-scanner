import { test, expect, type Page } from "./fixtures";

// Browser proof of the TOP-LEVEL LAW (owner order, 2026-07-15):
// EVERY scanned code - known, unknown, misread, random, undecodable, trust-gate-rejected - MUST
// immediately appear on the scan feed AND be counted in the session totals. Scan 10 = count 10,
// no exceptions. The barcode trust gate (src/products/barcodes/barcodeTrust.ts) only blanks a JUNK
// IDENTITY FIELD on a minted product (see scanStore.trustGate.store.test.ts) - it never blocks the
// scan from appearing or counting. This spec proves that invariant through the real browser UI,
// the way e2e/count-always.spec.ts proves the sibling "scan N = count N with AI off" law.

const NO_AI_STATUS = {
  liveEnabled: false, autoDecodeOnScan: false, openaiConfigured: false, mode: "off",
  dailyLimit: 200, missingKeys: ["OPENAI_API_KEY"], e2e: true,
};

async function scan(page: Page, code: string) {
  const input = page.getByTestId("scanner-input");
  await input.click();
  await input.pressSequentially(code, { delay: 2 });
  await input.press("Enter");
}

async function loginAndReachScan(page: Page) {
  await page.route("**/api/ai-lookup", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: NO_AI_STATUS });
    return route.fulfill({ json: {} }); // a POST must never fire on this no-key flow
  });
  await page.goto("/login");
  await page.getByTestId("login-button").click();
  await page.waitForURL("**/scan");
  await expect(page.getByTestId("scanner-input")).toBeFocused();
}

test("a random undecodable code appears on the feed and counts", async ({ page }) => {
  await loginAndReachScan(page);

  const RANDOM_CODE = "ZZRANDOM99X7Q"; // gibberish: not GTIN-shaped, not a known alias
  await scan(page, RANDOM_CODE);

  // Appears on the raw feed immediately.
  await expect(page.getByTestId("scan-feed-body").locator("tr")).toHaveCount(1);
  // Counted in the session totals - one final-count row with quantity 1.
  await expect(page.getByTestId("final-count-body").locator("tr")).toHaveCount(1);
  const qtyCell = page.getByTestId("final-count-body").locator("tr").first().locator("td").first();
  await expect(qtyCell).toHaveText("1");

  await page.screenshot({ path: "e2e/proof/trust-gate-law-random-code.png", fullPage: true });
});

test("a bad-check-digit GTIN appears and counts", async ({ page }) => {
  await loginAndReachScan(page);

  // Valid GTIN SHAPE (13 digits) but WRONG GS1 check digit - the barcode trust gate
  // (src/products/barcodes/barcodeTrust.ts gradeBarcode) grades this "rejected" (likely misread).
  // The gate only blanks a junk identity FIELD on a minted product; it must never suppress the
  // scan row or the count (see src/stores/scanStore.trustGate.store.test.ts).
  const BAD_CHECKDIGIT_GTIN = "8848111201762";
  await scan(page, BAD_CHECKDIGIT_GTIN);

  await expect(page.getByTestId("scan-feed-body").locator("tr")).toHaveCount(1);
  await expect(page.getByTestId("final-count-body").locator("tr")).toHaveCount(1);
  const qtyCell = page.getByTestId("final-count-body").locator("tr").first().locator("td").first();
  await expect(qtyCell).toHaveText("1");

  await page.screenshot({ path: "e2e/proof/trust-gate-law-bad-checkdigit.png", fullPage: true });
});

test("scan 10 = count 10", async ({ page }) => {
  await loginAndReachScan(page);

  const REPEATED_CODE = "697662129691"; // unknown, GTIN-shaped, valid check digit
  for (let i = 0; i < 10; i++) await scan(page, REPEATED_CODE);

  // Raw feed keeps every event: 10 rows for 10 scans of the same code.
  await expect(page.getByTestId("scan-feed-body").locator("tr")).toHaveCount(10);
  // Final counts group by product: one row, quantity 10.
  await expect(page.getByTestId("final-count-body").locator("tr")).toHaveCount(1);
  const qtyCell = page.getByTestId("final-count-body").locator("tr").first().locator("td").first();
  await expect(qtyCell).toHaveText("10");

  await page.screenshot({ path: "e2e/proof/trust-gate-law-scan10-count10.png", fullPage: true });
});
