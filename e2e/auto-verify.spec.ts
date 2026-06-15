import { test, expect, type Page } from "@playwright/test";

// Proves the confidence-based auto-verify loop with MOCKED decode (no live AI):
//   strong evidence-backed scan -> auto-verifies + counts (no review) -> second scan resolves with
//   NO AI call -> a weak/no-evidence scan goes to Needs Review.

const PROOF = "e2e/proof";
const STRONG_CODE = "111222333444";
const WEAK_CODE = "999888777666";

const STATUS = {
  liveEnabled: true, autoDecodeOnScan: true, geminiEnabled: true, openaiEnabled: true,
  geminiConfigured: true, openaiConfigured: true, geminiSearchGrounding: true, openaiWebSearch: true,
  geminiModel: "gemini-flash-latest", openaiModel: "gpt-5-mini", pageFetchAndRead: true,
  premiumFallback: false, mode: "aggressive", dailyLimit: 100, missingKeys: [], e2e: true,
};

const strongResp = (code: string) => ({
  mode: "decode", providerNames: ["gemini", "openai"],
  results: [{
    productName: "BIC Classic Pocket Lighter", brand: "BIC", category: "Lighters", specsShort: "", specsFull: "",
    primarySku: "", primaryBarcode: code, gtin: "", upc: code, ean: "", aliases: [], imageUrl: "", productUrl: "",
    sourceUrls: ["https://www.amazon.com/dp/B0TEST"], confidence: 0.95, verifiedFacts: [], guesses: [],
  }],
  evidences: [{ verified: true, strength: "snippet", matchedCode: code, matchedSources: ["https://www.amazon.com/dp/B0TEST"], reason: "" }],
  decision: {
    status: "verified", confidence: 0.95, reason: "Verified AI Decode", evidenceStrength: "snippet",
    exactCodeEvidenceVerifiedByApp: true,
    crossCheck: { decision: "agree", confidence: 0.95, reason: "", brandSimilarity: 1, nameSimilarity: 1, contradictions: [] },
  },
  timedOut: false, debug: {},
});

// No usable product at all -> the genuinely-bad case that still goes to Needs Review.
const weakResp = () => ({
  mode: "decode", providerNames: ["gemini", "openai"],
  results: [{
    productName: "", brand: "", category: "", specsShort: "", specsFull: "", primarySku: "",
    primaryBarcode: "", gtin: "", upc: "", ean: "", aliases: [], imageUrl: "", productUrl: "",
    sourceUrls: [], confidence: 0.2, verifiedFacts: [], guesses: [],
  }],
  evidences: [],
  decision: {
    status: "needs_review", confidence: 0.2, reason: "No usable product", evidenceStrength: "none",
    exactCodeEvidenceVerifiedByApp: false,
    crossCheck: { decision: "single_provider", confidence: 0.2, reason: "", brandSimilarity: 0, nameSimilarity: 0, contradictions: [] },
  },
  timedOut: false, debug: {},
});

async function scan(page: Page, code: string) {
  const input = page.getByTestId("scanner-input");
  await input.pressSequentially(code, { delay: 2 });
  await input.press("Enter");
}

test("confidence-based auto-verify: strong auto-saves, 2nd scan no AI, weak -> review", async ({ page }) => {
  let decodePosts = 0;
  await page.route("**/api/ai-lookup", async (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ json: STATUS });
    decodePosts++;
    const body = JSON.parse(route.request().postData() || "{}");
    const code = body.cleanCode || body.rawCode || "";
    return route.fulfill({ json: code === WEAK_CODE ? weakResp() : strongResp(code) });
  });

  await page.goto("/login");
  await page.getByTestId("login-button").click();
  await page.waitForURL("**/scan");

  // Enable AI lookup (default off).
  await page.goto("/settings");
  await page.getByTestId("setting-ai-enabled").check();

  // Strong unknown scan -> auto-verifies + counts, NOT sent to review.
  await page.goto("/scan");
  await scan(page, STRONG_CODE);
  await expect(page.getByTestId("final-count-body")).toContainText("BIC Classic Pocket Lighter");
  expect(decodePosts).toBe(1); // exactly one decode call - no extra network

  // Second scan of the same barcode -> resolves with NO new AI call.
  const before = decodePosts;
  await scan(page, STRONG_CODE);
  await expect(page.getByTestId("scanner-input")).toBeFocused();
  expect(decodePosts).toBe(before); // no AI on the second scan

  // Weak / no-evidence scan -> Needs Review.
  await scan(page, WEAK_CODE);
  await page.goto("/review");
  await expect(page.getByTestId("review-body")).toContainText(WEAK_CODE);
  await page.screenshot({ path: `${PROOF}/auto-verify.png`, fullPage: true });
});
