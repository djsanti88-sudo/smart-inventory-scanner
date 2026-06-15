// Cloud Loop 8 smoke: real Email/Password auth + tenant-isolation/role/audit proof against the REAL
// Firebase project (NOT the emulator). Reads ONLY the public NEXT_PUBLIC_FIREBASE_* config from
// .env.local (git-ignored). No service-account JSON; no Admin SDK. Self-cleaning + idempotent: a
// uniquely-named `loop8-biz-<ts>` per run; deletes what the rules allow at the end (auditLog is
// append-only by design, so that single test row is reported, not deleted).
//
// Each ACTOR runs in its OWN Firebase app + Firestore instance (created/torn down per session). This
// mirrors real separate clients and avoids the Web SDK's cross-auth cache/listener bleed (a doc denied
// while signed out as a non-member would otherwise stay denied in the shared instance after switching).
//
// Exit 0 = all assertions held; exit 1 = a security/auth assertion failed (printed).

import { readFileSync } from "node:fs";
import { initializeApp, deleteApp } from "firebase/app";
import {
  getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, deleteUser,
} from "firebase/auth";
import {
  getFirestore, doc, setDoc, getDoc, updateDoc, deleteDoc, collection, getDocs,
} from "firebase/firestore";

// ---- load public config from .env.local ----
const env = {};
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}
const cfg = {
  apiKey: env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.NEXT_PUBLIC_FIREBASE_APP_ID,
};
if (cfg.projectId !== "smart-inventory-scanner-app") {
  console.error(`Refusing to run: unexpected projectId ${cfg.projectId}`);
  process.exit(1);
}
if (process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  console.error("Refusing to run: emulator env is set; this smoke must hit REAL cloud.");
  process.exit(1);
}

const BIZ = `loop8-biz-${Date.now()}`;
const A = { email: "loop8-a@smoke.test", password: "Test1234!aA" };
const B = { email: "loop8-b@smoke.test", password: "Test1234!bB" };

