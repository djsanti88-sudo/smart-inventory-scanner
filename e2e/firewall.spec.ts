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
  liveEnabled: true, autoDecodeOnScan: true, geminiEnabled: true, openaiEnabled: true,
  geminiConfigured: true, openaiConfigured: true, firecrawlConfigured: false, openWebFallback: false,
  geminiSearchGrounding: true, openaiWebSearch: true, geminiModel: "gemini-flash-latest", openaiModel: "gpt-5-mini",
  geminiProModel: "gemini-2.5-pro", openaiProModel: "gpt-5", pageFetchAndRead: true, premiumFallback: false,
  mode: "aggressive", dailyLimit: 100, missingKeys: [], e2e: true,
};

// Poisoned source: VERIFIED exact-code evidence, but the product is a non-tire rivet kit.
const POISONED = {
  providerNames: ["page-fetch"],
  results: [result({ productName: "Manstel 200 Pcs Aluminum Core Blind Rivet Semi-Round Head Screw Kit M3.2X11mm", upc: CODE, sourceUrls: ["https://go-upc.com/search?q=" + CODE] })],
  decision: { status: "verified", confidence: 0.92, reason: "Verified AI Decode: single provider, exact code confirmed.", evidenceStrength: "fetched_source", exactCodeEvidenceVerifiedByApp: true, crossCheck: { decision: "single_provider" } },
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

  // The poisoned rivet kit must NOT increment Final Count.
  await expect(page.getByTestId("final-count-body")).not.toContainText("Manstel");
  await expect(page.getByTestId("final-count-body")).not.toContainText("Rivet");

  // It routes to Needs Review with a safe category-conflict reason.
  await page.goto("/review");
  const row = page.getByTestId(`review-row-${CODE}`);
  await expect(row).toBeVisible();
  await expect(row).toContainText(/category conflict/i);
  await page.screenshot({ path: `${PROOF}/firewall-01-review.png`, fullPage: true });
});
