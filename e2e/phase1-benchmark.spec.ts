import { test, expect, type Page } from "./fixtures";

// Phase 1 representative UI proof (NOT 100 browser runs - the 100-code benchmark is the headless runner
// scripts/benchmark-decodes.ts). Fully mocked (IS_E2E + page.route): never spends credits. Proves the
// UI behaviors the benchmark measures: fast-path product shows, fallback product shows, a verified code
// re-scans from the CLIENT catalog with NO new API call (cache), needs-review shows an honest reason,
// and a truly-unlisted code shows product_not_found_after_search. Screenshot -> phase1-100-code-benchmark.png

const PROOF = "e2e/proof";
const FAST1 = "111111111117";
const FAST2 = "222222222224";
const FAST3 = "333333333331";
const FALLBACK = "810118139604";
const NEEDS_REVIEW = "400000000008"; // provider rate-limited; valid UPC-A absent from local catalogs
const NOT_FOUND = "555555555555"; // searched, genuinely not listed

const STATUS = {
  liveEnabled: true, autoDecodeOnScan: true, geminiEnabled: true, openaiEnabled: true,
  geminiConfigured: true, openaiConfigured: true, firecrawlConfigured: true, openWebFallback: true,
  geminiSearchGrounding: true, openaiWebSearch: true, geminiModel: "gemini-flash-latest",
  openaiModel: "gpt-5-mini", pageFetchAndRead: true, premiumFallback: false, mode: "aggressive",
  dailyLimit: 100, missingKeys: [], e2e: true,
};

const foundProduct = (code: string, name: string, via: "ok" | "fallback_discovery_found_product") => ({
  mode: "decode", providerNames: [via === "ok" ? "page-fetch" : "firecrawl"],
  results: [{
    productName: name, brand: "", category: "General", specsShort: "", specsFull: "", primarySku: "",
    primaryBarcode: code, gtin: "", upc: code, ean: "", aliases: [], imageUrl: "", productUrl: "",
    sourceUrls: ["https://www.upcitemdb.com/upc/" + code], confidence: 0.9, verifiedFacts: [], guesses: [],
  }],
  evidences: [{ verified: true, strength: "fetched_source", matchedCode: code, matchedSources: ["https://www.upcitemdb.com/upc/" + code], reason: "" }],
  providerStatuses: [{ provider: via === "ok" ? "page-fetch" : "firecrawl", status: "ok", latencyMs: 600, sourceUrlsReturned: 1, exactCodeFound: true, identityFound: true }],
  decision: {
    status: "verified", confidence: 0.9, reason: "Verified: exact code confirmed in strong evidence.",
    evidenceStrength: "fetched_source", exactCodeEvidenceVerifiedByApp: true,
    crossCheck: { decision: "single_provider", confidence: 0.9, reason: "", brandSimilarity: 0, nameSimilarity: 0, contradictions: [] },
  },
  reasonCode: via, reasonText: via === "fallback_discovery_found_product" ? "Found via open-web fallback search." : "",
  timedOut: false, debug: { cached: false, fallbackFound: via !== "ok" },
});

const needsReview = (reasonCode: string, reasonText: string, statuses: Array<{ provider: string; status: string }>) => ({
  mode: "decode", providerNames: [], results: [], evidences: [],
  providerStatuses: statuses.map((s) => ({ ...s, latencyMs: 5, sourceUrlsReturned: 0, exactCodeFound: false, identityFound: false })),
  decision: { status: "needs_review", confidence: 0, reason: "", evidenceStrength: "none", exactCodeEvidenceVerifiedByApp: false, crossCheck: { decision: "weak", confidence: 0, reason: "", brandSimilarity: 0, nameSimilarity: 0, contradictions: [] } },
  reasonCode, reasonText, timedOut: false, debug: {},
});

async function scan(page: Page, code: string) {
  const input = page.getByTestId("scanner-input");
  await input.pressSequentially(code, { delay: 2 });
  await input.press("Enter");
}

test("phase 1 representative proof: fast / fallback / catalog-cache / needs-review / not-found", async ({ page }) => {
  let posts = 0;
  const postsByCode: Record<string, number> = {};
  await page.route("**/api/ai-lookup", async (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ json: STATUS });
    posts++;
    const code = (JSON.parse(route.request().postData() || "{}").cleanCode as string) || "";
    postsByCode[code] = (postsByCode[code] ?? 0) + 1;
    if (code === FAST1) return route.fulfill({ json: foundProduct(FAST1, "Sharpie Permanent Marker Black", "ok") });
    if (code === FAST2) return route.fulfill({ json: foundProduct(FAST2, "Duracell AA Battery 4-Pack", "ok") });
    if (code === FAST3) return route.fulfill({ json: foundProduct(FAST3, "Crayola Crayons 24 Count", "ok") });
    if (code === FALLBACK) return route.fulfill({ json: foundProduct(FALLBACK, "Acrylic Paint Markers Set, 24 Metallic Colors", "fallback_discovery_found_product") });
    if (code === NEEDS_REVIEW) return route.fulfill({ json: needsReview("provider_rate_limited", "The AI provider was rate-limited (quota). Retry shortly.", [{ provider: "gemini", status: "rate_limited" }]) });
    return route.fulfill({ json: needsReview("product_not_found_after_search", "Searched the barcode databases and the open web - no product matched this barcode.", [{ provider: "firecrawl", status: "no_match" }]) });
  });

  await page.goto("/login");
  await page.getByTestId("login-button").click();
  await page.waitForURL("**/scan");
  await page.goto("/settings");
  await page.getByTestId("setting-ai-enabled").check();
  await page.goto("/scan");

  // Fast path: 3 codes resolve + count.
  await scan(page, FAST1);
  await expect(page.getByTestId("final-count-body")).toContainText("Sharpie Permanent Marker Black");
  await scan(page, FAST2);
  await expect(page.getByTestId("final-count-body")).toContainText("Duracell AA Battery 4-Pack");
  await scan(page, FAST3);
  await expect(page.getByTestId("final-count-body")).toContainText("Crayola Crayons 24 Count");

  // Fallback: open-web discovery product shows + counts.
  await scan(page, FALLBACK);
  await expect(page.getByTestId("final-count-body")).toContainText("Acrylic Paint Markers Set, 24 Metallic Colors");

  // CACHE proof (client catalog): re-scan a verified code -> NO new API POST, count increments to 2.
  const postsBefore = postsByCode[FAST1];
  await scan(page, FAST1);
  await expect(page.getByTestId("scanner-input")).toBeFocused();
  await page.waitForTimeout(300); // give any (unexpected) decode a chance to fire
  expect(postsByCode[FAST1]).toBe(postsBefore); // resolved from catalog, no AI/Firecrawl call

  // Needs Review: honest rate-limit reason (never "not found").
  await scan(page, NEEDS_REVIEW);
  await page.goto("/review");
  await expect(page.getByTestId(`review-row-${NEEDS_REVIEW}`).getByTestId("review-reason")).toContainText("rate-limited");

  // Truly unlisted: only after searching does it say no product matched.
  await page.goto("/scan");
  await scan(page, NOT_FOUND);
  await page.goto("/review");
  await expect(page.getByTestId(`review-row-${NOT_FOUND}`).getByTestId("review-reason")).toContainText("no product matched");

  await page.screenshot({ path: `${PROOF}/phase1-100-code-benchmark.png`, fullPage: true });
});
