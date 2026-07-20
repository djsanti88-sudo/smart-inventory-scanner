import { test, expect, type Page } from "./fixtures";

// Task 9 (Phase 1 ledger plan): browser proof that markWrong keeps the summed session quantity
// constant. The store-side fix (Task 5, commit c479834) transfers a wrong product's quantity to a
// safe "Unidentified item" provisional instead of dropping it. This spec proves that invariant
// holds through the REAL browser (store state AND rendered DOM), at desktop and 390px phone
// viewports. Screenshots: e2e/proof/ledger-markwrong-desktop.png, e2e/proof/ledger-markwrong-phone.png.
//
// Scenario note: this seeds a VERIFIED product with an APPROVED alias (via the store handle, same
// shape as src/stores/markWrongTransfer.store.test.ts's seedKnown helper) so both scans resolve
// "known" and count against it deterministically - this is the exact scenario Task 5's D2 fix was
// built and unit-proven against. A scan of a genuinely UNRESOLVED code lands on a PROVISIONAL
// placeholder instead (minted by ensureProvisionalCount on first scan); marking THAT provisional
// wrong hits a separate, still-open gap where markWrong's own repoint step can match the OLD
// provisional instead of the newly-minted one (both satisfy `provisional === true` with the same
// primaryBarcode, and the lookup is an unordered `.find`), inflating the total. That gap is
// documented in the Task 9 report and is out of this task's scope (proof spec only, not a
// scanStore.ts fix) - see .superpowers/sdd/task-9-report.md.

const AI_OFF = {
  liveEnabled: false, autoDecodeOnScan: false, geminiEnabled: false, openaiEnabled: false,
  geminiConfigured: false, openaiConfigured: false, premiumFallback: false, mode: "off",
  dailyLimit: 200, missingKeys: ["GEMINI_API_KEY", "OPENAI_API_KEY"], e2e: true,
};

const WRONG_CODE = "049000006346";
const WRONG_PRODUCT_ID = "e2e-seed-wrong-1";

async function scan(page: Page, code: string) {
  const input = page.getByTestId("scanner-input");
  await input.click();
  await input.pressSequentially(code, { delay: 2 });
  await input.press("Enter");
}

// Seed a verified product + approved alias directly in the store, mirroring
// markWrongTransfer.store.test.ts's seedKnown() so both scans resolve deterministically "known"
// against the (wrong) product instead of minting an unresolved provisional placeholder.
async function seedWrongVerifiedProduct(page: Page) {
  await page.evaluate(
    ({ code, productId }) => {
      type Product = Record<string, unknown>;
      type Alias = Record<string, unknown>;
      type State = { businessId: string; sessionId: string; products: Product[]; aliases: Alias[] };
      type Store = {
        getState: () => State;
        setState: (fn: (prev: State) => Partial<State>) => void;
      };
      const w = window as unknown as { __scanStore: Store };
      const s = w.__scanStore.getState();
      w.__scanStore.setState((prev) => ({
        products: [
          ...prev.products,
          {
            id: productId, businessId: s.businessId, name: "Wrongly Mapped Item", brand: "TestBrand",
            category: "misc", specsShort: "", specsFull: "", primarySku: "", primaryBarcode: code,
            gtin: "", upc: "", ean: "", vendorCodes: [], aliases: [], imageUrl: "", productUrl: "",
            location: "", notes: "", status: "active", source: "seed", confidence: 1, verified: true,
            createdAt: s.sessionId, updatedAt: s.sessionId, createdBy: "seed", updatedBy: "seed",
          },
        ],
        aliases: [
          ...prev.aliases,
          {
            id: "e2e-seed-alias-wrong-1", businessId: s.businessId, productId, rawCodeExample: code,
            cleanCode: code, normalizedCode: code, aliasType: "barcode", source: "seed", confidence: 1,
            approved: true, createdAt: s.sessionId, updatedAt: s.sessionId, createdBy: "seed",
            lastSeenAt: s.sessionId, syncStatus: "synced", idempotencyKey: "e2e-seed-alias-wrong-1",
          },
        ],
      }));
    },
    { code: WRONG_CODE, productId: WRONG_PRODUCT_ID },
  );
}

// Total counted quantity via the dev/test store handle (scanStore.ts:5270-5272; same pattern as
// e2e/batch-approve.spec.ts:144-149).
async function totalCounted(page: Page): Promise<number> {
  return page.evaluate(() => {
    type Store = { getState: () => { finalCounts: Array<{ quantity: number }> } };
    const w = window as unknown as { __scanStore: Store };
    return w.__scanStore.getState().finalCounts.reduce((n, c) => n + c.quantity, 0);
  });
}

for (const vp of [
  { name: "desktop", width: 1280, height: 800 },
  { name: "phone", width: 390, height: 844 },
]) {
  test(`markWrong keeps total counted quantity constant (${vp.name})`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.route("**/api/ai-lookup", async (route) => {
      if (route.request().method() === "GET") return route.fulfill({ json: AI_OFF });
      return route.fulfill({ json: {} });
    });
    await page.goto("/login");
    await page.getByTestId("login-button").click();
    await page.waitForURL("**/scan");
    await expect(page.getByTestId("scanner-input")).toBeFocused();

    await seedWrongVerifiedProduct(page);

    // Scan the seeded (wrong) product's code twice -> one counted row, quantity 2. Both scans
    // resolve deterministically "known" against the approved alias (no async decode involved).
    await scan(page, WRONG_CODE);
    await scan(page, WRONG_CODE);
    await expect(page.getByTestId("final-count-body").locator('tr[data-testid^="count-row-"]')).toHaveCount(1);
    await expect(page.getByTestId(`qty-${WRONG_PRODUCT_ID}`)).toHaveText(/2/);

    const before = await totalCounted(page);
    expect(before).toBe(2);

    // Drive markWrong through the store handle (the UI button is behind SHOW_ADVANCED_ACTIONS=false,
    // FinalCountTable.tsx:172; the handle is the precedented e2e mechanism - batch-approve.spec.ts:156-163).
    await page.evaluate(async (id: string) => {
      type Store = { getState: () => { markWrong: (pid: string, o?: { reason?: string }) => Promise<string | null> } };
      const w = window as unknown as { __scanStore: Store };
      await w.__scanStore.getState().markWrong(id, { reason: "e2e ledger proof" });
    }, WRONG_PRODUCT_ID);

    // STORE assertion: total physical quantity is invariant across markWrong.
    await expect.poll(() => totalCounted(page), { message: "total physical quantity invariant" }).toBe(before);

    // DOM assertions: the transfer is RENDERED, not just stored. Exactly one counted row remains (the
    // Unidentified provisional), the wrong product's row is gone, and the qty cell shows the full 2.
    await expect(page.getByTestId("final-count-body").locator('tr[data-testid^="count-row-"]')).toHaveCount(1);
    await expect(page.getByTestId(`count-row-${WRONG_PRODUCT_ID}`)).toHaveCount(0);
    const provisionalId = await page.evaluate(() => {
      type Store = { getState: () => { finalCounts: Array<{ productId: string }> } };
      const w = window as unknown as { __scanStore: Store };
      return w.__scanStore.getState().finalCounts[0]?.productId ?? "";
    });
    expect(provisionalId).not.toBe("");
    expect(provisionalId).not.toBe(WRONG_PRODUCT_ID);
    await expect(page.getByTestId(`qty-${provisionalId}`)).toHaveText(/2/);

    await page.screenshot({ path: `e2e/proof/ledger-markwrong-${vp.name}.png`, fullPage: true });
  });
}
