import { defineConfig, devices } from "@playwright/test";

// E2E proof config. Pins port 3100 so the dev server and Playwright never disagree
// (the #1 source of Windows flakiness). Proof screenshots are written explicitly by the
// spec in e2e/scan.spec.ts to e2e/proof/.
export default defineConfig({
  testDir: "./e2e",
  // The Firebase-backed specs live in e2e/firebase-phase2 and run via playwright.firebase.config.ts
  // (real Firebase backend + emulator). Keep them OUT of the mock run so the 11 mock specs stay isolated.
  testIgnore: ["**/firebase-phase2/**", "**/human-bots/**"],
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:3100",
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev -- --port 3100",
    url: "http://localhost:3100",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
    // TEST SAFETY: force the AI route to mock-only so E2E can never call live Gemini/OpenAI.
    // NEXT_PUBLIC_E2E_AUTH_BYPASS enables the client auth bypass for E2E only (impossible in production -
    // see src/services/auth/authBypass.ts). This keeps specs auth-independent of a live Supabase.
    // Pin the LOCAL/mock backend explicitly so this suite is independent of whatever .env.local holds
    // (e.g. a real-cloud god-account config). Otherwise the scan page renders the Firebase
    // business-context gate instead of the scanner input.
    // NEXT_PUBLIC_E2E_PLATFORM_OWNER=1: the legacy 11 mock specs exercise the FULL platformOwner view
    // (raw codes, AI status, all exports). The human-bot suite does NOT set this, so it runs as a customer.
    env: { ...process.env, IS_E2E: "1", NEXT_PUBLIC_E2E_AUTH_BYPASS: "1", NEXT_PUBLIC_FIREBASE_BACKEND: "0", NEXT_PUBLIC_FIREBASE_USE_EMULATOR: "0", NEXT_PUBLIC_E2E_PLATFORM_OWNER: "1" },
  },
});
