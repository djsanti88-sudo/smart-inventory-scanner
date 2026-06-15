import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, type Firestore } from "firebase/firestore";
import { readFileSync } from "node:fs";
import { FirebaseSyncTarget } from "@/services/db/firebase/firebaseSyncTarget";
import type { PendingSyncItem } from "@/types";

// Loop 1 proof: FirebaseSyncTarget.apply() is transaction-safe -> NO DOUBLE COUNT, even under CONCURRENT
// retries. reset() is guarded (throws against real cloud). Runs only with the Firestore emulator
// (npm run test:firebase); plain vitest skips.

const HOSTPORT = process.env.FIRESTORE_EMULATOR_HOST || "";
const ready = HOSTPORT.includes(":");
const UID = "syncUser";
const BIZ = "bizSync";
const SID = "s1";
const PID = "p1";

function incItem(key: string, scanEventId: string, delta: number): PendingSyncItem {
  return {
    id: scanEventId,
    businessId: BIZ,
    sessionId: SID,
    entityType: "InventoryCount",
    entityId: `${SID}_${PID}`,
    operation: "INCREMENT_COUNT",
    payload: { businessId: BIZ, sessionId: SID, productId: PID, scanEventId, quantityDelta: delta, idempotencyKey: key },
    status: "pending",
    retryCount: 0,
    lastError: null,
    createdAt: "t",
    updatedAt: "t",
    idempotencyKey: key,
    scanEventId,
  };
}

describe.skipIf(!ready)("FirebaseSyncTarget - transaction-safe idempotency (emulator)", () => {
  let env: RulesTestEnvironment;
  const target = () => new FirebaseSyncTarget(env.authenticatedContext(UID).firestore() as unknown as Firestore, { emulator: true });
  const countQty = async () => {
    const s = await getDoc(doc(env.authenticatedContext(UID).firestore() as unknown as Firestore, "businesses", BIZ, "inventoryCounts", `${SID}_${PID}`));
    return s.exists() ? Number((s.data() as { countedQuantity?: number }).countedQuantity ?? 0) : 0;
  };

  beforeAll(async () => {
    const [host, port] = HOSTPORT.split(":");
    env = await initializeTestEnvironment({ projectId: "demo-inv-synctarget", firestore: { rules: readFileSync("firestore.rules", "utf8"), host, port: Number(port) } });
  });
  afterAll(async () => { if (env) await env.cleanup(); });
  beforeEach(async () => {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "businesses", BIZ), { name: "Sync Co", createdBy: UID });
      await setDoc(doc(db, "businessMembers", `${BIZ}_${UID}`), { businessId: BIZ, userId: UID, role: "owner" });
    });
  });

  it("first apply increments; SEQUENTIAL retry is alreadyApplied and does NOT double count", async () => {
    const t = target();
    const item = incItem("k1", "e1", 1);
    const r1 = await t.apply(item);
    expect(r1).toEqual({ ok: true, alreadyApplied: false });
    const r2 = await t.apply(item);
    expect(r2.ok).toBe(true);
    expect(r2.alreadyApplied).toBe(true);
    expect(await countQty()).toBe(1);
  });

  it("CONCURRENT retries of the SAME item -> exactly one increment (no double count)", async () => {
    const t = target();
    const item = incItem("k2", "e2", 1);
    const results = await Promise.all([t.apply(item), t.apply(item), t.apply(item), t.apply(item)]);
    expect(results.every((r) => r.ok)).toBe(true);
    // exactly one performed the write; the rest saw the applied key
    expect(results.filter((r) => !r.alreadyApplied).length).toBe(1);
    expect(await countQty()).toBe(1);
  });

  it("DISTINCT scan events accumulate (two different idempotency keys -> qty 2)", async () => {
    const t = target();
    await t.apply(incItem("k3a", "e3a", 1));
    await t.apply(incItem("k3b", "e3b", 1));
    expect(await countQty()).toBe(2);
    const s = await getDoc(doc(env.authenticatedContext(UID).firestore() as unknown as Firestore, "businesses", BIZ, "inventoryCounts", `${SID}_${PID}`));
    expect((s.data() as { scanEventIds: string[] }).scanEventIds.sort()).toEqual(["e3a", "e3b"]);
  });

  it("SAVE_SCAN_EVENT / SAVE_UNKNOWN_SCAN / RESOLVE_ALIAS persist and are idempotent", async () => {
    const t = target();
    const ev: PendingSyncItem = { ...incItem("se1", "ev1", 0), operation: "SAVE_SCAN_EVENT", entityType: "ScanEvent", payload: { id: "ev1", businessId: BIZ, cleanCode: "111" } };
    expect((await t.apply(ev)).alreadyApplied).toBe(false);
    expect((await t.apply(ev)).alreadyApplied).toBe(true); // idempotent
    const got = await getDoc(doc(env.authenticatedContext(UID).firestore() as unknown as Firestore, "businesses", BIZ, "scanEvents", "ev1"));
    expect(got.exists()).toBe(true);

    const rv: PendingSyncItem = { ...incItem("rv1", "r1", 0), operation: "SAVE_UNKNOWN_SCAN", entityType: "UnknownCodeReview", payload: { id: "r1", businessId: BIZ, cleanCode: "999" } };
    expect((await t.apply(rv)).ok).toBe(true);
    const al: PendingSyncItem = { ...incItem("al1", "a1", 0), operation: "RESOLVE_ALIAS", entityType: "Alias", payload: { id: "a1", businessId: BIZ, productId: PID, cleanCode: "111", approved: true } };
    expect((await t.apply(al)).ok).toBe(true);
    const alias = await getDoc(doc(env.authenticatedContext(UID).firestore() as unknown as Firestore, "businesses", BIZ, "aliases", "a1"));
    expect((alias.data() as { approved: boolean }).approved).toBe(true);
  });

  it("reset() throws against real cloud, is a no-op in emulator mode", () => {
    const db = env.authenticatedContext(UID).firestore() as unknown as Firestore;
    expect(() => new FirebaseSyncTarget(db, { emulator: false }).reset()).toThrow();
    expect(() => new FirebaseSyncTarget(db, { emulator: true }).reset()).not.toThrow();
  });

  it("apply fails cleanly (ok:false) with a missing businessId or idempotencyKey", async () => {
    const t = target();
    expect((await t.apply({ ...incItem("k", "e", 1), businessId: "" })).ok).toBe(false);
    expect((await t.apply({ ...incItem("", "e", 1), idempotencyKey: "" })).ok).toBe(false);
  });
});
