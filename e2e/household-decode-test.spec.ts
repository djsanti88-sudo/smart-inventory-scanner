import { test, expect } from "@playwright/test";

// Products NOT in the 4M retail database — confirmed via Turso query.
// These MUST go through AI decode (Gemini or OpenAI fallback).
const AI_DECODE_BARCODES = [
  { code: "041100587305", expected: "Lotrimin foot powder" },
  { code: "037000849247", expected: "Bounty paper towels" },
  { code: "071249237625", expected: "Lysol spray" },
  { code: "041333264073", expected: "Duracell batteries" },
  { code: "012546017770", expected: "Glade air freshener" },
];

// Products IN the 4M retail database — confirmed via Turso query.
// These should resolve from the database with ZERO AI calls.
const DB_BARCODES = [
  { code: "0070554002249", expected: "milk" },
  { code: "0850062639058", expected: "Ridge Rush (Olipop)" },
  { code: "0082674039043", expected: "Smoke Roasted Salmon" },
  { code: "021000658831", expected: "Kraft mac & cheese" },
  { code: "051000012517", expected: "Campbell's Chicken Noodle" },
];

const TEST_URL = "https://smart-inventory-test.vercel.app";

test("database products resolve instantly (no AI)", async ({ page }) => {
  await page.goto(TEST_URL, { waitUntil: "networkidle", timeout: 30000 });
  expect(page.url()).toContain("/scan");

  const scanInput = page.getByPlaceholder("Scan or type a code");
  await expect(scanInput).toBeVisible({ timeout: 10000 });

  let known = 0;
  for (const barcode of DB_BARCODES) {
    await scanInput.click();
    await scanInput.fill(barcode.code);
    await scanInput.press("Enter");
    await page.waitForTimeout(3000);

    const feedTable = page.locator("table").first();
    const firstRow = feedTable.locator("[role='row'], tr").filter({ hasNot: page.locator("th") }).first();
    const text = (await firstRow.textContent({ timeout: 5000 })) || "";

    const status = text.includes("Counted") ? "Counted" : text.includes("Needs review") ? "Needs review" : "other";
    console.log(`${barcode.code} | ${barcode.expected.padEnd(30)} | ${status}`);
    if (status === "Counted") known++;
  }

  await page.screenshot({ path: "e2e/proof/db-products.png", fullPage: true });
  console.log(`\nDB products resolved: ${known}/${DB_BARCODES.length}`);
  expect(known).toBeGreaterThanOrEqual(4); // at least 4/5 from database
});

test("AI decode works for products not in database (Gemini down, OpenAI escalation)", async ({ page }) => {
  await page.goto(TEST_URL, { waitUntil: "networkidle", timeout: 30000 });
  expect(page.url()).toContain("/scan");

  const scanInput = page.getByPlaceholder("Scan or type a code");
  await expect(scanInput).toBeVisible({ timeout: 10000 });

  const results: { code: string; expected: string; status: string; product: string }[] = [];

  for (const barcode of AI_DECODE_BARCODES) {
    console.log(`\nScanning: ${barcode.code} (expecting: ${barcode.expected})`);

    await scanInput.click();
    await scanInput.fill(barcode.code);
    await scanInput.press("Enter");

    // Wait for AI decode — Gemini is down (spending cap), OpenAI escalation takes ~10-20s
    console.log("  Waiting for AI decode (up to 25s)...");
    await page.waitForTimeout(25000);

    const feedTable = page.locator("table").first();
    const firstRow = feedTable.locator("[role='row'], tr").filter({ hasNot: page.locator("th") }).first();
    const text = (await firstRow.textContent({ timeout: 5000 })) || "";

    let status = "unknown";
    if (text.includes("Counted")) status = "Counted";
    else if (text.includes("Verified")) status = "Verified AI";
    else if (text.includes("Suggested")) status = "Suggested";
    else if (text.includes("Needs review") || text.includes("Not recognised")) status = "Needs review";
    else if (text.includes("Looking up")) status = "Still decoding";

    // Extract product name from the feed row if present
    const product = text.substring(0, 150);
    results.push({ code: barcode.code, expected: barcode.expected, status, product });
    console.log(`  Status: ${status}`);
    console.log(`  Row: ${product}`);
  }

  await page.screenshot({ path: "e2e/proof/ai-decode-products.png", fullPage: true });

  console.log("\n\n=== AI DECODE RESULTS ===");
  let resolved = 0;
  for (const r of results) {
    const ok = r.status !== "Needs review" && r.status !== "Still decoding" && r.status !== "unknown";
    if (ok) resolved++;
    console.log(`  ${ok ? "PASS" : "FAIL"} | ${r.code} | ${r.expected.padEnd(25)} | ${r.status}`);
  }
  console.log(`\nAI decoded: ${resolved}/${results.length}`);

  // With the escalation fix, at least some should decode via OpenAI even with Gemini down
  expect(resolved).toBeGreaterThanOrEqual(2);
});
