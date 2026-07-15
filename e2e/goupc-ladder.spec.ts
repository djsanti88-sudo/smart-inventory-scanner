import { test, expect, type Page, type Route } from "./fixtures";

// Task 17 (docs/superpowers/plans/2026-07-08-decode-ladder-goupc.md): E2E proof of the Go-UPC decode
// rung's user-visible behavior. All provider traffic is mocked via page.route on /api/ai-lookup (the
// Playwright webServer runs IS_E2E=1, and E2E mode never calls a live rung anyway - see
// src/app/api/ai-lookup/route.ts runGoUpc/runFetchV2 e2eMode() short-circuits). This spec proves the
// CONTRACT between the route's response shape (src/server/upc/GoUpcProvider.ts toResult/
// verifiedDecision/suggestionDecision) and the UI, not the live Go-UPC API.
//
// Uses the generic (non-tire) fixture so scanContext defaults to "any" (see e2e/fetchv2-count-contract.
// spec.ts) - the Go-UPC rung's auto-count gate (catalogAutoVerify.planAutoVerify) is codeType/scanContext
// agnostic; this keeps the tire-specific spec-completeness gate (hasCountableTireIdentity) out of scope.

const PROOF = "e2e/proof";

const AI_ON_STATUS = {
  liveEnabled: true,
  autoDecodeOnScan: true,
  geminiEnabled: true,
  openaiEnabled: true,
  geminiConfigured: true,
  openaiConfigured: true,
  premiumFallback: false,
  mode: "aggressive",
  dailyLimit: 200,
  missingKeys: [],
  e2e: true,
};

function emptyResult(over: Record<string, unknown> = {}) {
  return {
    productName: "", brand: "", category: "", specsShort: "", specsFull: "", primarySku: "",
    primaryBarcode: "", gtin: "", upc: "", ean: "", aliases: [], imageUrl: "", productUrl: "",
    sourceUrls: [], verifiedFacts: [], guesses: [], confidence: 0, needsHumanReview: true, ...over,
  };
}

// Mirrors GoUpcProvider.toResult() (exact hit): confidence 0.9, needsHumanReview false, verifiedFacts set.
function goUpcExactResult(code: string) {
  return emptyResult({
    productName: "Energizer MAX AA Batteries, 8 Pack",
    brand: "Energizer",
    category: "Batteries",
    specsShort: "8 Pack",
    specsFull: "8 Pack",
    primaryBarcode: code,
    gtin: code,
    upc: code,
    confidence: 0.9,
    verifiedFacts: ["Go-UPC exact barcode match"],
    needsHumanReview: false,
  });
}

// Mirrors GoUpcProvider.suggestResult() (inferred hit): confidence 0.4, needsHumanReview true, no verifiedFacts.
function goUpcInferredResult(code: string) {
  return emptyResult({
    productName: "Generic AA Battery Multipack",
    brand: "Energizer",
    category: "Batteries",
    primaryBarcode: code,
    gtin: code,
    upc: code,
    confidence: 0.4,
    needsHumanReview: true,
  });
}

// Mirrors GoUpcProvider.verifiedDecision().
const VERIFIED_DECISION = {
  status: "verified",
  confidence: 0.9,
  reason: "Verified from Go-UPC (exact barcode match).",
  evidenceStrength: "fetched_source",
  exactCodeEvidenceVerifiedByApp: true,
  crossCheck: {
    decision: "single_provider",
    confidence: 0.9,
    reason: "Go-UPC exact barcode.",
    brandSimilarity: 1,
    nameSimilarity: 1,
    contradictions: [],
  },
  corroborationPath: "single_source",
};

// Mirrors GoUpcProvider.suggestionDecision().
function suggestionDecision(reason: string) {
  return {
    status: "needs_review",
    confidence: 0.4,
    reason,
    evidenceStrength: "snippet",
    exactCodeEvidenceVerifiedByApp: false,
    crossCheck: {
      decision: "single_provider",
      confidence: 0.4,
      reason,
      brandSimilarity: 1,
      nameSimilarity: 1,
      contradictions: [],
    },
  };
}

