import { describe, it, beforeAll, afterAll, beforeEach } from "vitest";
import { initializeTestEnvironment, assertFails, assertSucceeds, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, getDoc, getDocs, collection, setDoc, updateDoc, deleteDoc } from "firebase/firestore";
import { readFileSync } from "node:fs";

// REAL tenant-isolation proof against the Firestore emulator using the production firestore.rules. All
// assertions run as AUTHENTICATED users (User A / User B); the Admin path (withSecurityRulesDisabled) is
// used ONLY to seed. Business data lives in subcollections /businesses/{bid}/... . Runs only when the
// emulator is up (npm run test:firebase sets FIRESTORE_EMULATOR_HOST); plain vitest skips.

const HOSTPORT = process.env.FIRESTORE_EMULATOR_HOST || "";
const ready = HOSTPORT.includes(":");

const A = "userA";
const B = "userB";
const BIZ_A = "bizA";
const BIZ_B = "bizB";
// subcollection doc path helper: /businesses/{bid}/{name}/{id}
const sub = (bid: string, name: string, id: string) => ["businesses", bid, name, id] as const;

describe.skipIf(!ready)("Firestore rules - tenant isolation (authenticated users)", () => {
  let env: RulesTestEnvironment;

  beforeAll(async () => {
    const [host, port] = HOSTPORT.split(":");
    // Unique projectId per test file -> isolated emulator namespace (no cross-file clearFirestore races).
    env = await initializeTestEnvironment({
      projectId: "demo-inv-isolation",
      firestore: { rules: readFileSync("firestore.rules", "utf8"), host, port: Number(port) },
    });
  });

  afterAll(async () => {
    if (env) await env.cleanup();
  });

  beforeEach(async () => {
    await env.clearFirestore();
    // SEED ONLY with rules disabled (admin). No assertions here.
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "businesses", BIZ_A), { name: "A", createdBy: A });
      await setDoc(doc(db, "businesses", BIZ_B), { name: "B", createdBy: B });
      await setDoc(doc(db, "businessMembers", `${BIZ_A}_${A}`), { businessId: BIZ_A, userId: A, role: "owner" });
      await setDoc(doc(db, "businessMembers", `${BIZ_B}_${B}`), { businessId: BIZ_B, userId: B, role: "owner" });
      await setDoc(doc(db, ...sub(BIZ_A, "products", "pA")), { businessId: BIZ_A, name: "A Widget" });
      await setDoc(doc(db, ...sub(BIZ_A, "aliases", "aA")), { businessId: BIZ_A, productId: "pA", cleanCode: "111" });
      await setDoc(doc(db, ...sub(BIZ_A, "scanEvents", "sA")), { businessId: BIZ_A, cleanCode: "111" });
      await setDoc(doc(db, ...sub(BIZ_A, "unknownCodeReviews", "rA")), { businessId: BIZ_A, cleanCode: "999" });
      await setDoc(doc(db, ...sub(BIZ_A, "settings", "setA")), { businessId: BIZ_A });
      await setDoc(doc(db, ...sub(BIZ_A, "auditLog", "auA")), { businessId: BIZ_A, action: "seed" });
      await setDoc(doc(db, "catalogEntries", "c1"), { normalizedBarcode: "111" });
      await setDoc(doc(db, "retailCatalogEntries", "r1"), { normalizedBarcode: "333" });
    });
  });

  const aDb = () => env.authenticatedContext(A).firestore();
  const bDb = () => env.authenticatedContext(B).firestore();

  it("bootstrap: a signed-in user can create their own business + owner membership", async () => {
    const db = env.authenticatedContext("newUser").firestore();
    await assertSucceeds(setDoc(doc(db, "businesses", "bizNew"), { name: "New", createdBy: "newUser" }));
    await assertSucceeds(setDoc(doc(db, "businessMembers", "bizNew_newUser"), { businessId: "bizNew", userId: "newUser", role: "owner" }));
  });

  it("(a) User A reads (get + list) and writes Business A data", async () => {
    await assertSucceeds(getDoc(doc(aDb(), ...sub(BIZ_A, "products", "pA"))));
    await assertSucceeds(getDocs(collection(aDb(), "businesses", BIZ_A, "products")));
    await assertSucceeds(setDoc(doc(aDb(), ...sub(BIZ_A, "products", "pA2")), { businessId: BIZ_A, name: "A Widget 2" }));
    await assertSucceeds(updateDoc(doc(aDb(), ...sub(BIZ_A, "products", "pA")), { name: "A Widget v2" }));
  });

  it("(b) User B CANNOT read Business A products/aliases/scanEvents/reviews/settings/audit (get or list)", async () => {
    await assertFails(getDoc(doc(bDb(), ...sub(BIZ_A, "products", "pA"))));
    await assertFails(getDocs(collection(bDb(), "businesses", BIZ_A, "products")));
    await assertFails(getDoc(doc(bDb(), ...sub(BIZ_A, "aliases", "aA"))));
    await assertFails(getDoc(doc(bDb(), ...sub(BIZ_A, "scanEvents", "sA"))));
    await assertFails(getDoc(doc(bDb(), ...sub(BIZ_A, "unknownCodeReviews", "rA"))));
    await assertFails(getDoc(doc(bDb(), ...sub(BIZ_A, "settings", "setA"))));
    await assertFails(getDoc(doc(bDb(), ...sub(BIZ_A, "auditLog", "auA"))));
  });

  it("(b2) User B CANNOT forge an owner membership for Business A (bootstrap tied to the business creator)", async () => {
    // The self-owner bootstrap is allowed ONLY for a business the requester created (bizA.createdBy = A).
    // Without this, B could grant itself owner of bizA and read A's data - a tenant-isolation breach.
    await assertFails(setDoc(doc(bDb(), "businessMembers", `${BIZ_A}_${B}`), { businessId: BIZ_A, userId: B, role: "owner" }));
    // Also cannot self-create owner membership for a business that does not exist.
    await assertFails(setDoc(doc(bDb(), "businessMembers", `bizGhost_${B}`), { businessId: "bizGhost", userId: B, role: "owner" }));
  });

  it("(c) User B CANNOT insert into Business A (forged tenant write blocked by path membership)", async () => {
    await assertFails(setDoc(doc(bDb(), ...sub(BIZ_A, "products", "forgedP")), { businessId: BIZ_A, name: "forged" }));
    await assertFails(setDoc(doc(bDb(), ...sub(BIZ_A, "scanEvents", "forgedS")), { businessId: BIZ_A, cleanCode: "x" }));
    await assertFails(setDoc(doc(bDb(), ...sub(BIZ_A, "auditLog", "forgedAu")), { businessId: BIZ_A, action: "x" }));
  });

  it("(d) User B CANNOT update Business A documents", async () => {
    await assertFails(updateDoc(doc(bDb(), ...sub(BIZ_A, "products", "pA")), { name: "hacked-by-B" }));
    await assertFails(updateDoc(doc(bDb(), ...sub(BIZ_A, "settings", "setA")), { dailyCap: 999 }));
  });

  it("(e) User B CANNOT delete Business A documents", async () => {
    await assertFails(deleteDoc(doc(bDb(), ...sub(BIZ_A, "products", "pA"))));
    await assertFails(deleteDoc(doc(bDb(), ...sub(BIZ_A, "aliases", "aA"))));
  });

  it("auditLog is append-only (member may create; nobody may update/delete)", async () => {
    await assertSucceeds(setDoc(doc(aDb(), ...sub(BIZ_A, "auditLog", "auA2")), { businessId: BIZ_A, action: "login" }));
    await assertFails(updateDoc(doc(aDb(), ...sub(BIZ_A, "auditLog", "auA")), { action: "tamper" }));
    await assertFails(deleteDoc(doc(aDb(), ...sub(BIZ_A, "auditLog", "auA"))));
  });

  it("catalogEntries: any signed-in user reads; client writes are denied (server-only)", async () => {
    await assertSucceeds(getDoc(doc(bDb(), "catalogEntries", "c1")));
    await assertFails(setDoc(doc(bDb(), "catalogEntries", "c2"), { normalizedBarcode: "222" }));
  });

  it("retailCatalogEntries: signed-in read allowed; create/update/delete all denied client-side", async () => {
    await assertSucceeds(getDoc(doc(bDb(), "retailCatalogEntries", "r1")));
    await assertFails(setDoc(doc(bDb(), "retailCatalogEntries", "r2"), { normalizedBarcode: "222" }));
    await assertFails(updateDoc(doc(bDb(), "retailCatalogEntries", "r1"), { productName: "tampered" }));
    await assertFails(deleteDoc(doc(bDb(), "retailCatalogEntries", "r1")));
  });

  it("catalogEntries: even a business OWNER cannot write/update/delete the master append surface", async () => {
    // userA owns BIZ_A - tenant authority must confer ZERO master-store authority (invariant #4).
    await assertFails(setDoc(doc(aDb(), "catalogEntries", "c2"), { provenanceTier: "ladder_verified_strong" }));
    await assertFails(updateDoc(doc(aDb(), "catalogEntries", "c1"), { provenanceTier: "corpus_verified" }));
    await assertFails(deleteDoc(doc(aDb(), "catalogEntries", "c1")));
  });

  it("userProfiles: a user reads/writes only their own", async () => {
    await assertSucceeds(setDoc(doc(aDb(), "userProfiles", A), { authUserId: A, email: "a@test.local" }));
    await assertFails(getDoc(doc(bDb(), "userProfiles", A)));
    await assertFails(setDoc(doc(bDb(), "userProfiles", A), { authUserId: A, email: "hacked" }));
  });
});
