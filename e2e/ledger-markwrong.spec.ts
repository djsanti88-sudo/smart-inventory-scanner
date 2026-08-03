import { test, expect, type Page } from "./fixtures";

// Task 9 (Phase 1 ledger plan): browser proof that markWrong keeps the summed session quantity
// constant. The store-side fix (Task 5, commit c479834) transfers a wrong product's quantity to a
// safe "Unidentified item" provisional instead of dropping it. This spec proves that invariant
// holds through the REAL browser (store state AND rendered DOM), at desktop and 390px phone
// viewports. Screenshots: e2e/proof/ledger-markwrong-desktop.png, e2e/proof/ledger-markwrong-phone.png.
//
// Scenario 1 creates a VERIFIED tire through the same human-confirmation action used by the app:
// an initially unknown scan is counted, the open review is confirmed as a new product, then its
// approved alias resolves the next physical scan to that same product before correction.
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

async function scan(page: Page, code: string) {
  const input = page.getByTestId("scanner-input");
  await input.click();
  await input.pressSequentially(code, { delay: 2 });
  await input.press("Enter");
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

    // Wait for StoreHydrator before the real human-confirmation flow.
    await expect(page.getByTestId("final-count-body")).toBeVisible();
    const wrongCode = vp.name === "desktop" ? "697662131854" : "697662137658";
    await scan(page, wrongCode);
    await expect.poll(() => totalCounted(page), { message: "initial unknown scan counted" }).toBe(1);

    // Confirm the open review through the normal human create_new store action, preserving the
    // already-counted physical scan rather than injecting a product/alias fixture into state. This
    // deliberately does not exercise the separate link_existing mismatch/firewall override path.
    const wrongProductId = await page.evaluate(async (code: string) => {
      type Review = { id: string; cleanCode: string; status: string };
      type Product = { id: string; verified?: boolean; provisional?: boolean; primaryBarcode?: string; category?: string };
      type Alias = { productId: string; approved?: boolean; cleanCode?: string; source?: string; createdBy?: string };
      type State = {
        needsReviewQueue: Review[];
        products: Product[];
        aliases: Alias[];
        resolveUnknown: (reviewId: string, action: "create_new", options: {
          origin: "human"; applyToCount: boolean; newProduct: Record<string, unknown>;
        }) => Promise<void> | void;
      };
      const w = window as unknown as { __scanStore: { getState: () => State } };
      const review = w.__scanStore.getState().needsReviewQueue.find((item) => item.cleanCode === code && item.status === "open");
      if (!review) return "";
      await w.__scanStore.getState().resolveUnknown(review.id, "create_new", {
        origin: "human", applyToCount: true,
        newProduct: {
          name: "Wrongly Mapped Test Tire", brand: "TestBrand", category: "tire",
          specsShort: "265/70R17", specsFull: "265/70R17 test tire", primaryBarcode: code,
        },
      });
      const state = w.__scanStore.getState();
      const product = state.products.find((item) => item.primaryBarcode === code && item.verified === true && item.provisional !== true && item.category === "tire");
      if (!product || !state.aliases.some((alias) => alias.productId === product.id && alias.approved === true && alias.cleanCode === code && alias.source === "human_review" && alias.createdBy === "human")) return "";
      return product.id;
    }, wrongCode);
    expect(wrongProductId).not.toBe("");

    // The original feed item maps to the newly verified human-confirmed product; scanning the
    // exact approved alias again must count on that one row without a duplicate.
    await expect.poll(() => page.evaluate(({ productId, code }: { productId: string; code: string }) => {
      type State = { scanFeed: Array<{ matchedProductId?: string; cleanCode?: string }>; finalCounts: Array<{ productId: string; quantity: number }> };
      const w = window as unknown as { __scanStore: { getState: () => State } };
      const state = w.__scanStore.getState();
      return state.scanFeed.some((event) => event.cleanCode === code && event.matchedProductId === productId)
        && state.finalCounts.some((count) => count.productId === productId && count.quantity === 1);
    }, { productId: wrongProductId, code: wrongCode }), { message: "human-confirmed product retains original scan" }).toBe(true);
    await scan(page, wrongCode);
    await expect.poll(() => page.evaluate(({ productId, code }: { productId: string; code: string }) => {
      type Event = { cleanCode?: string; matchedProductId?: string; status?: string };
      const w = window as unknown as { __scanStore: { getState: () => { scanFeed: Event[] } } };
      return w.__scanStore.getState().scanFeed.filter(
        (event) => event.cleanCode === code && event.matchedProductId === productId && event.status === "known",
      ).length;
    }, { productId: wrongProductId, code: wrongCode }), { message: "second scan resolves known through approved alias" }).toBe(1);
    await expect(page.getByTestId("final-count-body").locator('tr[data-testid^="count-row-"]')).toHaveCount(1);
    const preCorrectionCounts = await page.evaluate(() => {
      type Store = { getState: () => { finalCounts: Array<{ productId: string; quantity: number }> } };
      const w = window as unknown as { __scanStore: Store };
      return w.__scanStore.getState().finalCounts.map(({ productId, quantity }) => ({ productId, quantity }));
    });
    expect(preCorrectionCounts).toEqual([{ productId: wrongProductId, quantity: 2 }]);
    await expect(page.getByTestId(`qty-${wrongProductId}`)).toHaveText(/2/);

    const before = await totalCounted(page);
    expect(before).toBe(2);

    // Drive markWrong through the store handle (the UI button is behind SHOW_ADVANCED_ACTIONS=false,
    // FinalCountTable.tsx:172; the handle is the precedented e2e mechanism - batch-approve.spec.ts:156-163).
    await page.evaluate(async (id: string) => {
      type Store = { getState: () => { markWrong: (pid: string, o?: { reason?: string }) => Promise<string | null> } };
      const w = window as unknown as { __scanStore: Store };
      await w.__scanStore.getState().markWrong(id, { reason: "e2e ledger proof" });
    }, wrongProductId);

    // STORE assertion: total physical quantity is invariant across markWrong.
    await expect.poll(() => totalCounted(page), { message: "total physical quantity invariant" }).toBe(before);

    // DOM assertions: the transfer is RENDERED, not just stored. Exactly one counted row remains (the
    // Unidentified provisional), the wrong product's row is gone, and the qty cell shows the full 2.
    await expect(page.getByTestId("final-count-body").locator('tr[data-testid^="count-row-"]')).toHaveCount(1);
    await expect(page.getByTestId(`count-row-${wrongProductId}`)).toHaveCount(0);
    const provisionalId = await page.evaluate(() => {
      type Store = { getState: () => { finalCounts: Array<{ productId: string }> } };
      const w = window as unknown as { __scanStore: Store };
      return w.__scanStore.getState().finalCounts[0]?.productId ?? "";
    });
    expect(provisionalId).not.toBe("");
    expect(provisionalId).not.toBe(wrongProductId);
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
