import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, type Firestore } from "firebase/firestore";
import { readFileSync } from "node:fs";
import { FirebaseSyncTarget } from "@/services/db/firebase/firebaseSyncTarget";
import { loadBusinessData } from "@/services/db/firebase/businessDataLoader";
import type { InventorySession, PendingSyncItem } from "@/types";

// Loop 3 proof (emulator): a count SESSION persists via SAVE_SESSION; finishing it (distinct key)
// updates status=completed; INCREMENT_COUNT writes the count line; loadBusinessData reads sessions +
// counts back so the store can reconstruct currentSession + finalCounts after a refresh. A non-member
// cannot read the session/counts (RLS). Runs only with the Firestore emulator (npm run test:firebase).

const HOSTPORT = process.env.FIRESTORE_EMULATOR_HOST || "";
const ready = HOSTPORT.includes(":");
const UID = "sessUser";
const BIZ = "bizSess";
const SID = "session-loop3";
const PID = "p-loop3";

function sessionItem(session: InventorySession, key: string): PendingSyncItem {
  return {
    id: key,
    businessId: BIZ,
    sessionId: session.id,
    entityType: "CountSession",
    entityId: session.id,
    operation: "SAVE_SESSION",
    payload: session,
    status: "pending",
    retryCount: 0,
    lastError: null,
    createdAt: "t",
    updatedAt: "t",
    idempotencyKey: key,
    scanEventId: null,
  };
}

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

const activeSession: InventorySession = {
  id: SID,
  businessId: BIZ,
  name: "Loop 3 Session",
  location: "Bay A",
  status: "active",
  startedAt: "2026-06-15T10:00:00.000Z",
  completedAt: null,
  createdBy: UID,
  notes: "",
  syncStatus: "synced",
};

