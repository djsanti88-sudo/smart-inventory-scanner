import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import nextEnv from "@next/env";
import {
  buildLocalDemoEnvironment,
  LOCAL_DEMO_DENIED_ENV_KEYS,
} from "./local-demo-environment.mjs";

test("local demo scrubs every external service and pins local-only mode", () => {
  const env = buildLocalDemoEnvironment({
    TURSO_DATABASE_URL: "libsql://example",
    TURSO_AUTH_TOKEN: "secret",
    OPENAI_API_KEY: "secret",
    GO_UPC_API_KEY: "secret",
    BRAVE_SEARCH_API_KEY: "secret",
    FIRECRAWL_API_KEY: "secret",
    FIREBASE_SERVICE_ACCOUNT_JSON_BASE64: "secret",
    FIREBASE_SERVICE_ACCOUNT_PATH: "C:/secret.json",
    NEXT_PUBLIC_CLOUD_CATALOG: "1",
    NEXT_PUBLIC_FIREBASE_ALLOW_PROD: "1",
    NEXT_PUBLIC_AUTH_MODE: "live",
    NEXT_PUBLIC_REQUIRE_LOGIN: "1",
  });
  assert.equal(env.SCANBIN_LOCAL_DEMO, "1");
  assert.equal(env.NEXT_PUBLIC_LOCAL_DEMO, "1");
  assert.equal(env.NEXT_PUBLIC_FIREBASE_BACKEND, "0");
  assert.equal(env.NEXT_PUBLIC_FIREBASE_USE_EMULATOR, "0");
  assert.equal(env.NEXT_PUBLIC_AUTH_MODE, "mock");
  assert.equal(env.NEXT_PUBLIC_REQUIRE_LOGIN, "0");
  assert.equal(env.NEXT_PUBLIC_E2E_AUTH_BYPASS, "");
  assert.equal(env.ENABLE_LIVE_AI_LOOKUP, "false");
  assert.equal(env.ENABLE_AUTO_DECODE_ON_SCAN, "true");
  assert.equal(env.NEXT_TELEMETRY_DISABLED, "1");
  for (const key of LOCAL_DEMO_DENIED_ENV_KEYS) assert.equal(env[key], "");
  for (let index = 1; index <= 10; index += 1) {
    assert.equal(env[`FIRECRAWL_API_KEY_${index}`], "");
  }
});

test("Next production env loading cannot repopulate hostile .env.local secrets", () => {
  const directory = mkdtempSync(join(tmpdir(), "scanbin-local-env-"));
  const savedEnvironment = { ...process.env };
  try {
    writeFileSync(
      join(directory, ".env.local"),
      LOCAL_DEMO_DENIED_ENV_KEYS.map((key) => `${key}=hostile-secret`).join("\n"),
    );
    const safe = buildLocalDemoEnvironment({ NODE_ENV: "production" });
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, safe);
    nextEnv.resetEnv();
    nextEnv.updateInitialEnv(safe);
    nextEnv.loadEnvConfig(directory, false, console, true, () => {});
    for (const key of LOCAL_DEMO_DENIED_ENV_KEYS) assert.equal(process.env[key], "");
    assert.equal(process.env.NEXT_PUBLIC_AUTH_MODE, "mock");
    assert.equal(process.env.NEXT_PUBLIC_E2E_AUTH_BYPASS, "");
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnvironment);
    nextEnv.resetEnv();
    nextEnv.updateInitialEnv(savedEnvironment);
    rmSync(directory, { recursive: true, force: true });
  }
});
