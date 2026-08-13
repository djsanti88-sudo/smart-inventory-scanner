import assert from "node:assert/strict";
import test from "node:test";
import { cleanupPreviewBossTenants, createPreviewRunManifest, initializePreviewAdmin, seedPreviewBossTenants } from "./admin.mjs";

function fakeAdmin(options = {}) {
  const documents = new Map(); const users = new Map(); const writes = [];
  const doc = (path) => {
    const ref = { path, delete: async () => documents.delete(path), listCollections: async () => [...new Set([...documents.keys()].filter((key) => key.startsWith(`${path}/`)).map((key) => key.split("/")[path.split("/").length]))].map((name) => collection(`${path}/${name}`)) };
    ref.get = async () => ({ exists: documents.has(path), data: () => documents.get(path), ref });
    return { path, get: ref.get, set: async (value) => { if (options.failMemberSet && path.startsWith("businessMembers/")) throw new Error("member write failed"); documents.set(path, value); }, delete: ref.delete, listCollections: ref.listCollections, ref };
  };
  const collection = (path) => ({ get: async () => ({ docs: [...documents].filter(([key]) => key.startsWith(`${path}/`) && key.split("/").length === path.split("/").length + 1).map(([key, value]) => ({ ref: doc(key).ref, data: () => value })) }) });
  const batch = () => ({ delete: (ref) => writes.push(ref.path), commit: async () => writes.splice(0).forEach((path) => { if (!options.retainPath || path !== options.retainPath) documents.delete(path); }) });
  return {
    projectId: "smart-inventory-preview", writes, users,
    db: { doc, collection, batch, recursiveDelete: async (ref) => { for (const key of [...documents.keys()]) if ((key === ref.path || key.startsWith(`${ref.path}/`)) && key !== options.retainPath) documents.delete(key); } },
    auth: { getUser: async (uid) => { const user = users.get(uid); if (!user) { const error = new Error("missing"); error.code = "auth/user-not-found"; throw error; } return user; }, createUser: async (user) => users.set(user.uid, user), deleteUser: async (uid) => users.delete(uid) },
  };
}

