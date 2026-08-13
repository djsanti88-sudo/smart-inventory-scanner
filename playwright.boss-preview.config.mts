import { defineConfig, devices } from "@playwright/test";
import { readPreviewCertificationConfig } from "./e2e/boss-barcode-preview/config.mjs";

const preview = readPreviewCertificationConfig(process.env);

export default defineConfig({
  testDir: "./e2e/boss-barcode-preview",
  testMatch: "**/*.spec.mts",
  timeout: 900_000,
  fullyParallel: true,
  // Cloud Preview runs all 20 isolated tenants together. Each browser retains bounded exact and
  // serial persistence queues, so aggregate pressure remains modest while wall time drops sharply.
  // There is intentionally no local web server: every lane exercises the attested deployment.
  workers: 20,
  reporter: [["list"], ["./e2e/boss-barcode-preview/reporter.mjs"]],
  outputDir: "outputs/boss-barcode-certification/playwright-preview-artifacts",
  globalSetup: "./e2e/boss-barcode-preview/global-setup.mjs",
  globalTeardown: "./e2e/boss-barcode-preview/global-teardown.mjs",
  use: {
    baseURL: preview.baseURL,
    extraHTTPHeaders: preview.protectionHeaders,
    screenshot: "off", trace: "off", video: "off",
  },
  projects: [
    { name: "preview-lanes", testMatch: "**/boss-preview.spec.mts", use: { ...devices["Desktop Chrome"] } },
  ],
  // Intentionally no `webServer`: a configured local server would invalidate Preview proof.
  metadata: { previewFirebaseProjectId: preview.firebaseProjectId, previewRunId: preview.runId },
});
