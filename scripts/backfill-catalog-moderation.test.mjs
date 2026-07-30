import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Emulator-backed integration proof for scripts/backfill-catalog-moderation.mjs (L4 deep-review
// flagged this as the top coverage gap: zero automated tests for the --execute path, batching,
// idempotency, and the project guard). The script is a one-time migration of legacy
// disputedBy/auditLog fields off the public catalogEntries/retailCatalogEntries parent docs into the
// locked catalogEntries/{id}/moderation/log subcollection (see catalogModeration.rules.test.ts for the
// rules-locking half of this feature).
//
// This test runs the script as a REAL child process (like scripts/release-sentinel.test.mjs and
// scripts/deploy-preview.test.mjs do for their CLIs) against the REAL Firestore emulator - not a mock.
// No production data, no paid calls, no source-file edits were needed for testability.
//
// Self-skips under plain `npm run test` the same way src/services/db/firebase/*.rules.test.ts do,
// gated on FIRESTORE_EMULATOR_HOST. Run for real with:
//   npx firebase emulators:exec --project demo-inv-backfill-catalog-mod --only firestore \
//     "npx vitest run scripts/backfill-catalog-moderation.test.mjs"
// (or any `firebase emulators:exec ... --only firestore "<vitest invocation covering this file>"` -
// the emulator itself is project-agnostic; PROJECT_ID below just needs to match what this file's own
// Admin SDK connection and the spawned script's connection both use, so they see the same documents.)

const HOSTPORT = process.env.FIRESTORE_EMULATOR_HOST || "";
const ready = HOSTPORT.includes(":");

const SCRIPT_PATH = fileURLToPath(new URL("./backfill-catalog-moderation.mjs", import.meta.url));
// Dedicated demo project namespace, isolated from other emulator-backed suites that might share the
// same running emulator instance (mirrors the "unique projectId per test file" convention used by the
// src/services/db/firebase/*.rules.test.ts files).
const PROJECT_ID = "demo-inv-backfill-catalog-mod";

/** Run the real script binary as a subprocess. Mirrors release-sentinel.test.mjs / deploy-preview.test.mjs. */
function runScript(args = [], envOverride = {}) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...envOverride },
  });
}

/** Same as runScript, but with every Firebase emulator/credential env var stripped first - used only
 * by the project-guard tests, which must prove the script refuses when it has neither an emulator host
 * nor usable credentials, even though the *test process* itself is running inside an emulator-wrapped
 * invocation (FIRESTORE_EMULATOR_HOST is set on process.env for this whole file). */
function runScriptWithoutFirebaseEnv(args = [], envOverride = {}) {
  const env = { ...process.env };
  delete env.FIRESTORE_EMULATOR_HOST;
  delete env.FIREBASE_AUTH_EMULATOR_HOST;
  delete env.FIREBASE_SERVICE_ACCOUNT_JSON;
  delete env.FIREBASE_SERVICE_ACCOUNT_PATH;
  delete env.GOOGLE_APPLICATION_CREDENTIALS;
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    encoding: "utf8",
    env: { ...env, ...envOverride },
  });
}

/** The script's stdout is one console.log("Connected to...") line, then a single JSON.stringify(report,
 * null, 2) block, then a plain-text summary line. No other braces appear in the output, so slicing from
 * the first "{" to the last "}" reliably isolates the report. */
function extractReport(stdout) {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  return JSON.parse(stdout.slice(start, end + 1));
}

