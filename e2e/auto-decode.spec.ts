import { test, expect, type Page, type Route } from "@playwright/test";

// Proves Aggressive Auto Decode Mode: with AI on and (mocked) keys configured, an unknown scan
// AUTOMATICALLY runs the live decode pipeline - the feed shows Decoding then the final decode
// status, never stopping at passive "Unknown". All provider traffic is mocked via page.route
// (and the webServer runs IS_E2E=1), so no live tokens are spent.

const PROOF = "e2e/proof";

const STATUS = {
  liveEnabled: true,
  autoDecodeOnScan: true,
  geminiEnabled: true,
  openaiEnabled: true,
  geminiConfigured: true,
  openaiConfigured: true,
  premiumFallback: true,
  mode: "aggressive",
  dailyLimit: 100,
  missingKeys: [],
  e2e: true,
};

function result(over: Record<string, unknown>) {
  return {
    productName: "", brand: "", category: "", specsShort: "", specsFull: "", primarySku: "",
    primaryBarcode: "", gtin: "", upc: "", ean: "", aliases: [], imageUrl: "", productUrl: "",
    sourceUrls: [], verifiedFacts: [], guesses: [], confidence: 0.95, needsHumanReview: false, ...over,
  };
}

const DECODE: Record<string, object> = {
  "878106003504": {
    providerNames: ["gemini", "openai"], premiumUsed: false,
    results: [result({ productName: "Coca-Cola Classic", brand: "Coca-Cola", upc: "878106003504", sourceUrls: ["https://gs1.org/878106003504"] })],
    decision: { status: "verified", confidence: 0.97, reason: "Verified AI Decode: providers agree, code confirmed in a snippet.", evidenceStrength: "snippet", exactCodeEvidenceVerifiedByApp: true, crossCheck: { decision: "agree" } },
  },
  "111111111119": {
    providerNames: ["gemini", "openai"], premiumUsed: true,
    results: [result({ productName: "Maybe Energy Bar", brand: "Generic", upc: "111111111119" })],
    decision: { status: "suggested", confidence: 0.5, reason: "Suggested, not trusted. Evidence is weak.", evidenceStrength: "url_only", exactCodeEvidenceVerifiedByApp: false, crossCheck: { decision: "agree" } },
  },
  "222222222226": {
    providerNames: ["gemini", "openai"], premiumUsed: false,
    results: [result({ productName: "Creamer", brand: "Laird" }), result({ productName: "Receptacle", brand: "Leviton" })],
    decision: { status: "conflict", confidence: 0.2, reason: "Providers conflict on brand.", evidenceStrength: "snippet", exactCodeEvidenceVerifiedByApp: false, crossCheck: { decision: "conflict" } },
  },
};

async function scan(page: Page, code: string) {
  const input = page.getByTestId("scanner-input");
  await input.pressSequentially(code, { delay: 2 });
  await input.press("Enter");
}

test("aggressive auto-decode on scan (all mocked)", async ({ page }) => {
  let postHits = 0;
  await page.route("**/api/ai-lookup", async (route: Route) => {
    const req = route.request();
    if (req.method() === "GET") {
      await route.fulfill({ json: STATUS });
      return;
    }
    postHits++;
    const body = JSON.parse(req.postData() || "{}");
    await route.fulfill({ json: DECODE[body.cleanCode as string] ?? DECODE["111111111119"] });
  });

  await page.goto("/login");
  await page.getByTestId("login-button").click();
  await page.waitForURL("**/scan");

  // Enable AI; with mocked keys configured, auto decode turns On.
  await page.goto("/settings");
  await page.getByTestId("setting-ai-enabled").check();
  await page.goto("/scan");
  await expect(page.getByTestId("auto-decode-status")).toContainText("On");

  // Verified: unknown scan auto-decodes AND AUTO-ADDS the product to the count (no clicking).
  await scan(page, "878106003504");
  await expect(page.getByTestId("scan-feed-body")).toContainText("Verified AI Decode");
  await expect(page.getByTestId("final-count-body")).toContainText("Coca-Cola Classic"); // auto-added
  await expect(page.getByTestId("scanner-input")).toBeFocused(); // focus retained across async decode
  expect(postHits).toBeGreaterThan(0); // AI WAS called automatically

  // Suggested (usable product) -> TRUST THE AI: auto-added + counted, not a blank review.
  await scan(page, "111111111119");
  await expect(page.getByTestId("final-count-body")).toContainText("Maybe Energy Bar");

  // Conflict: providers disagree -> NOT auto-added, stays in Needs Review.
  await scan(page, "222222222226");
  await expect(page.getByTestId("scan-feed-body")).toContainText("Conflict");
  await expect(page.getByTestId("scanner-input")).toBeFocused();
  await page.screenshot({ path: `${PROOF}/auto-decode-01-feed.png`, fullPage: true });

  // Only the conflict is left in Needs Review (the suggested product was trusted + counted).
  await page.goto("/review");
  await expect(page.getByTestId("review-row-222222222226")).toBeVisible();
  await page.screenshot({ path: `${PROOF}/auto-decode-02-review.png`, fullPage: true });

  // Re-scan the auto-added code: deterministic Known, ZERO new AI calls.
  await page.goto("/scan");
  const before = postHits;
  await scan(page, "878106003504");
  expect(postHits).toBe(before);
  await page.screenshot({ path: `${PROOF}/auto-decode-03-deterministic.png`, fullPage: true });
});
