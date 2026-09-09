import { defineConfig, devices } from "@playwright/test";
import { localE2EWebServerEnv } from "./e2e/localWebServerEnv";

// Human-like QA bot suite (e2e/human-bots). Runs the REAL app through the browser and pastes scan codes
// into the scan input (no physical scanner needed). Mock/local backend (seed data + auth bypass) so the
// bots are deterministic and never touch the cloud. Screenshots are ON for every step (proof + the
// screenshots index). Pinned to port 3300 so it never collides with the mock (3100) or firebase (3200) runs.
//
// Honest scope note: auth bypass means a single test user, and role-based code-hiding is part of the
// Customer-role data protection is tracked in docs/BACKLOG.md, so the SecurityLeakBot reports current visibility
// truthfully (today every authenticated user can see codes) rather than pretending role gates exist.
export default defineConfig({
  testDir: "./e2e/human-bots",
  testIgnore: ["**/cloud/**"], // the live-cloud bots run via playwright.bots.cloud.config.ts (real login)
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { outputFolder: "reports/human-bots/playwright-report", open: "never" }], ["json", { outputFile: "reports/human-bots/latest/playwright-results.json" }]],
  use: {
    baseURL: "http://localhost:3300",
    screenshot: "on",
    trace: "on-first-retry",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev -- --port 3300",
    url: "http://localhost:3300",
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe",
    // Mock/local backend, AI route forced to mock, auth bypass on. Pinned so .env.local (a real-cloud
    // god-account config) can never flip these for the bot run.
    env: localE2EWebServerEnv("bots-3300", {
      NEXT_PUBLIC_E2E_AUTH_BYPASS: "1",
      NEXT_PUBLIC_FIREBASE_BACKEND: "0",
      NEXT_PUBLIC_FIREBASE_USE_EMULATOR: "0",
    }),
  },
});
