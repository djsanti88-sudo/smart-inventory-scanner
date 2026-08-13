import { PREVIEW_LANES, previewBusinessId, previewEmail, previewPassword, previewUid } from "./fixtures.mjs";

function assertProject(admin, expectedProjectId) {
  if (!admin || admin.projectId !== expectedProjectId) throw new Error("Preview certification Admin target rejected: project mismatch.");
}

async function countDocumentTree(ref) {
  let total = (await ref.get()).exists ? 1 : 0;
  if (typeof ref.listCollections !== "function") throw new Error("Preview cleanup requires Firestore listCollections for recursive postcheck.");
  const collections = await ref.listCollections();
  for (const collection of collections) {
    const snapshot = await collection.get();
    for (const doc of snapshot.docs ?? []) total += await countDocumentTree(doc.ref);
  }
  return total;
}

export function createPreviewRunManifest(config) {
  return {
    schemaVersion: "1.0.0", runId: config.runId, firebaseProjectId: config.firebaseProjectId,
    tenants: Array.from({ length: PREVIEW_LANES }, (_, lane) => ({
      lane, businessId: previewBusinessId(config.runId, lane), uid: previewUid(config.runId, lane), email: previewEmail(config.runId, lane), phase: "planned",
    })),
  };
}

export async function seedPreviewBossTenants(admin, config) {
  assertProject(admin, config.firebaseProjectId);
  const manifest = createPreviewRunManifest(config);
  const checkpoint = async () => { await config.persistManifest?.(manifest); };
  await checkpoint();
  try {
    for (const tenant of manifest.tenants) {
      const existing = await admin.db.doc(`businesses/${tenant.businessId}`).get();
      if (existing.exists) throw new Error("Preview certification seed refused an existing business ID.");
      try { await admin.auth.getUser(tenant.uid); throw new Error("Preview certification seed refused an existing user ID."); }
      catch (error) { if (error?.code !== "auth/user-not-found") throw error; }
      tenant.phase = "creating_user"; await checkpoint();
      await admin.auth.createUser({ uid: tenant.uid, email: tenant.email, password: previewPassword });
      tenant.phase = "user_created"; await checkpoint();
      await admin.db.doc(`businesses/${tenant.businessId}`).set({ name: `Synthetic Preview certification ${tenant.lane}`, certificationRunId: config.runId, createdBy: tenant.uid });
      tenant.phase = "business_created"; await checkpoint();
      await admin.db.doc(`businessMembers/${tenant.businessId}_${tenant.uid}`).set({ businessId: tenant.businessId, userId: tenant.uid, role: "owner", certificationRunId: config.runId });
      tenant.phase = "seeded"; await checkpoint();
    }
  } catch (error) {
    error.previewManifest = manifest;
    throw error;
  }
  return manifest;
}

