import { test, expect, type Page } from "./fixtures";

// Task 5 (#27 IndexedDB persist migration): proves the scan store persists its blob to IndexedDB
// (db "sis-persist", store "kv", key "sis-scan-v1") instead of the ~5MB-capped localStorage, that a
// reload rehydrates from IDB, and that a legacy localStorage blob from an older install migrates
// forward into IDB via copy-then-clear (scanPersistStorage.ts createAsyncCoalescedFailSoftPersistStorage).

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

// Force the store's flush-on-hide listener (visibilitychange -> "hidden") so the coalesced write
// lands in the backing store deterministically, without waiting on a real tab-hide.
async function forceHideFlush(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

// Raw IndexedDB reader against the app's own db/store/key (db "sis-persist", store "kv").
async function readIdb(page: Page, key: string): Promise<string | null> {
  return page.evaluate(
    (k) =>
      new Promise<string | null>((resolve) => {
        const req = indexedDB.open("sis-persist", 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
        };
        req.onsuccess = () => {
          try {
            const t = req.result.transaction("kv", "readonly");
            const g = t.objectStore("kv").get(k);
            g.onsuccess = () => resolve(typeof g.result === "string" ? g.result : null);
            g.onerror = () => resolve(null);
          } catch {
            resolve(null);
          }
        };
        req.onerror = () => resolve(null);
      }),
    key,
  );
}

const UNKNOWNS = ["697662129691", "697662131854", "697662137658", "086699368492"];

test("scans persist to IndexedDB and survive reload; localStorage stays small", async ({ page }) => {
  await stubAiLookup(page);
  await login(page);

  await scan(page, UNKNOWNS[0]);
  await scan(page, UNKNOWNS[1]);
  await scan(page, UNKNOWNS[2]);

  // Let the coalesced write schedule, then force the hide-flush that guarantees it lands.
  await page.waitForTimeout(400);
  await forceHideFlush(page);

  await expect.poll(() => readIdb(page, "sis-scan-v1")).not.toBeNull();
  const blob = await readIdb(page, "sis-scan-v1");
  expect(blob).toContain(UNKNOWNS[0]);

  // The big scan blob must NOT be sitting in localStorage (that was the ~5MB-quota bug #16/#37).
  const lsValue = await page.evaluate(() => localStorage.getItem("sis-scan-v1"));
  expect(lsValue).toBeNull();

  await page.reload();
  // Auth bypass mode may land back on /login; if so, log back in before asserting rehydration.
  if (!page.url().includes("/scan")) {
    await login(page);
  } else {
    await expect(page.getByTestId("scanner-input")).toBeFocused();
  }

  await expect(page.getByTestId("scan-feed-body")).toContainText(UNKNOWNS[0]);
});

test("legacy localStorage blob migrates into IndexedDB on load (copy-then-clear)", async ({ page }) => {
  await stubAiLookup(page);
  await login(page);

  await scan(page, UNKNOWNS[3]);
  await page.waitForTimeout(400);
  await forceHideFlush(page);

  await expect.poll(() => readIdb(page, "sis-scan-v1")).not.toBeNull();
  const blob = await readIdb(page, "sis-scan-v1");
  expect(blob).not.toBeNull();

  // Simulate an old install: seed the LEGACY localStorage blob and wipe IndexedDB.
  await page.evaluate((v) => localStorage.setItem("sis-scan-v1", v as string), blob);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const req = indexedDB.open("sis-persist", 1);
        req.onsuccess = () => {
          const t = req.result.transaction("kv", "readwrite");
          t.objectStore("kv").delete("sis-scan-v1");
          t.oncomplete = () => resolve();
          t.onerror = () => resolve();
        };
        req.onerror = () => resolve();
      }),
  );

  await page.reload();
  if (!page.url().includes("/scan")) {
    await login(page);
  } else {
    await expect(page.getByTestId("scanner-input")).toBeFocused();
  }

  // State came back from the legacy blob.
  await expect(page.getByTestId("scan-feed-body")).toContainText(UNKNOWNS[3]);
  // Copied forward into IndexedDB...
  await expect.poll(() => readIdb(page, "sis-scan-v1")).not.toBeNull();
  // ...and the legacy key cleared AFTER the copy (copy-then-clear).
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("sis-scan-v1")))
    .toBeNull();
});
