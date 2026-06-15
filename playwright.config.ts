import { defineConfig, devices } from "@playwright/test";

// E2E proof config. Pins port 3100 so the dev server and Playwright never disagree
// (the #1 source of Windows flakiness). Proof screenshots are written explicitly by the
// spec in e2e/scan.spec.ts to e2e/proof/.
export default defineConfig({
  testDir: "./e2e",
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
    env: { ...process.env, IS_E2E: "1" },
  },
});