// Route-level decode payload shape (matches route.ts's `payload` assembly for a settled Go-UPC rung).
function goUpcExactPayload(code: string) {
  return {
    mode: "decode",
    providerNames: ["go-upc"],
    results: [goUpcExactResult(code)],
    evidences: [{ verified: true, strength: "fetched_source", matchedCode: code, matchedSources: ["go-upc"], reason: "Go-UPC exact barcode match" }],
    providerStatuses: [{ provider: "go-upc", status: "ok", latencyMs: 12, sourceUrlsReturned: 0, exactCodeFound: true, identityFound: true }],
    decision: VERIFIED_DECISION,
    reasonCode: "ok",
    reasonText: "",
    timedOut: false,
    debug: { providersAttempted: ["go-upc"], evidenceStrengths: ["fetched_source"], sourceCounts: [0], ladderPath: "go-upc", aiCalled: false, pageFetched: false, cached: false },
    sanitizedInput: { rawCodeSanitized: code, cleanCodeSanitized: code },
  };
}

function goUpcInferredPayload(code: string) {
  const reason = "Go-UPC inferred match (not exact). Confirm before counting.";
  return {
    mode: "decode",
    providerNames: ["go-upc"],
    results: [goUpcInferredResult(code)],
    evidences: [{ verified: false, strength: "snippet", matchedCode: code, matchedSources: ["go-upc"], reason }],
    providerStatuses: [{ provider: "go-upc", status: "ok", latencyMs: 12, sourceUrlsReturned: 0, exactCodeFound: false, identityFound: true }],
    decision: suggestionDecision(reason),
    reasonCode: "needs_review",
    reasonText: reason,
    timedOut: false,
    debug: { providersAttempted: ["go-upc"], evidenceStrengths: ["snippet"], sourceCounts: [0], ladderPath: "go-upc", aiCalled: false, pageFetched: false, cached: false },
    sanitizedInput: { rawCodeSanitized: code, cleanCodeSanitized: code },
  };
}

// Cap-reached: Go-UPC rung returns "goupc_unavailable" (reason "Go-UPC monthly cap reached"), then every
// other rung also misses in this fixture, so the route's all-miss branch assembles allMissReason from the
// per-rung reasons list (route.ts: `No rung resolved the code. ${reasons.join("; ")}` and the review row
// renders `review.reason`, which the store sets verbatim from `decision.reason`).
function goUpcCapPayload(code: string) {
  const goUpcReason = "Go-UPC monthly cap reached";
  const allMissReason = `No rung resolved the code. go-upc: ${goUpcReason}; fetchv2: Fetch V2 skipped (E2E mock mode); gpt: gpt-5.5 skipped: no_api_key`;
  return {
    mode: "decode",
    providerNames: ["go-upc", "fetchv2", "gpt"],
    results: [],
    evidences: [],
    providerStatuses: [{ provider: "go-upc", status: "skipped", latencyMs: 0, sourceUrlsReturned: 0, exactCodeFound: false, identityFound: false, errorCode: goUpcReason }],
    decision: { status: "needs_review", confidence: 0, reason: allMissReason, evidenceStrength: "none", exactCodeEvidenceVerifiedByApp: false, crossCheck: { decision: "weak", confidence: 0, reason: "", brandSimilarity: 0, nameSimilarity: 0, contradictions: [] } },
    reasonCode: "no_result",
    reasonText: allMissReason,
    timedOut: false,
    debug: { providersAttempted: ["go-upc", "fetchv2", "gpt"], evidenceStrengths: [], sourceCounts: [], ladderPath: "none", aiCalled: false, pageFetched: false, cached: false },
    sanitizedInput: { rawCodeSanitized: code, cleanCodeSanitized: code },
  };
}

async function scan(page: Page, code: string) {
  const input = page.getByTestId("scanner-input");
  await input.click();
  await input.pressSequentially(code, { delay: 2 });
  await input.press("Enter");
}

