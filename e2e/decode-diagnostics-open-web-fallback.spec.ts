import { test, expect, type Page } from "@playwright/test";

// HOTFIX proof: decode diagnostics + open-web source discovery, without breaking the fast path.
// Fully mocked (IS_E2E + page.route) - never calls live Gemini/OpenAI/Firecrawl, never spends credits.
//
// Four scenarios from the approved plan:
//  1. Normal fast path  -> product shows, ONE POST (no extra fallback round-trips).
//  2. Faire-type fallback (810118139604) -> the open-web fallback FOUND the product; it shows + counts.
//  3. Provider rate-limit -> Needs Review shows an HONEST "rate-limited" reason, never "not found".
//  4. Truly unlisted -> Needs Review shows "no product matched", only after a search was attempted.

const PROOF = "e2e/proof";
const FAST = "036000291452"; // fast path, found on a barcode DB
const FALLBACK = "810118139604"; // the real Faire product that only the open-web fallback finds
const RATELIMIT = "222222222220"; // provider 429'd; nothing found
const UNLISTED = "333333333330"; // searched everywhere, genuinely not listed

const STATUS = {
  liveEnabled: true, autoDecodeOnScan: true, geminiEnabled: true, openaiEnabled: true,
  geminiConfigured: true, openaiConfigured: true, geminiSearchGrounding: true, openaiWebSearch: true,
  geminiModel: "gemini-flash-latest", openaiModel: "gpt-5-mini", pageFetchAndRead: true,
  premiumFallback: false, mode: "aggressive", dailyLimit: 100, missingKeys: [], e2e: true,
};

// A found product (app-confirmed exact evidence) -> auto-verifies, shows in the Final Count.
// `via` toggles the honest reason: "ok" (fast path) vs "fallback_discovery_found_product" (open web).
const foundProduct = (code: string, name: string, source: string, via: "ok" | "fallback_discovery_found_product") => ({
  mode: "decode", providerNames: ["gemini"],
  results: [{
    productName: name, brand: "", category: "General", specsShort: "", specsFull: "", primarySku: "",
    primaryBarcode: code, gtin: "", upc: code, ean: "", aliases: [], imageUrl: "", productUrl: "",
    sourceUrls: [source], confidence: 0.9, verifiedFacts: [], guesses: [],
  }],
  evidences: [{ verified: true, strength: "fetched_source", matchedCode: code, matchedSources: [source], reason: "" }],
  providerStatuses: [{ provider: "gemini", status: "ok", latencyMs: 800, sourceUrlsReturned: 1, exactCodeFound: true, identityFound: true }],
  decision: {
    status: "verified", confidence: 0.9, reason: "Verified: app confirmed the exact code in strong evidence.",
    evidenceStrength: "fetched_source", exactCodeEvidenceVerifiedByApp: true,
    crossCheck: { decision: "single_provider", confidence: 0.9, reason: "", brandSimilarity: 0, nameSimilarity: 0, contradictions: [] },
  },
  reasonCode: via, reasonText: via === "fallback_discovery_found_product" ? "Found via open-web fallback search." : "",
  timedOut: false, debug: {},
});

// No product, with an HONEST reason code + text (never the old generic "no provider returned a product").
const needsReview = (reasonCode: string, reasonText: string, statuses: Array<{ provider: string; status: string }>) => ({
  mode: "decode", providerNames: [], results: [], evidences: [],
  providerStatuses: statuses.map((s) => ({ ...s, latencyMs: 5, sourceUrlsReturned: 0, exactCodeFound: false, identityFound: false })),
  decision: {
    status: "needs_review", confidence: 0, reason: "",
    evidenceStrength: "none", exactCodeEvidenceVerifiedByApp: false,
    crossCheck: { decision: "weak", confidence: 0, reason: "", brandSimilarity: 0, nameSimilarity: 0, contradictions: [] },
  },
  reasonCode, reasonText, timedOut: false, debug: {},
});

async function scan(page: Page, code: string) {
  const input = page.getByTestId("scanner-input");
  await input.pressSequentially(code, { delay: 2 });
  await input.press("Enter");
}

test("decode diagnostics + open-web fallback: fast path intact, honest reasons, Faire product found", async ({ page }) => {
  let posts = 0;
  await page.route("**/api/ai-lookup", async (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ json: STATUS });
    posts++;
    const body = JSON.parse(route.request().postData() || "{}");
    const code = body.cleanCode || body.rawCode || "";
    if (code === FAST) return route.fulfill({ json: foundProduct(FAST, "Sharpie Permanent Marker Black", "https://www.upcitemdb.com/upc/" + FAST, "ok") });
    if (code === FALLBACK) return route.fulfill({ json: foundProduct(FALLBACK, "Acrylic Paint Markers Set, 24 Metallic Colors", "https://www.faire.com/product/p_uxqrb39cyu", "fallback_discovery_found_product") });
    if (code === RATELIMIT) return route.fulfill({ json: needsReview("provider_rate_limited", "The AI provider was rate-limited (quota). Retry shortly.", [{ provider: "gemini", status: "rate_limited" }]) });
    return route.fulfill({ json: needsReview("product_not_found_after_search", "Searched the barcode databases and the open web - no product matched this barcode.", [{ provider: "firecrawl", status: "no_match" }]) });
  });

  await page.goto("/login");
  await page.getByTestId("login-button").click();
  await page.waitForURL("**/scan");
  await page.goto("/settings");
  await page.getByTestId("setting-ai-enabled").check();
  await page.goto("/scan");

  // 1. FAST PATH: product shows + counts, exactly ONE POST (no extra fallback round-trips).
  await scan(page, FAST);
  await expect(page.getByTestId("final-count-body")).toContainText("Sharpie Permanent Marker Black");
  expect(posts).toBe(1);

  // 2. FAIRE-TYPE FALLBACK: the open-web fallback found the real product -> it shows + counts.
  await scan(page, FALLBACK);
  await expect(page.getByTestId("final-count-body")).toContainText("Acrylic Paint Markers Set, 24 Metallic Colors");
  expect(posts).toBe(2);
  await page.screenshot({ path: `${PROOF}/decode-diagnostics-open-web-fallback.png`, fullPage: true });

  // 3. RATE LIMIT: Needs Review with an HONEST reason - never "not found".
  await scan(page, RATELIMIT);
  await page.goto("/review");
  const rateRow = page.getByTestId(`review-row-${RATELIMIT}`);
  await expect(rateRow).toBeVisible();
  await expect(rateRow.getByTestId("review-reason")).toContainText("rate-limited");
  await expect(rateRow.getByTestId("review-reason")).not.toContainText("No provider returned a usable product");

  // 4. TRULY UNLISTED: only after a search was attempted does it say "no product matched".
  await page.goto("/scan");
  await scan(page, UNLISTED);
  await page.goto("/review");
  const unlistedRow = page.getByTestId(`review-row-${UNLISTED}`);
  await expect(unlistedRow).toBeVisible();
  await expect(unlistedRow.getByTestId("review-reason")).toContainText("no product matched");
});