export async function cleanupPreviewBossTenants(admin, manifest) {
  assertProject(admin, manifest.firebaseProjectId);
  if (typeof admin.db.recursiveDelete !== "function") throw new Error("Preview cleanup requires Firestore recursiveDelete; refusing an incomplete descendant cleanup.");
  const cleanupTenant = async (tenant) => {
    let deleted = 0; let expectedDeleted = 0;
    if (tenant.phase === "planned" || tenant.phase === "creating_user") return { expectedDeleted, deleted };
    if (tenant.phase === "user_created") {
      const user = await admin.auth.getUser(tenant.uid);
      if (user.email !== tenant.email) throw new Error("Preview certification cleanup rejected an unowned Auth user.");
      await admin.auth.deleteUser(tenant.uid); expectedDeleted++; deleted++;
      return { expectedDeleted, deleted };
    }
    const businessRef = admin.db.doc(`businesses/${tenant.businessId}`);
    const memberRef = admin.db.doc(`businessMembers/${tenant.businessId}_${tenant.uid}`);
    const [business, member] = await Promise.all([businessRef.get(), memberRef.get()]);
    let user = null;
    try { user = await admin.auth.getUser(tenant.uid); } catch (error) { if (error?.code !== "auth/user-not-found") throw error; }
    let ownershipEvidence = false;
    if (business.exists) {
      if (business.data()?.certificationRunId !== manifest.runId) throw new Error("Preview certification cleanup rejected an unowned business path.");
      ownershipEvidence = true;
    }
    if (member.exists) {
      if (member.data()?.certificationRunId !== manifest.runId) throw new Error("Preview certification cleanup rejected an unowned member path.");
      ownershipEvidence = true;
    }
    if (user) {
      if (user.email !== tenant.email) throw new Error("Preview certification cleanup rejected an unowned Auth user.");
      ownershipEvidence = true;
    }
    // recursiveDelete is anchored to the marker-owned business root and removes arbitrary
    // descendant collections, including newly added application collections. Treat the owned tree
    // as one atomic cleanup target: prewalking every scan document just to count it makes a 20-lane
    // cleanup issue tens of thousands of listCollections RPCs before deletion. The postcheck below
    // still recursively proves that the root and every descendant are absent.
    if (ownershipEvidence) {
      expectedDeleted++;
      await admin.db.recursiveDelete(businessRef);
      deleted++;
    }
    if (member.exists) {
      expectedDeleted++; await member.ref.delete(); deleted++;
    }
    if (user) { await admin.auth.deleteUser(tenant.uid); expectedDeleted++; deleted++; }
    return { expectedDeleted, deleted };
  };
  const cleanupResults = await Promise.all(manifest.tenants.map((tenant) => cleanupTenant(tenant)));
  const expectedDeleted = cleanupResults.reduce((sum, result) => sum + (result?.expectedDeleted ?? 0), 0);
  const deleted = cleanupResults.reduce((sum, result) => sum + (result?.deleted ?? 0), 0);
  const postcheckResults = await Promise.all(manifest.tenants.map(async (tenant) => {
    if (tenant.phase === "planned" || tenant.phase === "creating_user") return 0;
    const businessRef = admin.db.doc(`businesses/${tenant.businessId}`);
    // List descendants after deletion: deleting a Firestore parent alone leaves orphaned
    // subcollections, so this cannot be replaced by a parent existence check.
    let remaining = await countDocumentTree(businessRef);
    if ((await admin.db.doc(`businessMembers/${tenant.businessId}_${tenant.uid}`).get()).exists) remaining++;
    try { await admin.auth.getUser(tenant.uid); remaining++; } catch (error) { if (error?.code !== "auth/user-not-found") throw error; }
    return remaining;
  }));
  const postcheckRemaining = postcheckResults.reduce((sum, value) => sum + (value ?? 0), 0);
  return { attempted: true, complete: deleted === expectedDeleted && postcheckRemaining === 0, expectedDeleted, deleted, postcheckRemaining };
}

export async function initializePreviewAdmin(config, injectedSdk = undefined) {
  if (!config || config.firebaseProjectId !== "smart-inventory-preview") {
    throw new Error("Preview certification Admin target rejected: project mismatch.");
  }
  const rawCredential = process.env.BOSS_PREVIEW_FIREBASE_SERVICE_ACCOUNT_JSON;
  const hasServiceAccount = typeof rawCredential === "string" && rawCredential.trim().length > 0;
  let serviceAccount;
  if (hasServiceAccount) {
    serviceAccount = JSON.parse(rawCredential);
    if (serviceAccount.project_id !== config.firebaseProjectId) throw new Error("Preview certification Admin credential project mismatch.");
  } else {
    if (config.firebaseCredentialMode !== "adc" || process.env.BOSS_PREVIEW_FIREBASE_USE_ADC !== "1") {
      throw new Error("Preview certification Admin ADC is not explicitly enabled.");
    }
    if (typeof process.env.GOOGLE_APPLICATION_CREDENTIALS !== "string" || process.env.GOOGLE_APPLICATION_CREDENTIALS.trim() === "") {
      throw new Error("Preview certification Admin ADC requires GOOGLE_APPLICATION_CREDENTIALS.");
    }
  }
  const sdk = injectedSdk ?? {
    appSdk: await import("firebase-admin/app"), authSdk: await import("firebase-admin/auth"), firestoreSdk: await import("firebase-admin/firestore"),
  };
  const credential = serviceAccount ? sdk.appSdk.cert(serviceAccount) : sdk.appSdk.applicationDefault();
  const name = `boss-preview-${config.runId}`;
  const app = sdk.appSdk.getApps().find((item) => item.name === name) ?? sdk.appSdk.initializeApp({ credential, projectId: config.firebaseProjectId }, name);
  return { projectId: app.options.projectId, db: sdk.firestoreSdk.getFirestore(app), auth: sdk.authSdk.getAuth(app) };
}