let failures = 0;
let appSeq = 0;
function ok(name) { console.log(`  PASS  ${name}`); }
function bad(name, detail) { failures++; console.error(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`); }
async function expectAllow(name, fn) {
  try { await fn(); ok(name); } catch (e) { bad(name, `expected ALLOW but got ${e?.code || e?.message}`); }
}
async function expectDeny(name, fn) {
  try { await fn(); bad(name, "expected DENY but it SUCCEEDED"); }
  catch (e) {
    if ((e?.code || "").includes("permission-denied")) ok(name);
    else bad(name, `expected permission-denied but got ${e?.code || e?.message}`);
  }
}

// Run `fn(db, user)` in a FRESH, isolated Firebase app for the given user, then tear it down.
async function asUser(u, fn) {
  const app = initializeApp(cfg, `smoke-${appSeq++}`);
  const auth = getAuth(app);
  const db = getFirestore(app);
  let user;
  try { user = (await signInWithEmailAndPassword(auth, u.email, u.password)).user; }
  catch { user = (await createUserWithEmailAndPassword(auth, u.email, u.password)).user; }
  try { return await fn(db, user); }
  finally { await signOut(auth).catch(() => {}); await deleteApp(app).catch(() => {}); }
}

// Stable uids captured once (each user keeps its uid across fresh-app sessions).
let uidA, uidB;

async function run() {
  console.log(`Cloud smoke against project: ${cfg.projectId}\n`);

  // ---- A: bootstrap business + owner membership, write/read, audit append-only ----
  await asUser(A, async (db, a) => {
    uidA = a.uid;
    console.log(`[A] owner (uid ${a.uid.slice(0, 6)}...)`);
    await expectAllow("A creates business (createdBy=A)", () => setDoc(doc(db, "businesses", BIZ), { name: "Loop8 Co", createdBy: a.uid }));
    await expectAllow("A self-creates owner membership for the business A created", () => setDoc(doc(db, "businessMembers", `${BIZ}_${a.uid}`), { businessId: BIZ, userId: a.uid, role: "owner" }));
    await expectAllow("A writes a product (owner)", () => setDoc(doc(db, "businesses", BIZ, "products", "p1"), { businessId: BIZ, name: "Loop8 Widget", verified: true }));
    await expectAllow("A reads the product back", () => getDoc(doc(db, "businesses", BIZ, "products", "p1")));
    await expectAllow("A appends an audit event", () => setDoc(doc(db, "businesses", BIZ, "auditLog", "ev1"), { businessId: BIZ, action: "smoke_seed", actorUserId: a.uid }));
    await expectDeny("audit append-only: A cannot UPDATE an audit event", () => updateDoc(doc(db, "businesses", BIZ, "auditLog", "ev1"), { action: "tampered" }));
    await expectDeny("audit append-only: A cannot DELETE an audit event", () => deleteDoc(doc(db, "businesses", BIZ, "auditLog", "ev1")));
  });

  // ---- B: tenant isolation + the forge-membership vector (the hardened rule) ----
  await asUser(B, async (db, b) => {
    uidB = b.uid;
    console.log(`\n[B] non-member (uid ${b.uid.slice(0, 6)}...)`);
    await expectDeny("B cannot read Business A's product", () => getDoc(doc(db, "businesses", BIZ, "products", "p1")));
    await expectDeny("B cannot list Business A's products", () => getDocs(collection(db, "businesses", BIZ, "products")));
    await expectDeny("B cannot write into Business A", () => setDoc(doc(db, "businesses", BIZ, "products", "forged"), { businessId: BIZ, name: "forged" }));
    await expectDeny("B CANNOT FORGE an owner membership for Business A (createdBy=A)", () => setDoc(doc(db, "businessMembers", `${BIZ}_${b.uid}`), { businessId: BIZ, userId: b.uid, role: "owner" }));
    await expectDeny("B still cannot read Business A after the forge attempt", () => getDoc(doc(db, "businesses", BIZ, "products", "p1")));
  });

  // ---- A grants B 'counter' ----
  await asUser(A, async (db) => {
    console.log("\n[A] grants roles");
    await expectAllow("A (owner) adds B as a 'counter'", () => setDoc(doc(db, "businessMembers", `${BIZ}_${uidB}`), { businessId: BIZ, userId: uidB, role: "counter" }));
  });

  // ---- B as counter: read products; create scans/counts; cannot manage products ----
  await asUser(B, async (db) => {
    console.log("\n[B as counter]");
    await expectAllow("counter reads a product", () => getDoc(doc(db, "businesses", BIZ, "products", "p1")));
    await expectAllow("counter creates a scanEvent", () => setDoc(doc(db, "businesses", BIZ, "scanEvents", "se1"), { businessId: BIZ, cleanCode: "111" }));
    await expectAllow("counter creates an inventoryCount", () => setDoc(doc(db, "businesses", BIZ, "inventoryCounts", "se1_p1"), { businessId: BIZ, countSessionId: "s1", productId: "p1", countedQuantity: 1 }));
    await expectDeny("counter CANNOT create/manage products", () => setDoc(doc(db, "businesses", BIZ, "products", "p2"), { businessId: BIZ, name: "nope" }));
    await expectDeny("counter CANNOT delete a product", () => deleteDoc(doc(db, "businesses", BIZ, "products", "p1")));
  });

  // ---- A downgrades B to 'viewer' ----
  await asUser(A, async (db) => {
    await expectAllow("A (owner) changes B to 'viewer'", () => updateDoc(doc(db, "businessMembers", `${BIZ}_${uidB}`), { role: "viewer" }));
  });

  // ---- B as viewer: read-only ----
  await asUser(B, async (db) => {
    console.log("\n[B as viewer]");
    await expectAllow("viewer reads a product", () => getDoc(doc(db, "businesses", BIZ, "products", "p1")));
    await expectDeny("viewer CANNOT create a scanEvent", () => setDoc(doc(db, "businesses", BIZ, "scanEvents", "se2"), { businessId: BIZ, cleanCode: "222" }));
  });

  // ---- Cleanup as A (owner): delete subcollection docs + business doc + memberships. auditLog is
  //      append-only by design, so that single row is reported, not deleted. ----
  console.log("\n[cleanup]");
  await asUser(A, async (db) => {
    const del = async (label, ref) => { try { await deleteDoc(ref); console.log(`  cleaned ${label}`); } catch (e) { console.log(`  could not clean ${label}: ${e?.code || e?.message}`); } };
    await del("scanEvents/se1", doc(db, "businesses", BIZ, "scanEvents", "se1"));
    await del("inventoryCounts/se1_p1", doc(db, "businesses", BIZ, "inventoryCounts", "se1_p1"));
    await del("products/p1", doc(db, "businesses", BIZ, "products", "p1"));
    await del(`businesses/${BIZ}`, doc(db, "businesses", BIZ));
    await del(`members/${BIZ}_${uidB}`, doc(db, "businessMembers", `${BIZ}_${uidB}`));
    await del(`members/${BIZ}_${uidA}`, doc(db, "businessMembers", `${BIZ}_${uidA}`));
  });
  console.log(`  NOTE: businesses/${BIZ}/auditLog/ev1 remains (auditLog is append-only by rule). Clearly-named test data.`);

  // ---- Delete the test auth users (each in its own session) ----
  for (const u of [B, A]) {
    await asUser(u, async (_db, user) => { await deleteUser(user); console.log(`  deleted test user ${u.email}`); }).catch((e) => console.log(`  could not delete ${u.email}: ${e?.code || e?.message}`));
  }

  console.log(`\n${failures === 0 ? "CLOUD SMOKE PASSED" : `CLOUD SMOKE FAILED (${failures} failure(s))`}`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((e) => { console.error("Cloud smoke crashed:", e); process.exit(1); });
