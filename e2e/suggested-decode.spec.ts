import { test, expect, type Page, type Route } from "./fixtures";

// Task 10 (docs/superpowers/plans/2026-07-09-decode-ux-fixes.md, Step 2): browser proof for the
// suggested-decode UX end to end. A mocked decode response with confidence 0.92 (>= 0.8) and
// decision.status "suggested" must:
//   1. Show the suggested identity on the scan feed (not the "Unidentified item" placeholder).
//   2. Tag it with the neutral "unconfirmed" label (never the amber "(suggested)" tag, which is
//      reserved for confidence < 0.8 - see LiveScanFeed.tsx's suggestionTag logic).
//   3. Surface the scanned barcode in the new Barcode column on /review
//      ([data-testid="review-barcode"], NeedsReviewTable.tsx).
// All provider traffic is mocked via page.route; the Playwright webServer runs IS_E2E=1
// (mock-only), so no live Gemini/OpenAI calls are made.

const PROOF = "e2e/proof";

const STATUS = {
  liveEnabled: true,
  autoDecodeOnScan: true,
  geminiEnabled: true,
  openaiEnabled: true,
  geminiConfigured: true,
  openaiConfigured: true,
  premiumFallback: false,
  mode: "aggressive",
  dailyLimit: 100,
  missingKeys: [],
  e2e: true,
};

const CODE = "086699212016";
const SUGGESTED_NAME = "Michelin Defender LTX M/S 275/60R20";

function suggestedDecodeResponse(code: string) {
  return {
    mode: "decode",
    providerNames: ["gemini", "openai"],
    results: [
      {
        productName: SUGGESTED_NAME, brand: "Michelin", category: "tires",
        specsShort: "275/60R20", specsFull: "", primarySku: "", primaryBarcode: code,
        gtin: code, upc: code, ean: "", aliases: [], imageUrl: "", productUrl: "",
        sourceUrls: ["https://example.com/michelin-defender"], confidence: 0.92,
        verifiedFacts: [], guesses: [], needsHumanReview: true,
      },
    ],
    evidences: [
      { verified: false, strength: "url_only", matchedCode: code, matchedSources: ["https://example.com/michelin-defender"], reason: "URL not independently verified" },
    ],
    decision: {
      status: "suggested", confidence: 0.92, reason: "Suggested, not trusted. Evidence is weak.",
      evidenceStrength: "url_only", exactCodeEvidenceVerifiedByApp: false,
      crossCheck: { decision: "agree", confidence: 0.92, reason: "", brandSimilarity: 1, nameSimilarity: 1, contradictions: [] },
    },
    timedOut: false,
    debug: {},
  };
}

async function scan(page: Page, code: string) {
  const input = page.getByTestId("scanner-input");
  await input.click();
  await input.pressSequentially(code, { delay: 2 });
  await input.press("Enter");
}

test("suggested decode (confidence 0.92) shows identity + unconfirmed tag; review shows barcode column", async ({ page }) => {
  await page.route("**/api/ai-lookup", async (route: Route) => {
    const req = route.request();
    if (req.method() === "GET") return route.fulfill({ json: STATUS });
    return route.fulfill({ json: suggestedDecodeResponse(CODE) });
  });

  await page.goto("/login");
  await page.getByTestId("login-button").click();
  await page.waitForURL("**/scan");

  // Enable AI lookup (default off); with mocked keys configured, auto decode turns On.
  await page.goto("/settings");
  await page.getByTestId("setting-ai-enabled").check();
  await page.goto("/scan");
  await expect(page.getByTestId("auto-decode-status")).toContainText("On");

  await scan(page, CODE);

  // Feed row shows the suggested identity, not the "Unidentified item" placeholder, tagged
  // "unconfirmed" (neutral - confidence 0.92 >= 0.8), never the amber "(suggested)" tag.
  const feedRow = page.locator('[data-testid^="feed-product-"]').filter({ hasText: "Michelin Defender" });
  await expect(feedRow).toHaveCount(1);
  await expect(feedRow).toContainText(SUGGESTED_NAME);
  await expect(feedRow).toContainText("unconfirmed");
  await expect(feedRow).not.toContainText("(suggested)");
  await expect(page.getByTestId("scan-feed-body")).not.toContainText("Unidentified item");

  await page.screenshot({ path: `${PROOF}/suggested-decode.png`, fullPage: true });

  // Review page: the new Barcode column carries the scanned code.
  await page.goto("/review");
  const barcodeCell = page.getByTestId("review-barcode").filter({ hasText: CODE });
  await expect(barcodeCell).toHaveCount(1);
  await expect(barcodeCell).toContainText(CODE);
});
