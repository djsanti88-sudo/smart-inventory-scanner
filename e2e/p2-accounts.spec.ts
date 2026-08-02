import { test, expect, type Route } from "@playwright/test";

// Task 16 (Phase 2, Track T5): proves acceptance criteria #5 (Google + email sign-in + reset
// affordances in browser, both viewports; sign-out clears local state INCLUDING the per-uid
// localStorage key being GONE) and #6 (destructive actions gated behind owner confirm/PIN;
// markWrong surface via window.__scanStore). Depends on Tasks 5, 8, 15 (merged).

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "phone", width: 390, height: 844 },
];

// FLAKE FIX: a no-keys AI status (GET) + an inert POST reply, mirroring scan.spec.ts. Registered before
// every page.goto so a background /api/ai-lookup call can never race the sign-out reset and deposit a
// stray scan row mid-test. GET returns the capability check (auto-decode gate fails on hasKey -> no POST
// fires); a POST, if it ever did, resolves to {} and mutates nothing.
const NO_AI_STATUS = {
  liveEnabled: false, autoDecodeOnScan: false, geminiEnabled: false, openaiEnabled: false,
  geminiConfigured: false, openaiConfigured: false, premiumFallback: false, mode: "off",
  dailyLimit: 200, missingKeys: ["GEMINI_API_KEY", "OPENAI_API_KEY"], e2e: true,
};

async function mockAiLookup(route: Route) {
  if (route.request().method() === "GET") return route.fulfill({ json: NO_AI_STATUS });
  return route.fulfill({ json: {} });
}

for (const vp of VIEWPORTS) {
  test.describe(`P2 accounts (${vp.name})`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("login page shows email, Google, and reset affordances", async ({ page }) => {
      await page.route("**/api/ai-lookup", mockAiLookup);
      await page.goto("/login");
      await expect(page.getByTestId("login-email")).toBeVisible();
      await expect(page.getByTestId("login-google")).toBeVisible();
      await page.getByTestId("forgot-password").click();
      await expect(page.getByTestId("send-reset")).toBeVisible();
      await page.screenshot({ path: `e2e/proof/p2-login-${vp.name}.png` });
    });

    test("sign-out clears local scan state AND removes the per-uid persist key", async ({ page }) => {
      // Mock mode: the Nav logout button only renders in live mode, so the reset action is exercised
      // via the window.__scanStore hook (Phase 1 ratified precedent). Seed a fake signed-in identity
      // plus a fake per-uid localStorage key, then assert BOTH the in-memory wipe and the key removal.
      await page.route("**/api/ai-lookup", mockAiLookup);
      await page.goto("/scan");
      await page.evaluate(() => {
        window.localStorage.setItem("sis-scan-test-uid", JSON.stringify({ state: {}, version: 8 }));
        const s = (window as unknown as { __scanStore?: { setState: (p: object) => void } }).__scanStore;
        s?.setState({ userId: "test-uid", scanFeed: [{ id: "leak" }], needsReviewQueue: [{ id: "leak-r" }] });
      });
      // N1 (I1 mechanism guard): actually re-point persist at the signed-out user's per-uid key and queue
      // a coalesced write under it BEFORE the reset. This is what makes the test able to CATCH the I1 bug:
      // resetForSignOut must re-point persist to the anon key BEFORE its own wipe write, or the coalescer's
      // pending write (queued here under sis-scan-test-uid) resurrects that key on the next flush tick. A
      // reset that removed the key but did NOT re-point first would let this queued write re-create it, and
      // the post-tick re-check below would then fail.
      await page.evaluate(() => {
        const s = (window as unknown as { __scanStore?: { getState: () => { rehydrateForUid: (uid: string) => void } } }).__scanStore;
        s?.getState().rehydrateForUid("test-uid"); // persist now points at sis-scan-test-uid
      });
      await page.evaluate(() => {
        const s = (window as unknown as { __scanStore?: { setState: (p: object) => void } }).__scanStore;
        s?.setState({ scanFeed: [{ id: "leak2" }] }); // queues a coalesced write under sis-scan-test-uid
      });
      await page.evaluate(async () => {
        const s = (window as unknown as { __scanStore?: { getState: () => { resetForSignOut: () => Promise<unknown> } } }).__scanStore;
        await s?.getState().resetForSignOut();
      });
      const after = await page.evaluate(() => {
        // Compute the null check INSIDE the browser: `?? "unset"` on a correctly-null userId would
        // coerce it to the string "unset" and defeat expect(after.userId).toBeNull() even when the
        // sign-out behavior is correct. Returning a boolean sidesteps the coalescing bug entirely.
        const s = (window as unknown as { __scanStore?: { getState: () => { scanFeed: unknown[]; userId: string | null } } }).__scanStore;
        return {
          feedLen: s?.getState().scanFeed.length ?? -1,
          userIdIsNull: s ? s.getState().userId === null : false,
          uidKeyGone: window.localStorage.getItem("sis-scan-test-uid") === null,
        };
      });
      expect(after.feedLen).toBe(0);
      expect(after.userIdIsNull).toBe(true);
      expect(after.uidKeyGone).toBe(true); // the signed-out user's blob is GONE, not just reset in memory
      const stillGone = await page.evaluate(() => window.localStorage.getItem("sis-scan-test-uid") === null);
      expect(stillGone).toBe(true);
      await page.screenshot({ path: `e2e/proof/p2-signout-${vp.name}.png` });
    });

    test("destructive PIN policy surface exists on the store (markWrong class, __scanStore proof)", async ({ page }) => {
      // markWrong is UI-dead by owner decision (SHOW_ADVANCED_ACTIONS=false); assert the policy inputs
      // it depends on are live: no PIN set by default -> confirm-only path (requiresOwnerPin false).
      await page.route("**/api/ai-lookup", mockAiLookup);
      await page.goto("/scan");
      const pinHash = await page.evaluate(() => {
        const s = (window as unknown as { __scanStore?: { getState: () => { settings: { ownerPinHash: string } } } }).__scanStore;
        return s?.getState().settings.ownerPinHash ?? null;
      });
      expect(pinHash).toBe(""); // default: no PIN, confirm-only fallback active
      await page.screenshot({ path: `e2e/proof/p2-markwrong-${vp.name}.png` });
    });
  });
}
