import { test, expect } from "./fixtures";

// P2 (2026-06-22): platform maintenance tool. Some legacy products carry their barcode ONLY in the name
// (e.g. "UPC 029142712886 - Discoverer A/T3") with empty identifier fields. The backfill fills the barcode
// field from that name prefix so future re-scans dedup cleanly. It is platform-only, dry-run previewed,
// reversible (Undo), and never auto-runs. This proves the UI end-to-end on seeded legacy data (the current
// create flow always fills the field, so this precondition only arises from imported/legacy data).

const PROOF = "e2e/proof/daily-2026-06-22";
const KEY = "sis-scan-v1";

const legacyState = {
  state: {
    businessId: "demo-business",
    sessionId: "sess-bf",
    products: [{
      id: "prod-legacy", businessId: "demo-business",
      name: "UPC 029142712886 - Discoverer A/T3 E (10 Ply) BW",
      brand: "", category: "", specsShort: "", specsFull: "", primarySku: "",
      primaryBarcode: "", gtin: "", upc: "", ean: "", vendorCodes: [], aliases: [],
      imageUrl: "", productUrl: "", location: "", notes: "", status: "active",
      source: "human_review", confidence: 1, verified: false,
      createdAt: "t", updatedAt: "t", createdBy: "h", updatedBy: "h",
    }],
    finalCounts: [{
      id: "fc-legacy", businessId: "demo-business", sessionId: "sess-bf", productId: "prod-legacy",
      quantity: 5, lastScannedAt: "t", aliasesSeen: [], scanEventIds: [], createdAt: "t", updatedAt: "t",
      syncStatus: "synced", syncError: null, appliedIdempotencyKeys: [],
    }],
  },
  version: 6,
};

test("IdentifierBackfillBot: platform fills barcode-in-name, reversible (P2)", async ({ page }) => {
  await page.addInitScript(([k, v]) => window.localStorage.setItem(k, v), [KEY, JSON.stringify(legacyState)] as const);

  await page.goto("/settings");

  // P3 cross-check: the platformOwner view is UNCHANGED - it still shows the technical settings a customer
  // no longer sees (Business ID, Scanner tuning, Sync internals).
  // Wait for the persisted store to hydrate (Settings renders "Loading local session..." until then) so the
  // body-text read below never races hydration. Timing guard only - it changes/weakens no assertion.
  await expect(page.getByTestId("identifier-backfill")).toBeVisible();
  const settingsBody = await page.locator("body").innerText();
  for (const term of ["Business ID", "Auto-submit delay", "Prevent duplicate saves", "Scanner trigger"]) {
    expect(settingsBody, `platform Settings still shows "${term}"`).toContain(term);
  }

  const block = page.getByTestId("identifier-backfill");
  await expect(block).toBeVisible();
  await block.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${PROOF}/04-backfill-before.png`, fullPage: true });

  await block.getByTestId("backfill-apply").click();
  await expect(block.getByTestId("backfill-msg")).toContainText(/Filled the barcode field on 1/);
  await page.screenshot({ path: `${PROOF}/05-backfill-after.png`, fullPage: true });

  // Undo restores the empty field.
  await block.getByTestId("undo-backfill").click();
  await expect(block.getByTestId("backfill-msg")).toContainText(/undone/i);
});