describe.skipIf(!ready)("Loop 3 session/count persistence (emulator)", () => {
  let env: RulesTestEnvironment;
  const target = () => new FirebaseSyncTarget(env.authenticatedContext(UID).firestore() as unknown as Firestore, { emulator: true });

  beforeAll(async () => {
    const [host, port] = HOSTPORT.split(":");
    env = await initializeTestEnvironment({ projectId: "demo-inv-session", firestore: { rules: readFileSync("firestore.rules", "utf8"), host, port: Number(port) } });
  });
  afterAll(async () => { if (env) await env.cleanup(); });
  beforeEach(async () => {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "businesses", BIZ), { name: "Session Co", createdBy: UID });
      await setDoc(doc(db, "businessMembers", `${BIZ}_${UID}`), { businessId: BIZ, userId: UID, role: "owner" });
    });
  });

  it("SAVE_SESSION persists the session and a retry does not duplicate", async () => {
    const t = target();
    const item = sessionItem(activeSession, `${SID}-active`);
    expect((await t.apply(item)).alreadyApplied).toBe(false);
    expect((await t.apply(item)).alreadyApplied).toBe(true); // idempotent
    const got = await getDoc(doc(env.authenticatedContext(UID).firestore() as unknown as Firestore, "businesses", BIZ, "countSessions", SID));
    expect(got.exists()).toBe(true);
    expect((got.data() as { status: string }).status).toBe("active");
    const marker = await getDoc(
      doc(
        env.authenticatedContext(UID).firestore() as unknown as Firestore,
        "businesses",
        BIZ,
        "_appliedKeys",
        `${SID}-active`,
      ),
    );
    expect(marker.data()).toMatchObject({
      businessId: BIZ,
      entityType: "CountSession",
      entityId: SID,
      sessionId: SID,
      targetId: SID,
      operation: "SAVE_SESSION",
      scanEventId: null,
    });
  });

  it("finishSession (distinct key) updates the SAME session to completed without losing start metadata", async () => {
    const t = target();
    await t.apply(sessionItem(activeSession, `${SID}-active`));
    const completed: InventorySession = { ...activeSession, status: "completed", completedAt: "2026-06-15T11:00:00.000Z" };
    // Distinct idempotency key -> the completed write is NOT deduped as alreadyApplied.
    expect((await t.apply(sessionItem(completed, `${SID}-completed`))).alreadyApplied).toBe(false);
    const got = await getDoc(doc(env.authenticatedContext(UID).firestore() as unknown as Firestore, "businesses", BIZ, "countSessions", SID));
    const data = got.data() as { status: string; completedAt: string; name: string; startedAt: string };
    expect(data.status).toBe("completed");
    expect(data.completedAt).toBe("2026-06-15T11:00:00.000Z");
    expect(data.name).toBe("Loop 3 Session"); // merge:true preserved the original start metadata
    expect(data.startedAt).toBe("2026-06-15T10:00:00.000Z");
  });

  it("loadBusinessData reconstructs session + counts; scan retry does not double count", async () => {
    const t = target();
    await t.apply(sessionItem(activeSession, `${SID}-active`));
    await t.apply(incItem("inc-1", "ev-1", 1));
    await t.apply(incItem("inc-2", "ev-2", 1));
    await t.apply(incItem("inc-1", "ev-1", 1)); // retry of the FIRST scan -> must be a no-op

    const db = env.authenticatedContext(UID).firestore() as unknown as Firestore;
    const data = await loadBusinessData(db, BIZ);

    expect(data.sessions.map((s) => s.id)).toContain(SID);
    const restored = data.sessions.find((s) => s.id === SID)!;
    expect(restored.status).toBe("active");
    expect(restored.location).toBe("Bay A");

    const counts = data.counts.filter((c) => c.sessionId === SID);
    expect(counts).toHaveLength(1);
    expect(counts[0].productId).toBe(PID);
    expect(counts[0].quantity).toBe(2); // two distinct scans; the retry did NOT double count
    expect(counts[0].scanEventIds.sort()).toEqual(["ev-1", "ev-2"]);
  });

  it("TWO SEPARATE FirebaseSyncTarget instances (simulating two devices) concurrently scanning the SAME product accumulate correctly, no lost update", async () => {
    const deviceA = new FirebaseSyncTarget(env.authenticatedContext(UID).firestore() as unknown as Firestore, { emulator: true });
    const deviceB = new FirebaseSyncTarget(env.authenticatedContext(UID).firestore() as unknown as Firestore, { emulator: true });
    const mkItem = (key: string, scanEventId: string): PendingSyncItem => ({
      id: scanEventId, businessId: BIZ, sessionId: SID, entityType: "InventoryCount", entityId: `${SID}_${PID}`,
      operation: "INCREMENT_COUNT",
      payload: { businessId: BIZ, sessionId: SID, productId: PID, scanEventId, quantityDelta: 1, idempotencyKey: key },
      status: "pending", retryCount: 0, lastError: null, createdAt: "t", updatedAt: "t",
      idempotencyKey: key, scanEventId,
    });
    // 5 scans from device A, 5 from device B, fully interleaved and concurrent (Promise.all), each
    // with its OWN distinct idempotency key (matching real distinct-scan behavior - see
    // idempotency.ts's "never regenerate a key inside a retry" law; these are 10 GENUINELY DIFFERENT
    // scans, not retries of one scan).
    const opsA = Array.from({ length: 5 }, (_, i) => deviceA.apply(mkItem(`devA-k${i}`, `devA-e${i}`)));
    const opsB = Array.from({ length: 5 }, (_, i) => deviceB.apply(mkItem(`devB-k${i}`, `devB-e${i}`)));
    const results = await Promise.all([...opsA, ...opsB]);
    expect(results.every((r) => r.ok)).toBe(true);
    const snap = await getDoc(doc(env.authenticatedContext(UID).firestore() as unknown as Firestore, "businesses", BIZ, "inventoryCounts", `${SID}_${PID}`));
    const data = snap.data() as { countedQuantity: number; scanEventIds: string[] };
    expect(data.countedQuantity).toBe(10); // qty = 20 scenario from the master plan's AC2, scaled to 10 for test speed
    expect(new Set(data.scanEventIds).size).toBe(10); // all ten distinct scanEventIds present, no loss
  });

  it("a non-member cannot read the session or counts (RLS)", async () => {
    await target().apply(sessionItem(activeSession, `${SID}-active`));
    const stranger = env.authenticatedContext("stranger").firestore() as unknown as Firestore;
    await expect(loadBusinessData(stranger, BIZ)).rejects.toBeTruthy();
  });
});
