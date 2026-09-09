import { test, expect, type Page } from "@playwright/test";

// Historical coverage gap 2/C3 (see docs/HISTORY.md): no existing spec seeds a
// CORRUPTED/PARTIAL IndexedDB value and proves the app recovers gracefully. persist-indexeddb.spec.ts
// covers the happy path (write + reload) and the legacy-migration path; product-purge.spec.ts proves the
// same "poisoned cache auto-purges to clean state" idea but only for a wrong-SHAPE localStorage v4 blob,
// never IndexedDB, and never malformed/truncated JSON. This spec plants three distinct corruption shapes
// directly into the app's own IndexedDB record (db "sis-persist", store "kv", key "sis-scan-v1" - same
// coordinates persist-indexeddb.spec.ts already proves are correct) and asserts, for each: the app does
// not white-screen (the scanner input becomes usable again after reload), and a scan made AFTER the
// corrupted load still appears on the feed and counts (TOP-LEVEL LAW holds even coming out of a bad boot).

const PROOF = "e2e/proof/persist-corruption-recovery";

const NO_AI_STATUS = {
  liveEnabled: false, autoDecodeOnScan: false, openaiConfigured: false, mode: "off",
  dailyLimit: 200, missingKeys: ["OPENAI_API_KEY"], e2e: true,
};

async function stubAiLookup(page: Page) {
  await page.route("**/api/ai-lookup", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: NO_AI_STATUS });
    return route.fulfill({ json: {} });
  });
}

async function login(page: Page) {
  await page.goto("/login");
  await page.getByTestId("login-button").click();
  await page.waitForURL("**/scan");
  await expect(page.getByTestId("scanner-input")).toBeFocused();
}

async function scan(page: Page, code: string) {
  const input = page.getByTestId("scanner-input");
  await input.click();
  await input.pressSequentially(code, { delay: 2 });
  await input.press("Enter");
}

// TOP-LEVEL LAW check that does not depend on WHICH product/testid a code lands on (a fresh-reset store
// after corruption uses the PRODUCTION default scanContext "tire", not the generic e2e fixture's "any",
// so a non-tire code like Coca-Cola may land as a fresh provisional row instead of the seeded "prod-coke"
// - that is expected and is not itself a defect). Sums every qty-* cell in "Your counts", exactly like
// count-law-mixed-tiers.spec.ts's whole-session invariant.
async function totalCounted(page: Page): Promise<number> {
  const qtyTexts = await page.getByTestId("final-count-body").locator('[data-testid^="qty-"]').allTextContents();
  return qtyTexts.reduce((sum, t) => sum + (parseInt(t.trim(), 10) || 0), 0);
}

// Writes a RAW string value directly into the app's own IndexedDB record, exactly the coordinates
// scanPersistStorage.ts's async backing uses (db "sis-persist" v1, store "kv"). Runs as a real
// page.evaluate (awaited to completion) AFTER the app has already booted once, so there is no race with
// the app's own DB-open/versioning - same technique persist-indexeddb.spec.ts's migration test uses to
// manipulate IndexedDB mid-test.
async function corruptIdbValue(page: Page, key: string, rawValue: string): Promise<void> {
  await page.evaluate(
    ({ k, v }) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open("sis-persist", 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
        };
        req.onsuccess = () => {
          try {
            const t = req.result.transaction("kv", "readwrite");
            t.objectStore("kv").put(v, k);
            t.oncomplete = () => resolve();
            t.onerror = () => reject(t.error);
          } catch (e) {
            reject(e as Error);
          }
        };
        req.onerror = () => reject(req.error);
      }),
    { k: key, v: rawValue },
  );
}

// After planting corruption and reloading, the auth-bypass session may or may not survive the reload
// (mirrors persist-indexeddb.spec.ts's own handling of this).
async function afterReload(page: Page) {
  if (!page.url().includes("/scan")) {
    await login(page);
  } else {
    await expect(page.getByTestId("scanner-input")).toBeVisible({ timeout: 15_000 });
  }
}

test.describe("corrupted IndexedDB persist record: graceful recovery, never a white screen", () => {
  test("malformed JSON (not parseable at all)", async ({ page }) => {
    await stubAiLookup(page);
    await login(page);

    await corruptIdbValue(page, "sis-scan-v1", "{not valid json at all !! %%% ][");

    await page.reload();
    await afterReload(page);

    await page.screenshot({ path: `${PROOF}/malformed-json-after-reload.png`, fullPage: true });

    // Recovery proof: a scan made AFTER the corrupted boot still appears and counts (TOP-LEVEL LAW).
    await scan(page, "049000028904");
    await expect(page.getByTestId("scan-feed-body").locator("tr")).toHaveCount(1);
    expect(await totalCounted(page)).toBe(1);
  });

  test("truncated record (valid JSON opening, cut off mid-object)", async ({ page }) => {
    await stubAiLookup(page);
    await login(page);

    const full = JSON.stringify({
      state: { products: [{ id: "prod-nokian", name: "Nokian" }], settings: { businessId: "demo-business" } },
      version: 14,
    });
    const truncated = full.slice(0, Math.floor(full.length / 2)); // cut mid-object, never valid JSON
    await corruptIdbValue(page, "sis-scan-v1", truncated);

    await page.reload();
    await afterReload(page);

    await page.screenshot({ path: `${PROOF}/truncated-record-after-reload.png`, fullPage: true });

    await scan(page, "049000028904");
    await expect(page.getByTestId("scan-feed-body").locator("tr")).toHaveCount(1);
    expect(await totalCounted(page)).toBe(1);
  });

  test("wrong-shape value (valid JSON, but fields have the wrong type)", async ({ page }) => {
    await stubAiLookup(page);
    await login(page);

    // Valid JSON at the CURRENT persist version (scanStore.ts persist() version: 14) so zustand's
    // `migrate` is skipped entirely (migrate only runs when the stored version differs) and the
    // wrong-shape value flows straight into the default shallow merge over the initial state - the
    // most direct exercise of "what happens when a field has the wrong type after a bad write".
    const wrongShape = JSON.stringify({
      state: {
        products: "not-an-array", // should be Product[]
        aliases: [],
        scanFeed: [],
        finalCounts: [],
        needsReviewQueue: [],
        pendingSyncQueue: [],
        settings: { businessId: "demo-business" },
      },
      version: 14,
    });
    await corruptIdbValue(page, "sis-scan-v1", wrongShape);

    await page.reload();
    await afterReload(page);

    await page.screenshot({ path: `${PROOF}/wrong-shape-after-reload.png`, fullPage: true });

    await scan(page, "049000028904");
    await expect(page.getByTestId("scan-feed-body").locator("tr")).toHaveCount(1);
    expect(await totalCounted(page)).toBe(1);
  });
});
