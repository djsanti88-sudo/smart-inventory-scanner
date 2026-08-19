import { test, expect, type Page, type Route } from "./fixtures";

// Live-decode proof. The /api/ai-lookup route is fully intercepted with page.route, so NO live
// Gemini/OpenAI call is ever made (the Playwright webServer also runs with IS_E2E=1 as a backstop).
// We script verified / suggested / conflict / vendor-label responses and assert the trust UI.

const PROOF = "e2e/proof";

function result(over: Record<string, unknown>) {
  return {
    productName: "",
    brand: "",
    category: "",
    specsShort: "",
    specsFull: "",
    primarySku: "",
    primaryBarcode: "",
    gtin: "",
    upc: "",
    ean: "",
    aliases: [],
    imageUrl: "",
    productUrl: "",
    sourceUrls: [],
    verifiedFacts: [],
    guesses: [],
    confidence: 0.95,
    needsHumanReview: false,
    ...over,
  };
}

// Mocked decode responses keyed by scanned cleanCode.
const RESPONSES: Record<string, object> = {
  "049000111222": {
    providerNames: ["gemini", "openai"],
    results: [result({ productName: "Coca-Cola Classic", brand: "Coca-Cola", upc: "049000111222", sourceUrls: ["https://gs1.org/049000111222"] })],
    decision: {
      status: "verified",
      confidence: 0.97,
      reason: "Verified AI Decode: providers agree and the app confirmed the exact code in a snippet.",
      evidenceStrength: "snippet",
      exactCodeEvidenceVerifiedByApp: true,
      crossCheck: { decision: "agree", confidence: 0.95, reason: "agree", brandSimilarity: 1, nameSimilarity: 0.8, contradictions: [] },
    },
  },
  "049000999888": {
    providerNames: ["gemini", "openai"],
    results: [result({ productName: "Mystery Snack", brand: "Generic", upc: "049000999888" })],
    decision: {
      status: "suggested",
      confidence: 0.4,
      reason: "Suggested, not trusted. Evidence is weak (no exact code in a snippet).",
      evidenceStrength: "url_only",
      exactCodeEvidenceVerifiedByApp: false,
      crossCheck: { decision: "agree", confidence: 0.6, reason: "agree", brandSimilarity: 1, nameSimilarity: 0.5, contradictions: [] },
    },
  },
  "049000777666": {
    providerNames: ["gemini", "openai"],
    results: [result({ productName: "Creamer", brand: "Laird" }), result({ productName: "Receptacle", brand: "Leviton" })],
    decision: {
      status: "conflict",
      confidence: 0.2,
      reason: "Providers conflict: brand mismatch: Laird vs Leviton. Routed to human review.",
      evidenceStrength: "snippet",
      exactCodeEvidenceVerifiedByApp: false,
      crossCheck: { decision: "conflict", confidence: 0.2, reason: "conflict", brandSimilarity: 0, nameSimilarity: 0, contradictions: ["brand mismatch"] },
    },
  },
  X004DY7YUT: {
    providerNames: ["gemini", "openai"],
    results: [result({ productName: "Amazon FBA Label", brand: "Amazon", confidence: 0.95 })],
    decision: {
      status: "suggested",
      confidence: 0.3,
      reason: "Suggested, not trusted. Code type cannot be auto-verified (vendor/label/internal).",
      evidenceStrength: "snippet",
      exactCodeEvidenceVerifiedByApp: false,
      crossCheck: { decision: "agree", confidence: 0.6, reason: "agree", brandSimilarity: 1, nameSimilarity: 1, contradictions: [] },
    },
  },
};

async function scan(page: Page, code: string) {
  const input = page.getByTestId("scanner-input");
  await input.click();
  await input.pressSequentially(code, { delay: 2 });
  await input.press("Enter");
}

