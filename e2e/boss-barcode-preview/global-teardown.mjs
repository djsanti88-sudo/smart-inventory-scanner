import { cleanupPreviewBossTenants, initializePreviewAdmin } from "./admin.mjs";
import { readPreviewCertificationConfig } from "./config.mjs";
import { readPreviewRunState, writePreviewRunState } from "./state.mjs";

export default async function globalTeardown() {
  const config = readPreviewCertificationConfig(process.env); const state = readPreviewRunState(config.runId);
  if (state.cleanup?.complete) return;
  const cleanup = await cleanupPreviewBossTenants(await initializePreviewAdmin(config), state.manifest);
  writePreviewRunState(config.runId, { ...state, cleanup });
  if (!cleanup.complete) throw new Error("Preview certification emergency cleanup did not reach zero postcheck.");
}
