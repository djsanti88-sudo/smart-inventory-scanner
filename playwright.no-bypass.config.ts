import { defineConfig, devices } from "@playwright/test";

// Dedicated config for e2e/scan-sync-visibility.spec.ts ONLY. Every other mock Playwright webServer
// (playwright.config.ts, playwright.bots.config.ts, playwright.teach.config.ts) sets
// NEXT_PUBLIC_E2E_AUTH_BYPASS=1 for its whole process - and scan/page.tsx's `expandSecondary` (whether
// the "Sessions and export" <details> starts open) is literally gated on that same env var, so no spec
// running under those configs can ever observe the COLLAPSED state a real user sees (loop2-ui report,
// UI2-1). This config omits that flag entirely so the one spec here loads /scan exactly as a real,
// non-E2E session would: `expandSecondary` is false and SyncStatusBar's full panel starts collapsed.
//
// Login is skipped rather than faked: with no NEXT_PUBLIC_AUTH_MODE / NEXT_PUBLIC_REQUIRE_LOGIN set,
// the app's auth mode defaults to "mock" (services/auth/authMode.ts isOpenAccess() === true), which is
// also local dev's real default per CLAUDE.md ("Mock is the DEFAULT backend locally") - so this is not a
// synthetic shortcut, it is the same open-access path `npm run dev` takes. AuthGuard renders the app
// directly without a login wall, and BusinessContextGate's cloud-only gating (`isLiveAuth() &&
// isFirebaseBackend()`) is inert here too. IS_E2E=1 still forces the AI route to mock-only (never a live
// provider call) and TURSO_* are pinned empty so this can never open a real Turso connection.
export default defineConfig({
  testDir: "./e2e",
  testMatch: ["**/scan-sync-visibility.spec.ts"],
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3101",
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Deliberately `next dev` directly, NOT `npm run dev` / scripts/dev.mjs: that launcher's "mock" mode
    // unconditionally FORCES NEXT_PUBLIC_E2E_AUTH_BYPASS="1" into the child env (scripts/dev-environment.mjs
    // line ~22), overriding anything passed in here - which means `npm run dev` can never actually reach
    // the collapsed, non-bypass state a real user sees. Calling `next dev` directly gives us real control.
    command: "npx next dev --port 3101",
    url: "http://localhost:3101",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
    env: {
      ...process.env,
      IS_E2E: "1",
      NEXT_PUBLIC_FIREBASE_BACKEND: "0",
      NEXT_PUBLIC_FIREBASE_USE_EMULATOR: "0",
      TURSO_DATABASE_URL: "",
      TURSO_AUTH_TOKEN: "",
      // Explicitly forced OFF (not just "not set") in case a developer's own .env.local defines any of
      // these for other purposes - that absence/off-state is the entire point of this config.
      NEXT_PUBLIC_E2E_AUTH_BYPASS: "",
      NEXT_PUBLIC_E2E_PLATFORM_OWNER: "",
      NEXT_PUBLIC_AUTH_MODE: "",
      NEXT_PUBLIC_REQUIRE_LOGIN: "",
    },
  },
});
