import { test, expect, type Page } from "./fixtures";

// Representative current-path UI proof. All route traffic is mocked under IS_E2E, so this test
// cannot call OpenAI. It covers free identities, a GPT suggestion, client-catalog replay, a provider
// failure, and a genuine no-match response.
const PROOF = "e2e/proof";
const FREE_1 = "111111111117";
const FREE_2 = "222222222224";
const FREE_3 = "333333333331";
const GPT = "810118139604";
const RATE_LIMITED = "444444444448";
const NOT_FOUND = "555555555555";

const STATUS = {
  liveEnabled: true,
  autoDecodeOnScan: true,
  openaiConfigured: true,
  freeDecodeAvailable: true,
  dailyLimit: 100,
  missingKeys: [],
  e2e: true,
  decodePath: ["tire_corpus", "retail_corpus", "learned_products", "master_catalog", "persisted_cache", "memory_cache", "gpt_5_4_mini"],
};

const product = (code: string, name: string, source: "retail-corpus" | "gpt-5.4-mini") => ({
  mode: "decode",
  providerNames: [source],
  results: [{
    productName: name, brand: "", category: "General", specsShort: "", specsFull: "", primarySku: "",
    primaryBarcode: code, gtin: "", upc: code, ean: "", aliases: [], imageUrl: "", productUrl: "",
    sourceUrls: [], confidence: 0.9, verifiedFacts: [], guesses: [],
  }],
  evidences: [],
  providerStatuses: [{ provider: source, status: "ok", latencyMs: 10, sourceUrlsReturned: 0, exactCodeFound: source === "retail-corpus", identityFound: true }],
  decision: {
    status: "suggested", confidence: 0.9, reason: "Suggested product. Review before confirming.",
    evidenceStrength: "none", exactCodeEvidenceVerifiedByApp: false,
    crossCheck: { decision: "single_provider", confidence: 0.9, reason: "", brandSimilarity: 0, nameSimilarity: 0, contradictions: [] },
  },
  reasonCode: source === "gpt-5.4-mini" ? "gpt_decode" : "ok",
  reasonText: "Suggested product. Review before confirming.",
  timedOut: false,
  debug: { cached: false, decodePath: source },
});

const miss = (reasonCode: string, reasonText: string, status: "rate_limited" | "no_match") => ({
  mode: "decode", providerNames: [], results: [], evidences: [],
  providerStatuses: [{ provider: "gpt-5.4-mini", status, latencyMs: 5, sourceUrlsReturned: 0, exactCodeFound: false, identityFound: false }],
  decision: { status: "needs_review", confidence: 0, reason: reasonText, evidenceStrength: "none", exactCodeEvidenceVerifiedByApp: false, crossCheck: { decision: "weak", confidence: 0, reason: "", brandSimilarity: 0, nameSimilarity: 0, contradictions: [] } },
  reasonCode, reasonText, timedOut: false, debug: {},
});

async function scan(page: Page, code: string) {
  const input = page.getByTestId("scanner-input");
  await input.pressSequentially(code, { delay: 2 });
  await input.press("Enter");
}

test("current decoder UI: free / GPT / catalog replay / rate-limit / not-found", async ({ page }) => {
  const postsByCode: Record<string, number> = {};
  await page.route("**/api/ai-lookup", async (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ json: STATUS });
    const code = (JSON.parse(route.request().postData() || "{}").cleanCode as string) || "";
    postsByCode[code] = (postsByCode[code] ?? 0) + 1;
    if (code === FREE_1) return route.fulfill({ json: product(code, "Sharpie Permanent Marker Black", "retail-corpus") });
    if (code === FREE_2) return route.fulfill({ json: product(code, "Duracell AA Battery 4-Pack", "retail-corpus") });
    if (code === FREE_3) return route.fulfill({ json: product(code, "Crayola Crayons 24 Count", "retail-corpus") });
    if (code === GPT) return route.fulfill({ json: product(code, "Acrylic Paint Markers Set, 24 Metallic Colors", "gpt-5.4-mini") });
    if (code === RATE_LIMITED) return route.fulfill({ json: miss("provider_rate_limited", "The product search was rate-limited. Retry shortly.", "rate_limited") });
    return route.fulfill({ json: miss("product_not_found_after_search", "No product matched this barcode.", "no_match") });
  });

  await page.goto("/login");
  await page.getByTestId("login-button").click();
  await page.waitForURL("**/scan");

  for (const [code, name] of [[FREE_1, "Sharpie Permanent Marker Black"], [FREE_2, "Duracell AA Battery 4-Pack"], [FREE_3, "Crayola Crayons 24 Count"], [GPT, "Acrylic Paint Markers Set, 24 Metallic Colors"]] as const) {
    await scan(page, code);
    await expect(page.getByTestId("final-count-body")).toContainText(name);
  }

  const postsBefore = postsByCode[FREE_1];
  await scan(page, FREE_1);
  await page.waitForTimeout(300);
  expect(postsByCode[FREE_1]).toBe(postsBefore);

  await scan(page, RATE_LIMITED);
  await page.goto("/review");
  await expect(page.getByTestId(`review-row-${RATE_LIMITED}`).getByTestId("review-reason")).toContainText("rate-limited");

  await page.goto("/scan");
  await scan(page, NOT_FOUND);
  await page.goto("/review");
  await expect(page.getByTestId(`review-row-${NOT_FOUND}`).getByTestId("review-reason")).toContainText("No product matched", { timeout: 20000 });
  await page.screenshot({ path: `${PROOF}/phase1-current-decode.png`, fullPage: true });
});
