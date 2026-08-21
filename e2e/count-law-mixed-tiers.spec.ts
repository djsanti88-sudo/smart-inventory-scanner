import { test, expect, type Page, type Route } from "./fixtures";

// TOP-LEVEL LAW at scale, mixed tiers (coverage gap #1, docs/superpowers/reports/2026-08-13-e2e-coverage-map.md
// item B). Every existing law spec proves the invariant with 1-2 tiers and <=20 codes
// (count-always.spec.ts, trust-gate-law.spec.ts, and gpt-decode-burst.spec.ts).
// This spec scans 60+ codes across EVERY resolution tier in one session and asserts:
//   1. feed row count == number of physical scans (every scan APPEARS)
//   2. sum of all final-count quantities == number of physical scans (every scan COUNTS)
//   3. no scanned code is missing from the feed/counts, including junk and gate-rejected ones
//   4. duplicate scans of the SAME code increment quantity on ONE row, never create a second row
//   5. rows carry the correct tier label/status (a suggestion is never shown as verified)
//
// AI is fully mocked via page.route on /api/ai-lookup (IS_E2E=1 webServer backstop too) - zero live
// provider calls. Phase A (deterministic tiers, AI off client-side) runs first, then Settings enables
// AI and Phase B (AI-decode tiers) runs with a per-code mocked decision, mirroring decode.spec.ts /
// auto-decode.spec.ts / suggested-decode.spec.ts's proven response shapes so client-side label mapping
// is exercised exactly as those specs already prove it, not re-derived here.

const PROOF = "e2e/proof/count-law-mixed-tiers";

// ---------------------------------------------------------------------------------------------
// Code generation helpers
// ---------------------------------------------------------------------------------------------

// GS1 check digit (mod-10, weights 3/1 from the right) - identical algorithm to gpt-decode-burst.spec.ts.
function gs1CheckDigit(payload: string): string {
  const d = payload.split("").map(Number);
  let sum = 0;
  for (let i = d.length - 1, w = 3; i >= 0; i--, w = 4 - w) sum += d[i] * w;
  return String((10 - (sum % 10)) % 10);
}
// Valid 12-digit UPC-A from an 11-digit payload prefix + index.
function validUpc(prefix: string, i: number): string {
  const payload = `${prefix}${String(i).padStart(11 - prefix.length, "0")}`;
  return payload + gs1CheckDigit(payload);
}
// A GTIN-shaped code with a deliberately WRONG check digit (the barcode trust gate's misread
// detector rejects it; it must still appear on the feed and count - trust-gate-law.spec.ts proves
// the single-code case, this proves it holds at scale mixed with everything else).
function badCheckDigit(prefix: string, i: number): string {
  const payload = `${prefix}${String(i).padStart(12 - prefix.length, "0")}`;
  const correct = Number(gs1CheckDigit(payload));
  const wrong = (correct + 1) % 10;
  return payload + String(wrong);
}

// ---------------------------------------------------------------------------------------------
// Phase A: deterministic tiers (AI off). Seed catalog identifiers come from src/seed/seedData.ts.
// ---------------------------------------------------------------------------------------------

// A1: approved-alias hits - secondary/messy alias codes for 5 different seeded products.
const ALIAS_CODES = ["T432119%RU1%", "2881-6861", "7262", "VWP-VAN-2LB", "DCF887B"];
// A2: verified-product identifier hits - PRIMARY identifiers, varying field (barcode/gtin/sku/upc).
const IDENTIFIER_CODES = ["6419440485331", "848983012906", "28816861", "049000028904", "850012345678", "885911484047"];
// A8: totally unknown codes - valid GTIN shape, valid check digit, not in any catalog.
const UNKNOWN_CODES = Array.from({ length: 5 }, (_, i) => validUpc("9010000", i));
// Junk/garbage: not GTIN-shaped at all, gibberish.
const JUNK_CODES = ["ZZRANDOM99X7Q", "QQGIBBERISH42", "NOTAREALCODE9", "XJUNK000FAKE1"];
// Gate-rejected: GTIN-shaped but a bad GS1 check digit (barcode trust gate / misread detector).
const GATE_REJECTED_CODES = Array.from({ length: 3 }, (_, i) => badCheckDigit("884811", i));

