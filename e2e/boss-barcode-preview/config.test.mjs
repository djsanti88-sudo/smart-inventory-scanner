import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  PREVIEW_FIREBASE_PROJECT_ID,
  buildPreviewChildEnv,
  readPreviewCertificationConfig,
} from "./config.mjs";

const base = () => ({
  BOSS_PREVIEW_URL: "https://inventory-preview-pr-123.vercel.app",
  BOSS_PREVIEW_DEPLOYMENT_URL: "https://inventory-preview-pr-123.vercel.app",
  BOSS_PREVIEW_DEPLOYMENT_METADATA_JSON: JSON.stringify({ url: "https://inventory-preview-pr-123.vercel.app", projectId: "prj_preview_expected", target: "preview" }),
  BOSS_PREVIEW_VERCEL_INSPECT_METADATA_JSON: JSON.stringify({ url: "https://inventory-preview-pr-123.vercel.app", projectId: "prj_preview_expected", target: "preview", readyState: "READY" }),
  BOSS_PREVIEW_PRODUCTION_HOST: "smart-inventory-scanner-app.vercel.app",
  BOSS_PREVIEW_FIREBASE_PROJECT_ID: PREVIEW_FIREBASE_PROJECT_ID,
  BOSS_PREVIEW_RUN_ID: "boss-preview-0123456789abcdef",
  VERCEL_AUTOMATION_BYPASS_SECRET: "test-only-bypass-secret",
  BOSS_PREVIEW_FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({ project_id: PREVIEW_FIREBASE_PROJECT_ID }),
});

const trustedLink = { linkedProjectId: "prj_preview_expected" };

test("accepts only an explicitly approved protected Vercel Preview target", () => {
  const config = readPreviewCertificationConfig(base(), trustedLink);
  assert.equal(config.baseURL, "https://inventory-preview-pr-123.vercel.app");
  assert.deepEqual(config.protectionHeaders, {
    "x-vercel-protection-bypass": "test-only-bypass-secret",
    "x-vercel-set-bypass-cookie": "true",
  });
  assert.equal(config.firebaseProjectId, PREVIEW_FIREBASE_PROJECT_ID);
});

test("an explicitly unprotected Preview sends no cross-origin bypass headers", () => {
  const env = base();
  env.VERCEL_AUTOMATION_BYPASS_SECRET = "not-required-unprotected-preview";
  assert.deepEqual(readPreviewCertificationConfig(env, trustedLink).protectionHeaders, {});
});

for (const [label, mutate] of [
  ["localhost", (env) => { env.BOSS_PREVIEW_URL = "http://localhost:3400"; }],
  ["non-root URL path", (env) => { env.BOSS_PREVIEW_URL = "https://inventory-preview-pr-123.vercel.app/scan"; }],
  ["non-Vercel host", (env) => { env.BOSS_PREVIEW_URL = "https://preview.example.test"; env.BOSS_PREVIEW_DEPLOYMENT_URL = "https://preview.example.test"; env.BOSS_PREVIEW_DEPLOYMENT_METADATA_JSON = JSON.stringify({ url: "https://preview.example.test", projectId: "prj_preview_expected", target: "preview" }); }],
  ["production-shaped host", (env) => { env.BOSS_PREVIEW_URL = "https://smart-inventory-scanner-app.vercel.app"; env.BOSS_PREVIEW_DEPLOYMENT_URL = env.BOSS_PREVIEW_URL; env.BOSS_PREVIEW_DEPLOYMENT_METADATA_JSON = JSON.stringify({ url: env.BOSS_PREVIEW_URL, projectId: "prj_preview_expected", target: "preview" }); }],
  ["declared production host", (env) => { env.BOSS_PREVIEW_PRODUCTION_HOST = "inventory-preview-pr-123.vercel.app"; }],
  ["URL credentials", (env) => { env.BOSS_PREVIEW_URL = "https://secret@inventory-preview-pr-123.vercel.app"; }],
  ["non-wrapper URL", (env) => { env.BOSS_PREVIEW_DEPLOYMENT_URL = "https://other-preview.vercel.app"; }],
  ["wrong wrapper project metadata", (env) => { env.BOSS_PREVIEW_DEPLOYMENT_METADATA_JSON = JSON.stringify({ url: env.BOSS_PREVIEW_URL, projectId: "prj_other", target: "preview" }); }],
  ["non-preview wrapper metadata", (env) => { env.BOSS_PREVIEW_DEPLOYMENT_METADATA_JSON = JSON.stringify({ url: env.BOSS_PREVIEW_URL, projectId: "prj_preview_expected", target: "production" }); }],
  ["unready independent Vercel inspect metadata", (env) => { env.BOSS_PREVIEW_VERCEL_INSPECT_METADATA_JSON = JSON.stringify({ url: env.BOSS_PREVIEW_URL, projectId: "prj_preview_expected", target: "preview", readyState: "BUILDING" }); }],
  ["wrong Firebase project", (env) => { env.BOSS_PREVIEW_FIREBASE_PROJECT_ID = "demo-smart-inventory"; }],
  ["missing Vercel bypass secret", (env) => { delete env.VERCEL_AUTOMATION_BYPASS_SECRET; }],
  ["invalid run id", (env) => { env.BOSS_PREVIEW_RUN_ID = "production"; }],
]) {
  test(`rejects ${label}`, () => {
    const env = base();
    mutate(env);
    assert.throws(() => readPreviewCertificationConfig(env, trustedLink), /preview certification/i);
  });
}

