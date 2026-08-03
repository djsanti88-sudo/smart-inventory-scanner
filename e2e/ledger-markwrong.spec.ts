import { test, expect, type Page } from "./fixtures";

// Task 9 (Phase 1 ledger plan): browser proof that markWrong keeps the summed session quantity
// constant. The store-side fix (Task 5, commit c479834) transfers a wrong product's quantity to a
// safe "Unidentified item" provisional instead of dropping it. This spec proves that invariant
// holds through the REAL browser (store state AND rendered DOM), at desktop and 390px phone
// viewports. Screenshots: e2e/proof/ledger-markwrong-desktop.png, e2e/proof/ledger-markwrong-phone.png.
//
// Scenario 1 seeds a VERIFIED tire with its primary barcode (and an approved human alias) via the
// store handle so both scans resolve "known" and count against it deterministically. Keeping the
// barcode on the verified product exercises the normal exact-product resolution path before the
// correction flow under test.
//
// Scenario 2 (provisional-wrong): a scan of a genuinely UNRESOLVED code lands on a PROVISIONAL
// placeholder (minted by ensureProvisionalCount on first scan); marking THAT provisional wrong used
// to hit a real inflation bug (found by this task's browser proof, documented in
// .superpowers/sdd/task-9-report.md): markWrong's repoint step re-derived "the" provisional via an
// unordered products.find on primaryBarcode, which could match the OLD marked-wrong provisional
// (its primaryBarcode is never blanked) instead of the newly-minted one - counting the same
// physical scans on two rows and inflating the total 2 -> 3. That gap is NOW FIXED (the mint target
// id comes from ensureProvisionalCount's own return, id-keyed and excluding the marked-wrong
// product) and LOCKED here browser-side plus unit-side in markWrongTransfer.store.test.ts
// ("PROVISIONAL-WRONG (Task 9 finding)").

const AI_OFF = {
  liveEnabled: false, autoDecodeOnScan: false, geminiEnabled: false, openaiEnabled: false,
  geminiConfigured: false, openaiConfigured: false, premiumFallback: false, mode: "off",
  dailyLimit: 200, missingKeys: ["GEMINI_API_KEY", "OPENAI_API_KEY"], e2e: true,
};

// A valid UPC from the local unknown-scan batch. It has no approved alias or current
// tire/retail corpus entry; do not replace it with a common retail barcode, because a
// later corpus import can resolve that code before this deliberately seeded alias runs.
const WRONG_CODE = "086699368492";
const WRONG_PRODUCT_ID = "e2e-seed-wrong-1";

async function scan(page: Page, code: string) {
  const input = page.getByTestId("scanner-input");
  await input.click();
  await input.pressSequentially(code, { delay: 2 });
  await input.press("Enter");
}

