import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";
const scrubbed = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:NEXT_PUBLIC_)?(?:OPENAI|GO_?UPC|FIRECRAWL|BRAVE|GEMINI|GOOGLE|TURSO)(?:_|$)/i.test(key)));
const source = process.env.BOSS_RECONCILIATION_PATH;
if (!source) throw new Error("BOSS_RECONCILIATION_PATH is required for local corpus UI proof.");
export default defineConfig({
  testDir: "./e2e/boss-barcode-corpus", testMatch: "**/*.spec.ts", timeout: 180_000, workers: 1,
  reporter: [["list"], ["./e2e/boss-barcode-corpus/reporter.mjs"]], globalSetup: "./e2e/boss-barcode-corpus/global-setup.ts",
  use: { ...devices["Desktop Chrome"], baseURL: "http://localhost:3400", screenshot: "only-on-failure", trace: "retain-on-failure" },
  webServer: { command: "npm.cmd run dev:emulator -- --webpack --port 3400", url: "http://localhost:3400", reuseExistingServer: false, timeout: 180_000,
    // IS_E2E must remain 0: the route's real token+membership branch is the thing being certified.
    // Provider/Turso credentials are scrubbed independently, so this still cannot escape localhost.
    env: { ...scrubbed, BOSS_RECONCILIATION_PATH: resolve(source), NEXT_PUBLIC_FIREBASE_BACKEND: "1", NEXT_PUBLIC_FIREBASE_USE_EMULATOR: "1", NEXT_PUBLIC_FIREBASE_PROJECT_ID: "demo-smart-inventory", NEXT_PUBLIC_AUTH_MODE: "live", IS_E2E: "0", NEXT_PUBLIC_E2E_AUTH_BYPASS: "0", TRUSTED_EXACT_BOSS_BUSINESS_IDS: "local-corpus-certification", ENABLE_LIVE_AI_LOOKUP: "0", MASTER_CATALOG_APPEND: "0", OPENAI_API_KEY: "", GO_UPC_API_KEY: "", GOUPC_API_KEY: "", FIRECRAWL_API_KEY: "", BRAVE_SEARCH_API_KEY: "", GEMINI_API_KEY: "", GOOGLE_API_KEY: "", TURSO_DATABASE_URL: "", TURSO_AUTH_TOKEN: "" } },
});