test("scrubs paid-provider and Turso variables from the Playwright child environment", () => {
  const child = buildPreviewChildEnv({
    ...base(), OPENAI_API_KEY: "must-not-inherit", GO_UPC_API_KEY: "must-not-inherit",
    TURSO_DATABASE_URL: "libsql://must-not-inherit", TURSO_AUTH_TOKEN: "must-not-inherit",
    FIRECRAWL_API_KEY: "must-not-inherit", BRAVE_SEARCH_API_KEY: "must-not-inherit",
  });
  for (const key of ["OPENAI_API_KEY", "GO_UPC_API_KEY", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN", "FIRECRAWL_API_KEY", "BRAVE_SEARCH_API_KEY"]) {
    assert.equal(child[key], "", `${key} must be blank in Preview certification`);
  }
  assert.equal(child.ENABLE_LIVE_AI_LOOKUP, "0");
  assert.equal(child.MASTER_CATALOG_APPEND, "0");
});

test("preserves ADC only when explicitly enabled, while still scrubbing providers and Turso", () => {
  const adcPath = "C:\\test-only\\application_default_credentials.json";
  const child = buildPreviewChildEnv({
    ...base(), BOSS_PREVIEW_FIREBASE_USE_ADC: "1", GOOGLE_APPLICATION_CREDENTIALS: adcPath,
    OPENAI_API_KEY: "must-not-inherit", TURSO_AUTH_TOKEN: "must-not-inherit",
  });
  assert.equal(child.BOSS_PREVIEW_FIREBASE_USE_ADC, "1");
  assert.equal(child.GOOGLE_APPLICATION_CREDENTIALS, adcPath);
  assert.equal(child.OPENAI_API_KEY, "");
  assert.equal(child.TURSO_AUTH_TOKEN, "");
  const disabled = buildPreviewChildEnv({ ...base(), GOOGLE_APPLICATION_CREDENTIALS: adcPath });
  assert.equal(disabled.BOSS_PREVIEW_FIREBASE_USE_ADC, "");
  assert.equal(disabled.GOOGLE_APPLICATION_CREDENTIALS, "");
});

for (const [label, mutate] of [
  ["ADC without explicit opt-in", (env) => { env.BOSS_PREVIEW_FIREBASE_SERVICE_ACCOUNT_JSON = ""; env.GOOGLE_APPLICATION_CREDENTIALS = "C:\\test-only\\adc.json"; }],
  ["ADC without credential path", (env) => { env.BOSS_PREVIEW_FIREBASE_SERVICE_ACCOUNT_JSON = ""; env.BOSS_PREVIEW_FIREBASE_USE_ADC = "1"; }],
  ["ADC with a wrong Preview project", (env) => { env.BOSS_PREVIEW_FIREBASE_SERVICE_ACCOUNT_JSON = ""; env.BOSS_PREVIEW_FIREBASE_USE_ADC = "1"; env.GOOGLE_APPLICATION_CREDENTIALS = "C:\\test-only\\adc.json"; env.BOSS_PREVIEW_FIREBASE_PROJECT_ID = "demo-smart-inventory"; }],
]) {
  test(`rejects ${label}`, () => {
    const env = base();
    mutate(env);
    assert.throws(() => readPreviewCertificationConfig(env, trustedLink), /preview certification/i);
  });
}

test("accepts explicit ADC only for the hardcoded Preview project", () => {
  const env = base();
  env.BOSS_PREVIEW_FIREBASE_SERVICE_ACCOUNT_JSON = "";
  env.BOSS_PREVIEW_FIREBASE_USE_ADC = "1";
  env.GOOGLE_APPLICATION_CREDENTIALS = "C:\\test-only\\application_default_credentials.json";
  const config = readPreviewCertificationConfig(env, trustedLink);
  assert.equal(config.firebaseCredentialMode, "adc");
  assert.equal(config.firebaseProjectId, PREVIEW_FIREBASE_PROJECT_ID);
});

test("rejects direct Preview config invocation with inherited paid-provider or Turso credentials", () => {
  const env = base(); env.OPENAI_API_KEY = "must-not-reach-preview-workers";
  assert.throws(() => readPreviewCertificationConfig(env, trustedLink), /OPENAI_API_KEY.*scrubbed/i);
  env.OPENAI_API_KEY = ""; env.TURSO_AUTH_TOKEN = "must-not-reach-preview-workers";
  assert.throws(() => readPreviewCertificationConfig(env, trustedLink), /TURSO_AUTH_TOKEN.*scrubbed/i);
});

test("rejects an arbitrary Preview even if every caller-supplied field agrees", () => {
  const env = base();
  const other = "https://other-preview-123.vercel.app";
  env.BOSS_PREVIEW_URL = other; env.BOSS_PREVIEW_DEPLOYMENT_URL = other;
  env.BOSS_PREVIEW_DEPLOYMENT_METADATA_JSON = JSON.stringify({ url: other, projectId: "prj_other", target: "preview" });
  env.BOSS_PREVIEW_VERCEL_INSPECT_METADATA_JSON = JSON.stringify({ url: other, projectId: "prj_other", target: "preview", readyState: "READY" });
  assert.throws(() => readPreviewCertificationConfig(env, trustedLink), /expected Vercel Preview project/i);
});

test("does not trust a caller supplied expected Vercel project id", () => {
  const env = base(); env.BOSS_PREVIEW_VERCEL_PROJECT_ID = "prj_other";
  assert.equal(readPreviewCertificationConfig(env, trustedLink).expectedVercelProjectId, "prj_preview_expected");
});

test("Preview Playwright config has protection headers and cannot launch localhost", () => {
  const config = readFileSync("playwright.boss-preview.config.mts", "utf8");
  const runner = readFileSync("e2e/boss-barcode-preview/run.mjs", "utf8");
  assert.match(config, /extraHTTPHeaders:\s*preview\.protectionHeaders/);
  // Cloud Preview certification runs all 20 isolated tenants together; each browser retains its
  // own bounded exact/persistence queues, keeping aggregate write pressure modest.
  assert.match(config, /workers:\s*20/);
  assert.doesNotMatch(config, /\bwebServer\s*:/);
  assert.doesNotMatch(config, /FIREBASE_EMULATOR_HOST|NEXT_PUBLIC_FIREBASE_USE_EMULATOR/);
  assert.match(runner, /env:\s*buildPreviewChildEnv\(env\)/);
  assert.match(runner, /buildVercelInspectInvocation/);
  assert.match(runner, /shell: false/);
});

test("cross-tenant denial is a direct API probe and never creates a scanner row", () => {
  const spec = readFileSync("e2e/boss-barcode-preview/boss-preview.spec.mts", "utf8");
  const negativeProof = spec.slice(spec.indexOf("const unauthenticated ="));
  assert.match(negativeProof, /const crossTenant = await page\.request\.post/);
  assert.match(negativeProof, /idToken: authenticatedExactIdToken/);
  assert.match(negativeProof, /businessId: foreignBusinessId/);
  assert.doesNotMatch(negativeProof, /page\.keyboard\.(?:insertText|press)/);
  assert.doesNotMatch(negativeProof, /page\.route\(/);
});

test("Preview browser proof retains the full total while bounding the feed and verifies final count settlement", () => {
  const spec = readFileSync("e2e/boss-barcode-preview/boss-preview.spec.mts", "utf8");
  assert.match(spec, /VISIBLE_FEED_LIMIT = 100/);
  assert.match(spec, /getByText\(`\$\{expectedEvents\} scans`, \{ exact: true \}\)/);
  assert.match(spec, /scan-feed-window/);
  assert.match(spec, /final-count-body/);
  assert.match(spec, /finalCountsVerified/);
  assert.match(spec, /CALIBRATION_SCANS_PER_LANE = 4/);
  assert.match(spec, /await expect\(page\.getByTestId\("scanner-input"\)\)\.toBeFocused\(\);/);
  assert.match(spec, /await page\.reload\(\);\s*await expect\(page\.getByTestId\("scanner-input"\)\)\.toBeFocused/);
});

test("Preview browser proof scopes feed badges and requires exact final-count verification labels", () => {
  const spec = readFileSync("e2e/boss-barcode-preview/boss-preview.spec.mts", "utf8");
  assert.match(spec, /document\.querySelectorAll\('\[data-testid="scan-feed-body"\] \[data-testid="decode-row-status"\]'\)/);
  assert.match(spec, /countStatuses\.length === countRows\.length/);
  assert.match(spec, /\^Verified match\$\/i/);
});