// Seed a verified tire + approved alias directly in the store. The primary barcode makes exact
// product resolution deterministic; the approved alias retains the human-linking fixture shape.
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
            id: productId, businessId: s.businessId, name: "Wrongly Mapped Test Tire", brand: "TestBrand",
            category: "tire", specsShort: "265/70R17", specsFull: "265/70R17 test tire", primarySku: "", primaryBarcode: code,
            gtin: "", upc: "", ean: "", vendorCodes: [], aliases: [], imageUrl: "", productUrl: "",
            location: "", notes: "", status: "active", source: "seed", confidence: 1, verified: true,
            createdAt: s.sessionId, updatedAt: s.sessionId, createdBy: "seed", updatedBy: "seed",
          },
        ],
        aliases: [
          ...prev.aliases,
          {
            id: "e2e-seed-alias-wrong-1", businessId: s.businessId, productId, rawCodeExample: code,
            cleanCode: code, normalizedCode: code, aliasType: "barcode", source: "human_review", confidence: 1,
            approved: true, createdAt: s.sessionId, updatedAt: s.sessionId, createdBy: "human_link_existing",
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

    // Fixture precondition: the verified tire is present before scanning. The two scans below must
    // therefore exercise the deterministic exact-product path, not an async decode/provisional path.
    await expect.poll(() => page.evaluate(({ productId, code }: { productId: string; code: string }) => {
      type Store = { getState: () => { products: Array<{ id: string; verified?: boolean; category?: string; primaryBarcode?: string }> } };
      const w = window as unknown as { __scanStore: Store };
      return w.__scanStore.getState().products.some(
        (product) => product.id === productId && product.verified === true && product.category === "tire" && product.primaryBarcode === code,
      );
    }, { productId: WRONG_PRODUCT_ID, code: WRONG_CODE }), { message: "verified tire fixture is seeded" }).toBe(true);

    // Scan the seeded (wrong) product's code twice -> one counted row, quantity 2. Both scans
    // resolve deterministically against the verified tire (no async decode involved).
    await scan(page, WRONG_CODE);
    await scan(page, WRONG_CODE);
    await expect(page.getByTestId("final-count-body").locator('tr[data-testid^="count-row-"]')).toHaveCount(1);
    const preCorrectionCounts = await page.evaluate(() => {
      type Store = { getState: () => { finalCounts: Array<{ productId: string; quantity: number }> } };
      const w = window as unknown as { __scanStore: Store };
      return w.__scanStore.getState().finalCounts.map(({ productId, quantity }) => ({ productId, quantity }));
    });
    expect(preCorrectionCounts).toEqual([{ productId: WRONG_PRODUCT_ID, quantity: 2 }]);
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

  test(`markWrong on a PROVISIONAL keeps total constant - Task 9 inflation locked (${vp.name})`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.route("**/api/ai-lookup", async (route) => {
      if (route.request().method() === "GET") return route.fulfill({ json: AI_OFF });
      return route.fulfill({ json: {} });
    });
    await page.goto("/login");
    await page.getByTestId("login-button").click();
    await page.waitForURL("**/scan");
    await expect(page.getByTestId("scanner-input")).toBeFocused();

    // NO seeding: scan a genuinely unknown, corpus-free code twice. The first scan mints an
    // Unidentified provisional via ensureProvisionalCount and counts; the second counts against it.
    const UNKNOWN_CODE = "697662129691";
    await scan(page, UNKNOWN_CODE);
    await scan(page, UNKNOWN_CODE);
    await expect.poll(() => totalCounted(page), { message: "two unknown scans counted" }).toBe(2);

    // Grab the provisional the scans counted against.
    const oldProvId = await page.evaluate((code: string) => {
      type State = {
        products: Array<{ id: string; provisional?: boolean; status?: string; primaryBarcode?: string }>;
      };
      const w = window as unknown as { __scanStore: { getState: () => State } };
      const p = w.__scanStore.getState().products.find(
        (x) => x.provisional === true && x.status !== "archived" && x.primaryBarcode === code,
      );
      return p?.id ?? "";
    }, UNKNOWN_CODE);
    expect(oldProvId).not.toBe("");
    await expect(page.getByTestId(`qty-${oldProvId}`)).toHaveText(/2/);

    // Mark the PROVISIONAL itself wrong - the exact scenario that used to inflate 2 -> 3.
    await page.evaluate(async (id: string) => {
      type Store = { getState: () => { markWrong: (pid: string, o?: { reason?: string }) => Promise<string | null> } };
      const w = window as unknown as { __scanStore: Store };
      await w.__scanStore.getState().markWrong(id, { reason: "e2e provisional-wrong proof" });
    }, oldProvId);

    // STORE invariant: total unchanged (the bug made this 3).
    await expect.poll(() => totalCounted(page), { message: "total invariant across provisional markWrong" }).toBe(2);

    // The old provisional never regains a count row; a NEW provisional carries the full 2.
    await expect(page.getByTestId(`count-row-${oldProvId}`)).toHaveCount(0);
    await expect(page.getByTestId("final-count-body").locator('tr[data-testid^="count-row-"]')).toHaveCount(1);
    const newProvId = await page.evaluate(() => {
      type Store = { getState: () => { finalCounts: Array<{ productId: string }> } };
      const w = window as unknown as { __scanStore: Store };
      return w.__scanStore.getState().finalCounts[0]?.productId ?? "";
    });
    expect(newProvId).not.toBe("");
    expect(newProvId).not.toBe(oldProvId);
    await expect(page.getByTestId(`qty-${newProvId}`)).toHaveText(/2/);

    await page.screenshot({ path: `e2e/proof/ledger-markwrong-provisional-${vp.name}.png`, fullPage: true });
  });
}
