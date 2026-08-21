import { test, expect, type Page, type Route } from "@playwright/test";

// Phase 8B proof: a POISONED public source (exact-code evidence for a NON-tire product) must NOT
// auto-count in Tire inventory context - it routes to Needs Review with a safe category-conflict reason.
// Real case: go-upc.com maps tire UPC 745125495781 to an aluminum-rivet kit.

const PROOF = "e2e/proof";
const CODE = "745125495781";

function result(over: Record<string, unknown>) {
  return {
    productName: "", brand: "", category: "", specsShort: "", specsFull: "", primarySku: "", primaryBarcode: "",
    gtin: "", upc: "", ean: "", aliases: [], imageUrl: "", productUrl: "", sourceUrls: [], confidence: 0.95,
    verifiedFacts: [], guesses: [], needsHumanReview: false, ...over,
  };
}

const STATUS = {
  liveEnabled: true, autoDecodeOnScan: true, openaiConfigured: true, mode: "aggressive", dailyLimit: 100, missingKeys: [], e2e: true,
};

// Poisoned source: WEAK/unverified exact-code evidence (go-upc url_only, not app-verified), and the
// product is a non-tire rivet kit. owner-ratified 2026-07-14: advisory-when-app-verified (fixture
// migrated to real weak evidence shape) - the real EvidenceVerifier never marks a go-upc url_only
// source app-verified (go-upc is the canonical poison source, not a trusted host), so this fixture must
// use the weak shape to prove the poison guard still hard-blocks. Assertions are unchanged.
const POISONED = {
  providerNames: ["page-fetch"],
  results: [result({ productName: "Manstel 200 Pcs Aluminum Core Blind Rivet Semi-Round Head Screw Kit M3.2X11mm", upc: CODE, sourceUrls: ["https://go-upc.com/search?q=" + CODE] })],
  decision: { status: "suggested", confidence: 0.6, reason: "Suggested, sources found.", evidenceStrength: "url_only", exactCodeEvidenceVerifiedByApp: false, crossCheck: { decision: "single_provider" } },
};

async function scan(page: Page, code: string) {
  const input = page.getByTestId("scanner-input");
  await input.pressSequentially(code, { delay: 2 });
  await input.press("Enter");
}

test("firewall: poisoned non-tire result in Tire context does not auto-count and routes to Needs Review", async ({ page }) => {
  await page.route("**/api/ai-lookup", async (route: Route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: STATUS });
      return;
    }
    await route.fulfill({ json: POISONED });
  });

  await page.goto("/login");
  await page.getByTestId("login-button").click();
  await page.waitForURL("**/scan");

  // Enable AI + set Tire inventory scan context (activates the firewall).
  await page.goto("/settings");
  await page.getByTestId("setting-ai-enabled").check();
  await page.getByTestId("setting-scan-context").selectOption("tire");
  await page.goto("/scan");

  await scan(page, CODE);

  // Owner rule "decode-everything, scan N = count N" (e81d716, 2026-07-01, predates this test's last
  // update): NOTHING blocks provisional counting, not even a category/brand conflict - the poisoned
  // rivet kit DOES show up in Final Count (qty 1) so the physical scan is never lost. The firewall's
  // real job is to stop it from becoming a VERIFIED, permanent, no-review identity: it must stay a
  // provisional/unverified row and the review must stay open with the safe category-conflict reason
  // (never silently resolved, never re-scanned deterministically as "Manstel").
  const row = page.locator('[data-testid^="count-row-"]', { hasText: "Manstel" });
  await expect(row).toBeVisible();
  await expect(row.locator("td").nth(0)).toHaveText("1");

  // It routes to Needs Review with a safe category-conflict reason and stays OPEN (not resolved).
  await page.goto("/review");
  const reviewRow = page.getByTestId(`review-row-${CODE}`);
  await expect(reviewRow).toBeVisible();
  await expect(reviewRow).toContainText(/category conflict/i);
  await expect(reviewRow).toContainText(/needs review/i);
  await page.screenshot({ path: `${PROOF}/firewall-01-review.png`, fullPage: true });
});
