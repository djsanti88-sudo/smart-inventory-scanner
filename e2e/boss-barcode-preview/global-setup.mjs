import { cleanupPreviewBossTenants, initializePreviewAdmin, seedPreviewBossTenants } from "./admin.mjs";
import { readPreviewCertificationConfig } from "./config.mjs";
import { writePreviewRunState } from "./state.mjs";

export default async function globalSetup() {
  const config = readPreviewCertificationConfig(process.env);
  const admin = await initializePreviewAdmin(config);
  let state = { manifest: null, cleanup: null };
  const persistManifest = async (manifest) => { state = { ...state, manifest }; writePreviewRunState(config.runId, state); };
  try {
    const manifest = await seedPreviewBossTenants(admin, { ...config, persistManifest });
    await persistManifest(manifest);
  } catch (error) {
    const manifest = error.previewManifest ?? state.manifest;
    if (manifest) {
      const cleanup = await cleanupPreviewBossTenants(admin, manifest);
      state = { manifest, cleanup }; writePreviewRunState(config.runId, state);
    }
    throw error;
  }
}