describe.skipIf(!ready)("scripts/backfill-catalog-moderation (Firestore emulator)", () => {
  let db;
  const tmpDirs = [];

  beforeAll(async () => {
    const { initializeApp, getApps } = await import("firebase-admin/app");
    const { getFirestore } = await import("firebase-admin/firestore");
    if (!getApps().length) initializeApp({ projectId: PROJECT_ID });
    db = getFirestore();
  });

  afterAll(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // Full recursive wipe (parents + moderation subcollections) between tests, isolated per test.
    await db.recursiveDelete(db.collection("catalogEntries"));
    await db.recursiveDelete(db.collection("retailCatalogEntries"));
  });

  function tmpSaFile(name, content) {
    const dir = mkdtempSync(join(tmpdir(), "backfill-catalog-mod-test-"));
    tmpDirs.push(dir);
    const file = join(dir, name);
    writeFileSync(file, JSON.stringify(content));
    return file;
  }

  async function seedLegacy(id, { disputedBy, auditLog, extra = {} } = {}) {
    await db.collection("catalogEntries").doc(id).set({
      normalizedBarcode: id,
      brand: "TestBrand",
      ...extra,
      ...(disputedBy !== undefined ? { disputedBy } : {}),
      ...(auditLog !== undefined ? { auditLog } : {}),
    });
  }

  // --- 1. --dry-run (default, bare invocation) reports counts and writes NOTHING ---------------------

  it("bare invocation (default dry-run) reports legacy counts and leaves docs completely untouched", async () => {
    await seedLegacy("gtin_dry1", {
      disputedBy: [{ businessId: "biz1", at: "2026-07-29T00:00:00.000Z" }],
      auditLog: [{ action: "disputed", by: "biz1", at: "2026-07-29T00:00:00.000Z", reason: "wrong size" }],
    });
    const before = (await db.collection("catalogEntries").doc("gtin_dry1").get()).data();

    const result = runScript([], { FIREBASE_PROJECT_ID: PROJECT_ID });
    expect(result.status).toBe(0);

    const report = extractReport(result.stdout);
    expect(report.mode).toBe("DRY-RUN");
    expect(report.collections.catalogEntries.legacyDocsFound).toBe(1);
    expect(report.collections.catalogEntries.migrated).toBeUndefined(); // never set on dry-run
    expect(result.stdout).toMatch(/DRY-RUN: no writes performed/);

    const after = (await db.collection("catalogEntries").doc("gtin_dry1").get()).data();
    expect(after).toEqual(before); // byte-for-byte unchanged, including disputedBy/auditLog still present

    const modSnap = await db.collection("catalogEntries").doc("gtin_dry1").collection("moderation").doc("log").get();
    expect(modSnap.exists).toBe(false); // no moderation subdoc was created
  });

  it("--dry-run flag explicitly also writes nothing (same as bare invocation)", async () => {
    await seedLegacy("gtin_dry2", { disputedBy: [{ businessId: "biz1", at: "t" }], auditLog: [{ action: "disputed", by: "biz1", at: "t" }] });
    const result = runScript(["--dry-run"], { FIREBASE_PROJECT_ID: PROJECT_ID });
    expect(result.status).toBe(0);
    const report = extractReport(result.stdout);
    expect(report.mode).toBe("DRY-RUN");
    const modSnap = await db.collection("catalogEntries").doc("gtin_dry2").collection("moderation").doc("log").get();
    expect(modSnap.exists).toBe(false);
  });

  // --- 2. --execute migrates legacy disputedBy/auditLog into moderation/log and deletes from parent ---

  it("--execute migrates a legacy doc's disputedBy/auditLog into moderation/log and strips them from the parent", async () => {
    await seedLegacy("gtin_exec1", {
      disputedBy: [{ businessId: "biz1", at: "2026-07-29T00:00:00.000Z" }],
      auditLog: [{ action: "disputed", by: "biz1", at: "2026-07-29T00:00:00.000Z", reason: "wrong size" }],
    });

    const result = runScript(["--execute"], { FIREBASE_PROJECT_ID: PROJECT_ID });
    expect(result.status).toBe(0);
    const report = extractReport(result.stdout);
    expect(report.mode).toBe("EXECUTE");
    expect(report.collections.catalogEntries.migrated).toBe(1);
    expect(result.stdout).toMatch(/EXECUTE complete/);

    const parentData = (await db.collection("catalogEntries").doc("gtin_exec1").get()).data();
    expect(parentData.disputedBy).toBeUndefined();
    expect(parentData.auditLog).toBeUndefined();
    expect(parentData.brand).toBe("TestBrand"); // unrelated fields untouched

    const modSnap = await db.collection("catalogEntries").doc("gtin_exec1").collection("moderation").doc("log").get();
    expect(modSnap.exists).toBe(true);
    expect(modSnap.data().disputedBy).toEqual([{ businessId: "biz1", at: "2026-07-29T00:00:00.000Z" }]);
    expect(modSnap.data().auditLog).toEqual([{ action: "disputed", by: "biz1", at: "2026-07-29T00:00:00.000Z", reason: "wrong size" }]);
  });

  // --- 3. Idempotency: a second --execute finds 0 legacy docs and makes NO writes ----------------------

  it("a second --execute run is a true no-op: 0 legacy docs found, and Firestore updateTimes are unchanged", async () => {
    await seedLegacy("gtin_idem1", {
      disputedBy: [{ businessId: "biz1", at: "t1" }],
      auditLog: [{ action: "disputed", by: "biz1", at: "t1" }],
    });
    const first = runScript(["--execute"], { FIREBASE_PROJECT_ID: PROJECT_ID });
    expect(first.status).toBe(0);
    expect(extractReport(first.stdout).collections.catalogEntries.migrated).toBe(1);

    const parentRef = db.collection("catalogEntries").doc("gtin_idem1");
    const modRef = parentRef.collection("moderation").doc("log");
    const parentBefore = await parentRef.get();
    const modBefore = await modRef.get();

    const second = runScript(["--execute"], { FIREBASE_PROJECT_ID: PROJECT_ID });
    expect(second.status).toBe(0);
    const report = extractReport(second.stdout);
    expect(report.collections.catalogEntries.legacyDocsFound).toBe(0);
    expect(report.collections.catalogEntries.migrated).toBe(0);
    expect(report.collections.retailCatalogEntries.legacyDocsFound).toBe(0);
    expect(report.collections.retailCatalogEntries.migrated).toBe(0);

    // Definitive "no writes happened" proof: Firestore bumps updateTime on ANY write, even a no-op
    // merge with identical content, so an unchanged updateTime proves the batch never touched these docs.
    const parentAfter = await parentRef.get();
    const modAfter = await modRef.get();
    expect(parentAfter.updateTime.isEqual(parentBefore.updateTime)).toBe(true);
    expect(modAfter.updateTime.isEqual(modBefore.updateTime)).toBe(true);
  });

  // --- 4. Mixed set: clean doc untouched, legacy doc migrated, pre-existing moderation data deduped ---

  it("mixed set: a clean doc is untouched, a legacy doc migrates, and pre-existing moderation data is merged without doubling a businessId", async () => {
    // Clean doc: no legacy fields at all.
    await db.collection("catalogEntries").doc("clean1").set({ normalizedBarcode: "clean1", brand: "CleanBrand", verificationStatus: "verified" });

    // Legacy doc, no pre-existing moderation subdoc.
    await seedLegacy("legacy1", {
      disputedBy: [{ businessId: "bizA", at: "t1" }],
      auditLog: [{ action: "disputed", by: "bizA", at: "t1", reason: "r1" }],
    });

    // Doc with BOTH a legacy parent field AND pre-existing moderation data for the SAME businessId
    // (bizA) plus a NEW businessId (bizB) only on the legacy parent side.
    await seedLegacy("merge1", {
      disputedBy: [{ businessId: "bizA", at: "t2" }, { businessId: "bizB", at: "t3" }],
      auditLog: [{ action: "disputed", by: "bizA", at: "t2", reason: "r2" }],
    });
    await db.collection("catalogEntries").doc("merge1").collection("moderation").doc("log").set({
      disputedBy: [{ businessId: "bizA", at: "t0" }],
      auditLog: [{ action: "disputed", by: "bizA", at: "t0", reason: "r0" }],
    });

    const result = runScript(["--execute"], { FIREBASE_PROJECT_ID: PROJECT_ID });
    expect(result.status).toBe(0);
    const report = extractReport(result.stdout);
    expect(report.collections.catalogEntries.migrated).toBe(2); // legacy1 + merge1, never clean1
    expect(report.collections.retailCatalogEntries.migrated).toBe(0);

    // Clean doc: byte-for-byte untouched, no moderation subdoc ever created.
    const cleanData = (await db.collection("catalogEntries").doc("clean1").get()).data();
    expect(cleanData).toEqual({ normalizedBarcode: "clean1", brand: "CleanBrand", verificationStatus: "verified" });
    const cleanModSnap = await db.collection("catalogEntries").doc("clean1").collection("moderation").doc("log").get();
    expect(cleanModSnap.exists).toBe(false);

    // legacy1: straightforward migration.
    const legacyParent = (await db.collection("catalogEntries").doc("legacy1").get()).data();
    expect(legacyParent.disputedBy).toBeUndefined();
    expect(legacyParent.auditLog).toBeUndefined();
    const legacyMod = (await db.collection("catalogEntries").doc("legacy1").collection("moderation").doc("log").get()).data();
    expect(legacyMod.disputedBy).toEqual([{ businessId: "bizA", at: "t1" }]);

    // merge1: bizA is NOT doubled (existing moderation entry wins over the legacy duplicate), bizB is added.
    const mergeParent = (await db.collection("catalogEntries").doc("merge1").get()).data();
    expect(mergeParent.disputedBy).toBeUndefined();
    expect(mergeParent.auditLog).toBeUndefined();
    const mergeMod = (await db.collection("catalogEntries").doc("merge1").collection("moderation").doc("log").get()).data();
    expect(mergeMod.disputedBy).toHaveLength(2);
    expect(mergeMod.disputedBy.filter((d) => d.businessId === "bizA")).toHaveLength(1); // never doubled
    expect(mergeMod.disputedBy.find((d) => d.businessId === "bizA").at).toBe("t0"); // existing entry wins
    expect(mergeMod.disputedBy.find((d) => d.businessId === "bizB")).toBeTruthy(); // new legacy business folded in
    expect(mergeMod.auditLog).toEqual([
      { action: "disputed", by: "bizA", at: "t2", reason: "r2" }, // legacy entries first
      { action: "disputed", by: "bizA", at: "t0", reason: "r0" }, // then existing moderation entries
    ]);
  });

  // --- 5. Batching boundary: > 400 legacy docs (MAX_WRITES_PER_BATCH) crosses more than one batch -----

  it(
    "seeding 450 legacy docs (over the 400-writes-per-batch cap, at 2 writes/doc) migrates every single one across multiple batch commits",
    async () => {
      const N = 450; // > 400: forces migrateCollection's flush() to fire mid-loop, not just once at the end.
      const batch = db.batch();
      for (let i = 0; i < N; i++) {
        const ref = db.collection("catalogEntries").doc(`batch_${i}`);
        batch.set(ref, {
          normalizedBarcode: `batch_${i}`,
          disputedBy: [{ businessId: `biz_${i}`, at: "t" }],
          auditLog: [{ action: "disputed", by: `biz_${i}`, at: "t", reason: "bulk" }],
        });
      }
      await batch.commit();

      const result = runScript(["--execute"], { FIREBASE_PROJECT_ID: PROJECT_ID });
      expect(result.status).toBe(0);
      const report = extractReport(result.stdout);
      expect(report.collections.catalogEntries.scanned).toBe(N);
      expect(report.collections.catalogEntries.legacyDocsFound).toBe(N);
      expect(report.collections.catalogEntries.migrated).toBe(N); // every doc migrated, no batch dropped

      const allParents = await db.collection("catalogEntries").get();
      expect(allParents.size).toBe(N);
      expect(allParents.docs.every((d) => d.data().disputedBy === undefined && d.data().auditLog === undefined)).toBe(true);

      const allModeration = await db.collectionGroup("moderation").get();
      expect(allModeration.size).toBe(N); // one moderation/log subdoc created per migrated doc
    },
    60000,
  );

  // --- 6. Project guard: wrong project / missing creds and no emulator host -> refuses, touches nothing

  it("with no emulator host and no credentials of any kind, the script dies before touching Firestore", async () => {
    await seedLegacy("guard_untouched1", { disputedBy: [{ businessId: "biz1", at: "t" }], auditLog: [{ action: "disputed", by: "biz1", at: "t" }] });
    const before = (await db.collection("catalogEntries").doc("guard_untouched1").get()).data();

    const result = runScriptWithoutFirebaseEnv(["--execute"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/BLOCKER: credentials required/);

    const after = (await db.collection("catalogEntries").doc("guard_untouched1").get()).data();
    expect(after).toEqual(before); // untouched: the process never reached Firestore at all
  });

  it("with a service account whose project_id does not match EXPECTED_PROJECT, the script refuses rather than connecting", async () => {
    await seedLegacy("guard_untouched2", { disputedBy: [{ businessId: "biz1", at: "t" }], auditLog: [{ action: "disputed", by: "biz1", at: "t" }] });
    const before = (await db.collection("catalogEntries").doc("guard_untouched2").get()).data();

    const saPath = tmpSaFile("fake-sa.json", {
      project_id: "totally-different-project",
      private_key: "FAKE-NOT-A-REAL-KEY",
      client_email: "fake@totally-different-project.iam.gserviceaccount.com",
    });

    const result = runScriptWithoutFirebaseEnv(["--execute", "--sa", saPath]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/BLOCKER: service account project_id is not smart-inventory-scanner-app \(refusing to touch the wrong project\)/);

    const after = (await db.collection("catalogEntries").doc("guard_untouched2").get()).data();
    expect(after).toEqual(before); // untouched: died on the project_id check, before cert()/initializeApp()
  });
});
