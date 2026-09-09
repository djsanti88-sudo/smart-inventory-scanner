import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, getDoc, getDocs, setDoc, collection, collectionGroup, type Firestore } from "firebase/firestore";
import { readFileSync } from "node:fs";

// M1 spec 1 (catalogEntries public-read leak): disputedBy/auditLog carry raw businessId + free-text
// dispute reasons. The parent catalogEntries/{id} doc is intentionally PUBLIC read (sanitized catalog
// fields only - barcode/brand/model/size), but Firestore rules cannot filter fields on a get/list, so
// those two fields must live in a locked moderation subcollection instead, with allow read, write: if
// false (server-only via Admin SDK, which bypasses rules entirely).
//
// Proof: (a) the public parent doc read still succeeds and never carries disputedBy/auditLog once the
// write paths stop writing them there; (b) neither an unauthenticated client NOR an authenticated but
// unrelated business can read the moderation/{docId} subcollection. Emulator only.

const HOSTPORT = process.env.FIRESTORE_EMULATOR_HOST || "";
const ready = HOSTPORT.includes(":");
const ENTRY_ID = "gtin_00012345678905";

describe.skipIf(!ready)("catalogEntries moderation subcollection is locked (emulator)", () => {
  let env: RulesTestEnvironment;

  beforeAll(async () => {
    const [host, port] = HOSTPORT.split(":");
    env = await initializeTestEnvironment({
      projectId: "demo-inv-catalog-moderation",
      firestore: { rules: readFileSync("firestore.rules", "utf8"), host, port: Number(port) },
    });
  });
  afterAll(async () => {
    if (env) await env.cleanup();
  });
  beforeEach(async () => {
    await env.clearFirestore();
    // Seed as the Admin SDK would (security rules disabled) - mirrors how catalogDispute.ts /
    // catalog-review/[id]/route.ts actually write in production (Admin SDK bypasses rules).
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "catalogEntries", ENTRY_ID), {
        normalizedBarcode: "00012345678905",
        brand: "Michelin",
        name: "Defender T+H",
        verificationStatus: "disputed",
        disputeCount: 1,
      });
      await setDoc(doc(db, "catalogEntries", ENTRY_ID, "moderation", "log"), {
        disputedBy: [{ businessId: "biz-secret-shop", at: "2026-07-29T00:00:00.000Z" }],
        auditLog: [{ at: "2026-07-29T00:00:00.000Z", action: "disputed", by: "biz-secret-shop", reason: "wrong tire brand entirely" }],
      });
    });
  });

  it("an unauthenticated client can read the public parent doc but never sees disputedBy/auditLog", async () => {
    const anon = env.unauthenticatedContext().firestore() as unknown as Firestore;
    const snap = await getDoc(doc(anon, "catalogEntries", ENTRY_ID));
    expect(snap.exists()).toBe(true);
    const data = snap.data() ?? {};
    expect(data.brand).toBe("Michelin");
    expect(data.disputeCount).toBe(1);
    expect(data).not.toHaveProperty("disputedBy");
    expect(data).not.toHaveProperty("auditLog");
  });

  it("an unauthenticated client CANNOT read the moderation/log subcollection doc", async () => {
    const anon = env.unauthenticatedContext().firestore() as unknown as Firestore;
    await expect(getDoc(doc(anon, "catalogEntries", ENTRY_ID, "moderation", "log"))).rejects.toBeTruthy();
  });

  it("an authenticated, unrelated-business client CANNOT read the moderation/log subcollection doc either", async () => {
    const stranger = env.authenticatedContext("stranger-uid").firestore() as unknown as Firestore;
    await expect(getDoc(doc(stranger, "catalogEntries", ENTRY_ID, "moderation", "log"))).rejects.toBeTruthy();
  });

  it("no client can write to the moderation/log subcollection doc (server-only via Admin SDK)", async () => {
    const stranger = env.authenticatedContext("stranger-uid").firestore() as unknown as Firestore;
    await expect(
      setDoc(doc(stranger, "catalogEntries", ENTRY_ID, "moderation", "log"), { disputedBy: [] }),
    ).rejects.toBeTruthy();
  });

  // Deep-review fix 4 (proof-gap closure): the direct-doc-read/write cases above prove `get`/`set`
  // are denied, but Firestore rules evaluate `list` and `collectionGroup` queries as a SEPARATE
  // request type - a rule that only guards `get` would leave a query-based path open. The rules file
  // has no `match /{path=**}/moderation/{docId}` wildcard granting collectionGroup access, and the
  // catch-all `match /{document=**} { allow read, write: if false; }` denies anything unmatched, so
  // both an anonymous client's collectionGroup("moderation") query and a direct list on the
  // subcollection must fail closed the same way the single-doc reads do.
  it("an unauthenticated client CANNOT collectionGroup-query across every moderation subcollection", async () => {
    const anon = env.unauthenticatedContext().firestore() as unknown as Firestore;
    await expect(getDocs(collectionGroup(anon, "moderation"))).rejects.toBeTruthy();
  });

  it("an authenticated, unrelated-business client CANNOT collectionGroup-query across every moderation subcollection either", async () => {
    const stranger = env.authenticatedContext("stranger-uid").firestore() as unknown as Firestore;
    await expect(getDocs(collectionGroup(stranger, "moderation"))).rejects.toBeTruthy();
  });

  it("an unauthenticated client CANNOT list (getDocs) the moderation subcollection directly", async () => {
    const anon = env.unauthenticatedContext().firestore() as unknown as Firestore;
    await expect(getDocs(collection(anon, "catalogEntries", ENTRY_ID, "moderation"))).rejects.toBeTruthy();
  });

  it("an authenticated, unrelated-business client CANNOT list (getDocs) the moderation subcollection directly either", async () => {
    const stranger = env.authenticatedContext("stranger-uid").firestore() as unknown as Firestore;
    await expect(getDocs(collection(stranger, "catalogEntries", ENTRY_ID, "moderation"))).rejects.toBeTruthy();
  });

  it("retailCatalogEntries carries the identical locked moderation shape", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "retailCatalogEntries", ENTRY_ID), { normalizedBarcode: "00012345678905" });
      await setDoc(doc(db, "retailCatalogEntries", ENTRY_ID, "moderation", "log"), { disputedBy: [{ businessId: "biz-x", at: "t" }] });
    });
    const anon = env.unauthenticatedContext().firestore() as unknown as Firestore;
    const parentSnap = await getDoc(doc(anon, "retailCatalogEntries", ENTRY_ID));
    expect(parentSnap.exists()).toBe(true);
    await expect(getDoc(doc(anon, "retailCatalogEntries", ENTRY_ID, "moderation", "log"))).rejects.toBeTruthy();
  });
});
