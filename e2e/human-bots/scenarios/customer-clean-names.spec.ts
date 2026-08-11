import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";

// P5 (2026-06-22): the customer Counts/Products view shows a CLEAN "Brand Model Size" name, not the raw
// stored name with a "UPC <code> - " prefix and a "Fits: ..." fitment clause. Render-only: the stored name
// is untouched (platformOwner still sees it raw). Seeds a messy-named counted product and checks the render.

const PROOF = "e2e/proof/daily-2026-06-22";
const RAW = "UPC 086699205636 - Defender LTX M/S 275/70R18 Fits: 2004 Chevrolet";

const seed = {
  state: {
    businessId: "demo-business", sessionId: "sess-cn",
    currentSession: {
      id: "sess-cn", businessId: "demo-business", name: "Clean Names Session", location: "Main", status: "active",
      startedAt: "t", completedAt: null, createdBy: "h", notes: "", syncStatus: "synced",
    },
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
};

test("CustomerCleanNamesBot: Counts shows clean Brand Model Size, no UPC/Fits (P5)", async ({ page }) => {
  mkdirSync(PROOF, { recursive: true });
  await page.goto("/scan");
  // Wait for StoreHydrator's persist.rehydrate() to finish (it reads localStorage on mount, which
  // would otherwise clobber a setState seed applied before hydration completes) before seeding state
  // directly through the live store.
  const body = page.getByTestId("final-count-body");
  await expect(body).toBeVisible();
  await page.evaluate((state) => {
    type SeedState = typeof state;
    type LiveStore = {
      getState: () => { sessionId: string; currentSession: SeedState["currentSession"] };
      setState: (partial: unknown) => void;
    };
    const store = (window as unknown as { __scanStore?: LiveStore }).__scanStore;
    if (!store) throw new Error("scan store is unavailable");
    // Keep the live page's already-registered boot session. Replacing it with the synthetic
    // `startedAt: "t"` fixture makes the scan-page session effect correctly rotate it as stale and
    // prune its counts. This bot is testing display cleanup, not session rotation.
    const live = store.getState();
    store.setState({
      ...state,
      sessionId: live.sessionId,
      currentSession: live.currentSession,
      finalCounts: state.finalCounts.map((count) => ({ ...count, sessionId: live.sessionId })),
    });
  }, seed.state);
  await expect(body).toContainText("Defender LTX M/S 275/70R18");
  const text = await body.innerText();
  expect(text, "no raw UPC prefix shown to customer").not.toContain("UPC 086699205636");
  expect(text, "no fitment clause shown to customer").not.toContain("Fits");
  await page.screenshot({ path: `${PROOF}/09-customer-clean-names.png`, fullPage: true });
});
