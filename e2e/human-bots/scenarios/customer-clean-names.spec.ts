import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";

// P5 (2026-06-22): the customer Counts/Products view shows a CLEAN "Brand Model Size" name, not the raw
// stored name with a "UPC <code> - " prefix and a "Fits: ..." fitment clause. Render-only: the stored name
// is untouched (platformOwner still sees it raw). Seeds a messy-named counted product and checks the render.

const PROOF = "e2e/proof/daily-2026-06-22";
const KEY = "sis-scan-v1";
const RAW = "UPC 086699205636 - Defender LTX M/S 275/70R18 Fits: 2004 Chevrolet";

const seed = {
  state: {
    businessId: "demo-business", sessionId: "sess-cn",
    products: [{
      id: "prod-messy", businessId: "demo-business", name: RAW, brand: "Michelin", category: "tire",
      specsShort: "275/70R18", specsFull: "", primarySku: "", primaryBarcode: "086699205636", gtin: "",
      upc: "086699205636", ean: "", vendorCodes: [], aliases: ["086699205636"], imageUrl: "", productUrl: "",
      location: "", notes: "", status: "active", source: "human_review", confidence: 1, verified: true,
      createdAt: "t", updatedAt: "t", createdBy: "h", updatedBy: "h",
    }],
    finalCounts: [{
      id: "fc-messy", businessId: "demo-business", sessionId: "sess-cn", productId: "prod-messy", quantity: 3,
      lastScannedAt: "t", aliasesSeen: [], scanEventIds: [], createdAt: "t", updatedAt: "t",
      syncStatus: "synced", syncError: null, appliedIdempotencyKeys: [],
    }],
  },
  version: 6,
};

test("CustomerCleanNamesBot: Counts shows clean Brand Model Size, no UPC/Fits (P5)", async ({ page }) => {
  mkdirSync(PROOF, { recursive: true });
  await page.addInitScript(([k, v]) => window.localStorage.setItem(k, v), [KEY, JSON.stringify(seed)] as const);

  await page.goto("/scan");
  const body = page.getByTestId("final-count-body");
  await expect(body).toContainText("Defender LTX M/S 275/70R18");
  const text = await body.innerText();
  expect(text, "no raw UPC prefix shown to customer").not.toContain("UPC 086699205636");
  expect(text, "no fitment clause shown to customer").not.toContain("Fits");
  await page.screenshot({ path: `${PROOF}/09-customer-clean-names.png`, fullPage: true });
});