// ---------------------------------------------------------------------------------------------
// Phase B: AI-decode tiers (AI on, mocked). Shapes copied from the already-proven specs so the
// client-side label mapping is exercised identically to those (decode.spec.ts, auto-decode.spec.ts,
// suggested-decode.spec.ts) rather than re-derived here.
// ---------------------------------------------------------------------------------------------

const CORPUS_CODES = Array.from({ length: 5 }, (_, i) => validUpc("9020000", i));
const AI_VERIFIED_CODES = Array.from({ length: 5 }, (_, i) => validUpc("9030000", i));
const SUGGESTED_HIGH_CODES = Array.from({ length: 5 }, (_, i) => validUpc("9040000", i));
const SUGGESTED_LOW_CODES = Array.from({ length: 5 }, (_, i) => validUpc("9050000", i));
const CONFLICT_CODES = Array.from({ length: 5 }, (_, i) => validUpc("9060000", i));
// A7: vendor_label / FNSKU / ASIN shapes - 10 uppercase alnum starting X0/B0 (codeTypeDetector.ts).
const VENDOR_LABEL_CODES = ["X004DY7YUT", "X005KP2MNQ", "X006TT4RST", "B001AAWXYZ", "B002QQ7ABC"];

function baseResult(over: Record<string, unknown>) {
  return {
    productName: "", brand: "", category: "", specsShort: "", specsFull: "", primarySku: "",
    primaryBarcode: "", gtin: "", upc: "", ean: "", aliases: [], imageUrl: "", productUrl: "",
    sourceUrls: [], verifiedFacts: [], guesses: [], confidence: 0.95, needsHumanReview: false, ...over,
  };
}

const RESPONSES: Record<string, object> = {};

// A3: corpus/catalog hit - single-source app-verified evidence, same shape as the proven
// auto-decode.spec.ts verified fixture (exactCodeEvidenceVerifiedByApp true -> "Verified (app-confirmed)").
CORPUS_CODES.forEach((code, i) => {
  RESPONSES[code] = {
    providerNames: ["local-corpus"],
    results: [baseResult({ productName: `Corpus Match ${i}`, brand: "CorpusBrand", upc: code, sourceUrls: [`https://gs1.org/${code}`] })],
    decision: {
      status: "verified", confidence: 0.96,
      reason: "Verified: matched local product corpus.", evidenceStrength: "snippet",
      exactCodeEvidenceVerifiedByApp: true, crossCheck: { decision: "agree" },
    },
  };
});

// A5: AI-verified auto-count - two providers agree, app-confirmed exact evidence.
AI_VERIFIED_CODES.forEach((code, i) => {
  RESPONSES[code] = {
    providerNames: ["gpt-5.4-mini"],
    results: [baseResult({ productName: `AI Verified Item ${i}`, brand: "VerifiedBrand", upc: code, sourceUrls: [`https://gs1.org/${code}`] })],
    decision: {
      status: "verified", confidence: 0.97,
      reason: "Verified AI Decode: providers agree and the app confirmed the exact code in a snippet.",
      evidenceStrength: "snippet", exactCodeEvidenceVerifiedByApp: true, crossCheck: { decision: "agree" },
    },
  };
});

// A4-high: suggested, confidence >= 0.8 -> auto-applies with the confidence band + one-tap Approve, review auto-closes.
SUGGESTED_HIGH_CODES.forEach((code, i) => {
  RESPONSES[code] = {
    providerNames: ["gpt-5.4-mini"],
    results: [baseResult({ productName: `High Suggested ${i}`, brand: "GuessBrand", upc: code, confidence: 0.85 })],
    decision: {
      status: "suggested", confidence: 0.85,
      reason: "Suggested, not trusted. Evidence is weak.", evidenceStrength: "url_only",
      exactCodeEvidenceVerifiedByApp: false, crossCheck: { decision: "agree" },
    },
  };
});

// A4-low: suggested, confidence < 0.8 -> counts immediately with the inline app-derived band tag,
// pointer-only approve/decline, no open Needs Review (Task 9b, owner-ratified 2026-07-14).
SUGGESTED_LOW_CODES.forEach((code, i) => {
  const conf = 0.3 + i * 0.05;
  RESPONSES[code] = {
    providerNames: ["gpt-5.4-mini"],
    results: [baseResult({ productName: `Low Suggested ${i}`, brand: "WeakBrand", confidence: conf })],
    decision: {
      status: "suggested", confidence: conf, reason: "Suggested", evidenceStrength: "none",
      exactCodeEvidenceVerifiedByApp: false, crossCheck: { decision: "single_provider" },
    },
  };
});