const config = { runId: "boss-preview-0123456789abcdef", firebaseProjectId: "smart-inventory-preview" };
test("ADC initialization is explicitly Preview-scoped and uses applicationDefault", async () => {
  const originalFlag = process.env.BOSS_PREVIEW_FIREBASE_USE_ADC;
  const originalPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const calls = [];
  const appSdk = {
    getApps: () => [],
    applicationDefault: () => ({ kind: "adc" }),
    cert: () => { throw new Error("service-account path must not run for ADC"); },
    initializeApp: (options, name) => { calls.push({ options, name }); return { name, options }; },
  };
  try {
    process.env.BOSS_PREVIEW_FIREBASE_USE_ADC = "1";
    process.env.GOOGLE_APPLICATION_CREDENTIALS = "C:\\test-only\\application_default_credentials.json";
    const admin = await initializePreviewAdmin({ ...config, firebaseCredentialMode: "adc" }, {
      appSdk, authSdk: { getAuth: () => ({}) }, firestoreSdk: { getFirestore: () => ({}) },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.projectId, "smart-inventory-preview");
    assert.deepEqual(calls[0].options.credential, { kind: "adc" });
    assert.equal(admin.projectId, "smart-inventory-preview");
  } finally {
    if (originalFlag === undefined) delete process.env.BOSS_PREVIEW_FIREBASE_USE_ADC; else process.env.BOSS_PREVIEW_FIREBASE_USE_ADC = originalFlag;
    if (originalPath === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS; else process.env.GOOGLE_APPLICATION_CREDENTIALS = originalPath;
  }
});

test("ADC initialization rejects missing opt-in/path and every non-Preview project", async () => {
  const originalFlag = process.env.BOSS_PREVIEW_FIREBASE_USE_ADC;
  const originalPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  try {
    delete process.env.BOSS_PREVIEW_FIREBASE_USE_ADC; process.env.GOOGLE_APPLICATION_CREDENTIALS = "C:\\test-only\\adc.json";
    await assert.rejects(() => initializePreviewAdmin({ ...config, firebaseCredentialMode: "adc" }), /ADC/i);
    process.env.BOSS_PREVIEW_FIREBASE_USE_ADC = "1"; delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    await assert.rejects(() => initializePreviewAdmin({ ...config, firebaseCredentialMode: "adc" }), /GOOGLE_APPLICATION_CREDENTIALS/i);
    process.env.GOOGLE_APPLICATION_CREDENTIALS = "C:\\test-only\\adc.json";
    await assert.rejects(() => initializePreviewAdmin({ ...config, firebaseProjectId: "demo-smart-inventory", firebaseCredentialMode: "adc" }), /project mismatch/i);
  } finally {
    if (originalFlag === undefined) delete process.env.BOSS_PREVIEW_FIREBASE_USE_ADC; else process.env.BOSS_PREVIEW_FIREBASE_USE_ADC = originalFlag;
    if (originalPath === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS; else process.env.GOOGLE_APPLICATION_CREDENTIALS = originalPath;
  }
});
test("seed/cleanup touch only recorded marker-owned synthetic Preview paths", async () => {
  const admin = fakeAdmin(); const manifest = await seedPreviewBossTenants(admin, config);
  admin.db.doc(`businesses/${manifest.tenants[0].businessId}/scanEvents/e1`).set({ value: 1 });
  const result = await cleanupPreviewBossTenants(admin, manifest);
  assert.equal(manifest.tenants.length, 20); assert.equal(result.complete, true); assert.equal(result.postcheckRemaining, 0); assert.equal(admin.users.size, 0);
});
test("cleanup is idempotent after an interrupted caller retries a fully removed tenant", async () => {
  const admin = fakeAdmin(); const manifest = await seedPreviewBossTenants(admin, config);
  assert.equal((await cleanupPreviewBossTenants(admin, manifest)).complete, true);
  const retry = await cleanupPreviewBossTenants(admin, manifest);
  assert.equal(retry.complete, true); assert.equal(retry.postcheckRemaining, 0);
});
test("seed and cleanup reject wrong projects and missing ownership markers before writes", async () => {
  const wrong = fakeAdmin(); wrong.projectId = "demo-smart-inventory";
  await assert.rejects(() => seedPreviewBossTenants(wrong, config), /project mismatch/i);
  const admin = fakeAdmin(); const manifest = createPreviewRunManifest(config);
  manifest.tenants[0].phase = "business_created";
  await admin.db.doc(`businesses/${manifest.tenants[0].businessId}`).set({});
  await assert.rejects(() => cleanupPreviewBossTenants(admin, manifest), /unowned/i);
});
test("partial seed checkpoints before each mutation and can compensate a failed member write", async () => {
  const admin = fakeAdmin({ failMemberSet: true }); const checkpoints = []; let partial;
  await assert.rejects(() => seedPreviewBossTenants(admin, { ...config, persistManifest: async (manifest) => checkpoints.push(JSON.parse(JSON.stringify(manifest)))}), (error) => { partial = error.previewManifest; return /member write failed/i.test(error.message); });
  assert.equal(partial.tenants[0].phase, "business_created");
  assert.equal(checkpoints.some((manifest) => manifest.tenants[0].phase === "user_created"), true);
  const cleanup = await cleanupPreviewBossTenants(admin, partial);
  assert.equal(cleanup.complete, true); assert.equal(admin.users.size, 0);
});
test("cleanup postcheck fails closed when an allowlisted tenant subcollection remains after parent deletion", async () => {
  const retainedPath = `businesses/${config.runId}-lane-00/settings/retained`;
  const admin = fakeAdmin({ retainPath: retainedPath }); const manifest = await seedPreviewBossTenants(admin, config);
  await admin.db.doc(retainedPath).set({ certificationRunId: config.runId });
  const cleanup = await cleanupPreviewBossTenants(admin, manifest);
  assert.equal(cleanup.complete, false); assert.equal(cleanup.postcheckRemaining, 1);
});
test("cleanup recursively removes an unknown descendant collection and proves it absent", async () => {
  const admin = fakeAdmin(); const manifest = await seedPreviewBossTenants(admin, config);
  const root = `businesses/${manifest.tenants[0].businessId}`;
  await admin.db.doc(`${root}/futureCollection/futureDoc/nested/leaf`).set({ certificationRunId: config.runId });
  const cleanup = await cleanupPreviewBossTenants(admin, manifest);
  assert.equal(cleanup.complete, true); assert.equal(cleanup.postcheckRemaining, 0);
});
