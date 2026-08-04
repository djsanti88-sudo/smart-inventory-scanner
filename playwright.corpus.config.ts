import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";
const scrubbed = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:NEXT_PUBLIC_)?(?:OPENAI|GO_?UPC|FIRECRAWL|BRAVE|GEMINI|GOOGLE|TURSO)(?:_|$)/i.test(key)));
const source = process.env.BOSS_RECONCILIATION_PATH;
if (!source) throw new Error("BOSS_RECONCILIATION_PATH is required for local corpus UI proof.");
export default defineConfig({
  testDir: "./e2e/boss-barcode-corpus", testMatch: "**/*.spec.ts", timeout: 180_000, workers: 1,
  reporter: [["list"], ["./e2e/boss-barcode-corpus/reporter.mjs"]], globalSetup: "./e2e/boss-barcode-corpus/global-setup.ts",
  use: { ...devices["Desktop Chrome"], baseURL: "http://localhost:3400", screenshot: "only-on-failure", trace: "retain-on-failure" },
  webServer: { command: "node e2e/boss-barcode-corpus/production-server.mjs", url: "http://localhost:3400", reuseExistingServer: false, timeout: 300_000,
    // IS_E2E must remain 0: the route's real token+membership branch is the thing being certified.
    // Provider/Turso credentials are scrubbed independently, so this still cannot escape localhost.
    env: { ...scrubbed, BOSS_RECONCILIATION_PATH: resolve(source), BOSS_CORPUS_PORT: "3400" } },
});