// A6: conflict - providers disagree -> label collapses to "Suggested" (Plan C Task 1), stays OPEN
// in Needs Review, still counts (TOP-LEVEL LAW).
CONFLICT_CODES.forEach((code, i) => {
  RESPONSES[code] = {
    providerNames: ["gpt-5.4-mini"],
    results: [
      baseResult({ productName: `Conflict Item A ${i}`, brand: "BrandA" }),
      baseResult({ productName: `Conflict Item B ${i}`, brand: "BrandB" }),
    ],
    decision: {
      status: "conflict", confidence: 0.2,
      reason: `Providers conflict: brand mismatch ${i}.`, evidenceStrength: "snippet",
      exactCodeEvidenceVerifiedByApp: false, crossCheck: { decision: "conflict" },
    },
  };
});

// A7: vendor_label/FNSKU/ASIN - never a public barcode, never "verified" (decode.spec.ts fixture shape).
VENDOR_LABEL_CODES.forEach((code) => {
  RESPONSES[code] = {
    providerNames: ["gpt-5.4-mini"],
    results: [baseResult({ productName: "Amazon FBA Label", brand: "Amazon", confidence: 0.3 })],
    decision: {
      status: "suggested", confidence: 0.3,
      reason: "Suggested, not trusted. Code type cannot be auto-verified (vendor/label/internal).",
      evidenceStrength: "snippet", exactCodeEvidenceVerifiedByApp: false, crossCheck: { decision: "agree" },
    },
  };
});

const AI_ON_STATUS = {
  liveEnabled: true, autoDecodeOnScan: true, openaiConfigured: true, mode: "aggressive",
  dailyLimit: 1000, missingKeys: [], e2e: true,
};
const NO_AI_STATUS = {
  liveEnabled: false, autoDecodeOnScan: false, openaiConfigured: false, mode: "off",
  dailyLimit: 1000, missingKeys: ["OPENAI_API_KEY"], e2e: true,
};

async function scan(page: Page, code: string) {
  const input = page.getByTestId("scanner-input");
  await input.click();
  await input.pressSequentially(code, { delay: 1 });
  await input.press("Enter");
}

async function scanN(page: Page, code: string, times: number) {
  for (let i = 0; i < times; i++) await scan(page, code);
}

