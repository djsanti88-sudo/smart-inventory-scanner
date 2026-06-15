import { defineConfig, devices } from "@playwright/test";

// Firebase-backed E2E proof (Loop 7). SEPARATE from the 11 mock specs (playwright.config.ts) - this runs
// the app against the Firebase EMULATOR with the real Firebase backend + real Auth emulator sign-in.
// Run it via `npm run test:e2e:firebase`, which wraps this in `firebase emulators:exec` so the emulator
// is up for both the seed (globalSetup) and the dev server. Distinct port (3200) so it never collides
// with the mock run's 3100. NO auth bypass: the spec signs in through the real login UI.
export default defineConfig({
  testDir: "./e2e/firebase-phase2",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  globalSetup: "./e2e/firebase-phase2/global-setup.ts",
  use: {
    baseURL: "http://localhost:3200",
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev -- --port 3200",
    url: "http://localhost:3200",
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      // Real Firebase backend against the emulator. Auth bypass is intentionally NOT set, so the spec
      // exercises the real login UI and Firestore writes carry a real request.auth.
      NEXT_PUBLIC_FIREBASE_BACKEND: "1",
      NEXT_PUBLIC_FIREBASE_USE_EMULATOR: "1",
      NEXT_PUBLIC_FIREBASE_PROJECT_ID: "demo-smart-inventory",
      // Keep AI mock-only so the run can never call live providers.
      IS_E2E: "1",
    },
  },
});
