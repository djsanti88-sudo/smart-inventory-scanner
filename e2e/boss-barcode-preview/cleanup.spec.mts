import { test, expect } from "@playwright/test";
import { cleanupPreviewBossTenants, initializePreviewAdmin } from "./admin.mjs";
import * as previewConfig from "./config.mjs";
import { readPreviewRunState, writePreviewRunState } from "./state.mjs";

test("removes only this Preview certification run's synthetic tenants", async ({}, testInfo) => {
  const config = previewConfig.readPreviewCertificationConfig(process.env); const state = readPreviewRunState(config.runId);
  const cleanup = await cleanupPreviewBossTenants(await initializePreviewAdmin(config), state.manifest);
  writePreviewRunState(config.runId, { ...state, cleanup });
  await testInfo.attach("boss-preview-cleanup", { contentType: "application/json", body: Buffer.from(JSON.stringify(cleanup)) });
  expect(cleanup.complete).toBe(true);
});