test("mixed-tier count law: 60+ scans across every resolution tier, feed=N, total quantity=N", async ({ page }) => {
  test.setTimeout(180_000);
  let aiOn = false; // flips true once Settings enables AI (Phase B)
  let postHits = 0;
  await page.route("**/api/ai-lookup", async (route: Route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ json: aiOn ? AI_ON_STATUS : NO_AI_STATUS });
    }
    postHits += 1;
    const body = route.request().postDataJSON() as { cleanCode?: string };
    const resp = RESPONSES[body?.cleanCode ?? ""];
    if (!resp) return route.fulfill({ json: {} }); // defensive: never fail the route
    return route.fulfill({ json: resp });
  });

  await page.goto("/scan");
  const login = page.getByTestId("login-button");
  if (await login.isVisible().catch(() => false)) await login.click();
  await expect(page.getByTestId("scanner-input")).toBeVisible();

  // -------------------------------------------------------------------------------------------
  // PHASE A: deterministic tiers, AI off (client setting stays default-off; zero decode calls).
  // -------------------------------------------------------------------------------------------
  let expectedTotal = 0;

  // A1 approved-alias hits (5 distinct products via secondary alias codes) - 1 scan each.
  for (const code of ALIAS_CODES) { await scan(page, code); expectedTotal += 1; }

  // A2 verified-product identifier hits (barcode/gtin/sku/upc) - 1 scan each.
  for (const code of IDENTIFIER_CODES) { await scan(page, code); expectedTotal += 1; }

  // A8 totally unknown codes - 1 scan each, except the first which gets extra duplicate scans below.
  for (const code of UNKNOWN_CODES) { await scan(page, code); expectedTotal += 1; }

  // Junk/garbage codes - 1 scan each, except the first which gets extra duplicate scans below.
  for (const code of JUNK_CODES) { await scan(page, code); expectedTotal += 1; }

  // Gate-rejected (bad-check-digit GTIN) codes - never any duplicates for these.
  for (const code of GATE_REJECTED_CODES) { await scan(page, code); expectedTotal += 1; }

  // Duplicate scans of codes ALREADY scanned above: must increment quantity, never add a new row.
  await scanN(page, ALIAS_CODES[0], 2); expectedTotal += 2; // T432119%RU1% -> prod-nokian, now x3
  await scanN(page, IDENTIFIER_CODES[0], 2); expectedTotal += 2; // 6419440485331 -> prod-nokian, now x3
  await scanN(page, UNKNOWN_CODES[0], 3); expectedTotal += 3; // now x4
  await scanN(page, JUNK_CODES[0], 2); expectedTotal += 2; // now x3

  expect(postHits, "AI must never be called while auto-decode is off").toBe(0);

  await expect(page.getByTestId("scan-feed-body").locator("tr")).toHaveCount(expectedTotal);
  await page.screenshot({ path: `${PROOF}/01-phase-a-feed.png`, fullPage: true });

  // Duplicate-increment proof: BOTH duplicated codes above (an alias AND a primary identifier) point
  // to the SAME seeded product (prod-nokian) - one row, quantity 3+3=6, never two rows.
  await expect(page.getByTestId("qty-prod-nokian")).toHaveCount(1);
  await expect(page.getByTestId("qty-prod-nokian")).toHaveText("6");
  // The other 4 seeded products, touched by one alias code + one identifier code each (no dup): qty 2.
  await expect(page.getByTestId("qty-prod-falken")).toHaveText("3"); // 2881-6861 + 848983012906 + 28816861
  await expect(page.getByTestId("qty-prod-coke")).toHaveText("2");
  await expect(page.getByTestId("qty-prod-supplement")).toHaveText("2");
  await expect(page.getByTestId("qty-prod-tool")).toHaveText("2");

  // Duplicate-increment proof for an UNRESOLVED tier: one product row, quantity == scan count.
  const unknownRow = page.locator('[data-testid^="count-row-"]').filter({ hasText: UNKNOWN_CODES[0] });
  await expect(unknownRow).toHaveCount(1);
  await expect(unknownRow.locator('[data-testid^="qty-"]')).toHaveText("4");
  const junkRow = page.locator('[data-testid^="count-row-"]').filter({ hasText: JUNK_CODES[0] });
  await expect(junkRow).toHaveCount(1);
  await expect(junkRow.locator('[data-testid^="qty-"]')).toHaveText("3");

  // No scanned code is missing: junk and gate-rejected codes are visible on the page (feed/counts).
  const bodyTextA = await page.locator("body").innerText();
  for (const code of [...JUNK_CODES, ...GATE_REJECTED_CODES, ...UNKNOWN_CODES]) {
    expect(bodyTextA, `code ${code} must appear on the page`).toContain(code);
  }

  // -------------------------------------------------------------------------------------------
  // PHASE B: AI-decode tiers, AI enabled via Settings (mocked; zero live calls).
  // -------------------------------------------------------------------------------------------
  aiOn = true;
  await page.goto("/settings");
  await page.getByTestId("setting-ai-enabled").check();
  await page.goto("/scan");
  await expect(page.getByTestId("auto-decode-status")).toContainText("On");

  for (const code of CORPUS_CODES) { await scan(page, code); expectedTotal += 1; }
  for (const code of AI_VERIFIED_CODES) { await scan(page, code); expectedTotal += 1; }
  for (const code of SUGGESTED_HIGH_CODES) { await scan(page, code); expectedTotal += 1; }
  for (const code of SUGGESTED_LOW_CODES) { await scan(page, code); expectedTotal += 1; }
  for (const code of CONFLICT_CODES) { await scan(page, code); expectedTotal += 1; }
  for (const code of VENDOR_LABEL_CODES) { await scan(page, code); expectedTotal += 1; }

  // Duplicate scan of an AI-verified code: must increment the SAME row, not create a second one.
  await scanN(page, AI_VERIFIED_CODES[0], 2); expectedTotal += 2; // now x3

  // Wait for every decode to settle before reading final state (each fires + resolves quickly; the
  // mocked route has no artificial delay, so poll rather than assume synchronous completion).
  await expect(page.getByTestId("scan-feed-body")).toContainText("AI Verified Item 0", { timeout: 20_000 });
  await expect(page.getByTestId("scan-feed-body")).toContainText("Corpus Match 0", { timeout: 20_000 });
  await expect(page.getByTestId("scan-feed-body")).toContainText("High Suggested 0", { timeout: 20_000 });
  await expect(page.getByTestId("scan-feed-body")).toContainText("Low Suggested 0", { timeout: 20_000 });

  expect(postHits, "AI called exactly once per new decode-eligible scan").toBeGreaterThan(0);

  await expect(page.getByTestId("scan-feed-body").locator("tr")).toHaveCount(expectedTotal);
  await page.screenshot({ path: `${PROOF}/02-phase-b-feed.png`, fullPage: true });

  // THE CORE LAW: every physical scan across the whole session appears AND counts. Sum every
  // quantity cell in the final counts table (works across known + provisional + suggested rows,
  // since ensureProvisionalCount mints a counted row for every scan regardless of identity).
  const qtyTexts = await page.getByTestId("final-count-body").locator('[data-testid^="qty-"]').allTextContents();
  const totalCounted = qtyTexts.reduce((sum, t) => sum + (parseInt(t.trim(), 10) || 0), 0);
  expect(totalCounted, "sum of every final-count quantity must equal total physical scans").toBe(expectedTotal);
  await page.screenshot({ path: `${PROOF}/03-final-counts.png`, fullPage: true });

  // Duplicate-increment proof in Phase B: one row, quantity 3, never two rows for the same code.
  const aiVerifiedRow = page.locator('[data-testid^="count-row-"]').filter({ hasText: "AI Verified Item 0" });
  await expect(aiVerifiedRow).toHaveCount(1);
  await expect(aiVerifiedRow.locator('[data-testid^="qty-"]')).toHaveText("3");

  // -------------------------------------------------------------------------------------------
  // Tier-label correctness: a suggestion is never shown as verified.
  // -------------------------------------------------------------------------------------------
  const feed = page.getByTestId("scan-feed-body");
  // A3/A5 verified tiers show the honest app-confirmed label.
  await expect(feed).toContainText("Verified (app-confirmed)");
  // A4-high auto-applies with the app-derived confidence band + one-tap Approve (owner 2026-08-19,
  // PR #39: the auto-applied path carries the same band + Approve as the inline path; the old
  // neutral "unconfirmed" tag is retired). Never the raw provider percentage, never "Verified".
  const highRow = feed.locator("tr").filter({ hasText: "High Suggested 0" });
  await expect(highRow).toContainText("confidence)");
  await expect(highRow.locator('[data-testid^="approve-"]')).toBeVisible();
  await expect(highRow).not.toContainText("Verified");
  // A4-low shows the honest confidence-tagged inline suggestion, pointer-only controls.
  const lowRow = feed.locator("tr").filter({ hasText: "Low Suggested 0" });
  // Band label, never a raw provider percentage (owner 2026-08-19).
  await expect(lowRow.locator('[data-testid^="feed-suggestion-"]')).toContainText("(Suggested -");
  // A6 conflict collapses to the neutral "Suggested" label (Plan C), never "Verified".
  await expect(feed).toContainText("Suggested");

  // Needs Review: only the codes that stay OPEN after decode should route there. Conflict is the
  // established open-review tier (auto-decode.spec.ts). Verify it here at scale (all 5 conflicts).
  await page.goto("/review");
  for (const code of CONFLICT_CODES) {
    await expect(page.getByTestId(`review-row-${code}`), `conflict code ${code} must stay in Needs Review`).toBeVisible();
  }
  // The verified/corpus/high-suggested/low-suggested tiers must NOT leave an open review behind
  // (Plan C + Task 9b: suggestions auto-count and bypass the blocking queue; verified never blocks).
  for (const code of [...CORPUS_CODES, ...AI_VERIFIED_CODES, ...SUGGESTED_HIGH_CODES, ...SUGGESTED_LOW_CODES]) {
    await expect(page.getByTestId(`review-row-${code}`), `${code} must not leave an open review`).toHaveCount(0);
  }
  await page.screenshot({ path: `${PROOF}/04-needs-review.png`, fullPage: true });
});
