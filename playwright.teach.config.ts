import { defineConfig, devices } from "@playwright/test";

// Teach Bot PERMANENT regression config. Runs the approved regression tests in
// testing/tests/permanent against the LIVE deployed app (no local webServer).
//
// SEPARATE from playwright.config.ts on purpose: the main mock suite (testDir ./e2e,
// port 3100, IS_E2E mock backend) must stay green and must never pull in live-app tests.
// Candidate tests in testing/tests/candidates are intentionally NOT a testDir here - they
// are untrusted until promoted into testing/tests/permanent by owner-approved review.
//
// Target URL comes from TEACH_TARGET_URL (defaults to production). There is NO webServer:
// these tests drive the real deployment, so a live run is owner-triggered, never automatic.
const TARGET = process.env.TEACH_TARGET_URL ?? "https://inventory-lovat-six.vercel.app";

export default defineConfig({
  testDir: "./testing/tests/permanent",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { open: "never", outputFolder: "testing/artifacts/_html-report" }]],
  use: {
    baseURL: TARGET,
    headless: false,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