test("live decode: verified vs suggested vs conflict vs vendor label, all mocked, human approves", async ({
  page,
}) => {
  let aiRouteHits = 0;
  await page.route("**/api/ai-lookup", async (route: Route) => {
    // GET is the capability/status check (no keys in this test) - not an AI lookup, not counted.
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { liveEnabled: true, autoDecodeOnScan: true, geminiConfigured: false, openaiConfigured: false, missingKeys: ["GEMINI_API_KEY", "OPENAI_API_KEY"], mode: "aggressive", dailyLimit: 100 } });
      return;
    }
    aiRouteHits++;
    const body = JSON.parse(route.request().postData() || "{}");
    const resp = RESPONSES[body.cleanCode as string] ?? RESPONSES["049000999888"];
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(resp) });
  });

  await page.goto("/login");
  await page.getByTestId("login-button").click();
  await page.waitForURL("**/scan");

  page.on("dialog", (d) => d.accept());

  // Clear cache + enable AI on Settings (Clear Cache lives only here now). AI is suggestion-only.
  await page.goto("/settings");
  await page.getByTestId("clear-cache").click();
  await page.getByTestId("setting-ai-enabled").check();
  // This spec inspects the decode STATUS + manual approve flow, so turn auto-add OFF here.
  await page.getByTestId("setting-auto-add").uncheck();

  // Scan the four codes (all land in Needs Review deterministically; AI not called yet).
  await page.goto("/scan");
  for (const code of ["049000111222", "049000999888", "049000777666", "X004DY7YUT"]) await scan(page, code);
  expect(aiRouteHits).toBe(0); // scanning never calls AI

  await page.goto("/review");

  // Run live decode on each and check the trust status.
  const decodeOn = async (code: string) => {
    await page.getByTestId(`review-row-${code}`).getByTestId("live-decode").click();
  };

  await decodeOn("049000111222");
  await expect(page.getByTestId("review-row-049000111222").getByTestId("decode-status")).toHaveText(/Verified match/);
  // Verified, but NOT auto-counted (default), still open for approval.
  await expect(page.getByTestId("review-row-049000111222")).toContainText("Needs review");

  await decodeOn("049000999888");
  await expect(page.getByTestId("review-row-049000999888").getByTestId("decode-status")).toHaveText(/Suggested/);

  await decodeOn("049000777666");
  // Plan C, Task 1: providers-conflict is a non-blocking LABEL, collapsed into the single
  // "Suggested" state (no separate "Conflict" wall state on the decode-status badge).
  await expect(page.getByTestId("review-row-049000777666").getByTestId("decode-status")).toHaveText(/Suggested/);

  await decodeOn("X004DY7YUT");
  await expect(page.getByTestId("review-row-X004DY7YUT").getByTestId("decode-status")).not.toHaveText(/Verified/);

  await page.screenshot({ path: `${PROOF}/decode-01-statuses.png`, fullPage: true });

  // Human approves the verified decode -> creates a verified product + approved alias.
  await page.getByTestId("review-row-049000111222").getByTestId("approve-suggestion").click();
  // Owner rule (fc2188a, 2026-07-01, predates this test's last update): Needs Review hides items that
  // are already resolved AND synced, so the row disappears from the queue entirely instead of lingering
  // with a "Resolved" badge.
  await expect(page.getByTestId("review-row-049000111222")).toHaveCount(0);
  await page.screenshot({ path: `${PROOF}/decode-02-approved.png`, fullPage: true });

  // Re-scan the approved code: deterministic Known, and it triggers ZERO AI calls.
  const hitsBeforeRescan = aiRouteHits;
  await page.goto("/scan");
  await scan(page, "049000111222");
  await expect(page.getByTestId("final-count-body")).toContainText("Coca-Cola Classic");
  expect(aiRouteHits).toBe(hitsBeforeRescan); // no AI call on a known rescan
  await page.screenshot({ path: `${PROOF}/decode-03-deterministic.png`, fullPage: true });
});