test.describe("Go-UPC decode ladder (mocked)", () => {
  test("1. exact hit -> Verified AI Decode, auto-counts", async ({ page }) => {
    const code = "034000002702"; // checksum-valid UPC-A, no seeded alias
    await page.route("**/api/ai-lookup", async (route: Route) => {
      const req = route.request();
      if (req.method() === "GET") return route.fulfill({ json: AI_ON_STATUS });
      return route.fulfill({ json: goUpcExactPayload(code) });
    });

    await page.goto("/scan");
    const login = page.getByTestId("login-button");
    if (await login.isVisible().catch(() => false)) await login.click();
    await expect(page.getByTestId("scanner-input")).toBeVisible();

    await scan(page, code);

    // Feed row upgrades from "Decoding..." to "Verified match" (DecodeStatusBadge label for status "verified").
    await expect(page.getByTestId("scan-feed-body")).toContainText("Verified match", { timeout: 15_000 });
    // Auto-counted: the product shows up in the final counts table with no human click.
    await expect(page.getByTestId("final-count-body")).toContainText("Energizer MAX AA Batteries", { timeout: 15_000 });
    await expect(page.getByTestId("scanner-input")).toBeFocused();

    await page.screenshot({ path: `${PROOF}/goupc-exact-autocount.png`, fullPage: true });
  });

  test("2. inferred hit -> Needs Review suggestion with product attached", async ({ page }) => {
    const code = "034000002719"; // checksum-valid UPC-A, distinct from scenario 1
    await page.route("**/api/ai-lookup", async (route: Route) => {
      const req = route.request();
      if (req.method() === "GET") return route.fulfill({ json: AI_ON_STATUS });
      return route.fulfill({ json: goUpcInferredPayload(code) });
    });

    await page.goto("/scan");
    const login = page.getByTestId("login-button");
    if (await login.isVisible().catch(() => false)) await login.click();
    await expect(page.getByTestId("scanner-input")).toBeVisible();

    await scan(page, code);

    // Feed row settles to "Suggested" (DecodeStatusBadge collapses needs_review -> "Suggested").
    await expect(page.getByTestId("scan-feed-body")).toContainText("Suggested", { timeout: 15_000 });

    await page.goto("/review");
    const row = page.getByTestId(`review-row-${code}`);
    await expect(row).toBeVisible();
    // The suggested product name from the Go-UPC inferred result is attached to the review row.
    await expect(row).toContainText("Generic AA Battery Multipack");

    await page.screenshot({ path: `${PROOF}/goupc-inferred-suggest.png`, fullPage: true });
  });

  test("3. cap reached -> row reason contains 'Go-UPC monthly cap reached'", async ({ page }) => {
    const code = "034000002726"; // checksum-valid UPC-A, distinct from scenarios 1-2
    await page.route("**/api/ai-lookup", async (route: Route) => {
      const req = route.request();
      if (req.method() === "GET") return route.fulfill({ json: AI_ON_STATUS });
      return route.fulfill({ json: goUpcCapPayload(code) });
    });

    await page.goto("/scan");
    const login = page.getByTestId("login-button");
    if (await login.isVisible().catch(() => false)) await login.click();
    await expect(page.getByTestId("scanner-input")).toBeVisible();

    await scan(page, code);

    // The scan feed's Reason column surfaces decision.reason verbatim (scanStore: `reason: decision?.reason`).
    await expect(page.getByTestId("scan-feed-body")).toContainText("Go-UPC monthly cap reached", { timeout: 15_000 });

    await page.screenshot({ path: `${PROOF}/goupc-cap-reason.png`, fullPage: true });
  });

  test("4. all providers dead (500s) -> raw row persists in Needs Review after reload", async ({ page }) => {
    const code = "034000002733"; // checksum-valid UPC-A, distinct from scenarios 1-3
    await page.route("**/api/ai-lookup", async (route: Route) => {
      const req = route.request();
      if (req.method() === "GET") return route.fulfill({ json: AI_ON_STATUS });
      // Every provider is dead: the route itself fails. scanStore's decodeOnce() throws on !res.ok,
      // which the catch block turns into a COUNTED provisional "needs_review" row (count-first, HARD
      // RULE 0) - the scan is never lost even though decode totally failed.
      return route.fulfill({ status: 500, json: { error: "all providers down" } });
    });

    await page.goto("/scan");
    const login = page.getByTestId("login-button");
    if (await login.isVisible().catch(() => false)) await login.click();
    await expect(page.getByTestId("scanner-input")).toBeVisible();

    await scan(page, code);

    // Count-first: the raw scan row is counted (provisional) even though every rung failed.
    await expect(page.getByTestId("scan-feed-body")).toContainText(code, { timeout: 15_000 });
    await expect(page.getByTestId("scan-feed-body")).toContainText("Suggested", { timeout: 15_000 });

    // Reload the page: the row must SURVIVE (Zustand persist -> localStorage), proving durability, not
    // just in-memory state that a refresh would wipe.
    await page.reload();
    await expect(page.getByTestId("scanner-input")).toBeVisible();

    await page.goto("/review");
    const row = page.getByTestId(`review-row-${code}`);
    await expect(row).toBeVisible();

    await page.screenshot({ path: `${PROOF}/countfirst-survives.png`, fullPage: true });
  });
});
