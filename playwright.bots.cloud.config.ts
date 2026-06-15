import { defineConfig, devices } from "@playwright/test";

// CLOUD human-bot config — validates the REAL god account (the data Santiago actually uses), not seed
// fixtures. This is the gap that let the Falken/Camel leak through: the mock bots tested clean seed data.
// Real Firebase cloud backend (NEXT_PUBLIC_FIREBASE_BACKEND=1, emulator OFF), NO auth bypass (real login).
// IS_E2E=1 only forces the AI route to mock so the bot never spends live AI tokens; it does NOT bypass auth.
//
// Requires creds in env: GOD_EMAIL, GOD_PASSWORD (and optional GOD_BUSINESS_ID). Run with:
//   GOD_EMAIL=... GOD_PASSWORD=... npm run qa:bots:live
// Stop any other `next dev` first (Next allows one dev server per project dir).
export default defineConfig({
  testDir: "./e2e/human-bots/cloud",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["json", { outputFile: "reports/human-bots/latest/cloud-playwright-results.json" }]],
  use: { baseURL: "http://localhost:3300", screenshot: "on", trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev -- --port 3300",
    url: "http://localhost:3300",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
    // Real cloud backend, real login (NO auth bypass), AI route mocked (no live spend).
    env: { ...process.env, IS_E2E: "1", NEXT_PUBLIC_FIREBASE_BACKEND: "1", NEXT_PUBLIC_FIREBASE_USE_EMULATOR: "0" },
  },
});
