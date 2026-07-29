import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, type Firestore } from "firebase/firestore";
import { readFileSync } from "node:fs";
import { FirebaseSyncTarget } from "@/services/db/firebase/firebaseSyncTarget";
import { appliedKeyDocumentId } from "@/services/db/firebase/firebaseSyncSafety";
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
    const count = await getDoc(
      doc(
        env.authenticatedContext(UID).firestore() as unknown as Firestore,
        "businesses",
        BIZ,
        "inventoryCounts",
        `${SID}_${PID}`,
      ),
    );
    expect(count.data()).toMatchObject({
      appliedKeyId: "k1",
      lastQuantityDelta: 1,
      lastScanEventId: "e1",
    });
  });

  it("rejects applied-key collisions when either payload content or the envelope differs", async () => {
    const t = target();
    const first: PendingSyncItem = {
      ...incItem("collision-key", "product-event-1", 0),
      operation: "SAVE_PRODUCT",
      entityType: "Product",
      entityId: "product-a",
      scanEventId: null,
      payload: { id: "product-a", businessId: BIZ, name: "First product", verified: false },
    };
    const payloadCollision: PendingSyncItem = {
      ...first,
      payload: { id: "product-a", businessId: BIZ, name: "Changed content", verified: false },
    };
    const envelopeCollision: PendingSyncItem = {
      ...first,
      entityId: "product-b",
      payload: { id: "product-b", businessId: BIZ, name: "Different product", verified: false },
    };

    expect(await t.apply(first)).toMatchObject({ ok: true, alreadyApplied: false });
    expect(await t.apply(payloadCollision)).toMatchObject({
      ok: false,
      alreadyApplied: false,
      errorCode: "idempotency_conflict",
      retryable: false,
    });
    expect(await t.apply(envelopeCollision)).toMatchObject({
      ok: false,
      alreadyApplied: false,
      errorCode: "idempotency_conflict",
      retryable: false,
    });
    expect(
      (
        await getDoc(
          doc(
            env.authenticatedContext(UID).firestore() as unknown as Firestore,
            "businesses",
            BIZ,
            "products",
            "product-b",
          ),
        )
      ).exists(),
    ).toBe(false);
    const storedFirst = await getDoc(
      doc(
        env.authenticatedContext(UID).firestore() as unknown as Firestore,
        "businesses",
        BIZ,
        "products",
        "product-a",
      ),
    );
    expect(storedFirst.data()).toMatchObject({ name: "First product" });
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

  it("CONCURRENT retries with a slash-containing applied key hash to one marker and count once", async () => {
    const t = target();
    const key = "bizSync:s1:Nokian Outpost APT 245/55R19:INCREMENT_COUNT";
    const item = incItem(key, "e2-slash", 1);
    const results = await Promise.all([t.apply(item), t.apply(item), t.apply(item)]);

    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => !r.alreadyApplied)).toHaveLength(1);
    expect(await countQty()).toBe(1);

    const keyId = await appliedKeyDocumentId(key);
    expect(keyId).toMatch(/^h2_[0-9a-f]{64}$/);
    const marker = await getDoc(
      doc(
        env.authenticatedContext(UID).firestore() as unknown as Firestore,
        "businesses",
        BIZ,
        "_appliedKeys",
        keyId,
      ),
    );
    expect(marker.exists()).toBe(true);
  });

  it("DISTINCT scan events accumulate (two different idempotency keys -> qty 2)", async () => {
    const t = target();
    await t.apply(incItem("k3a", "e3a", 1));
    await t.apply(incItem("k3b", "e3b", 1));
    expect(await countQty()).toBe(2);
    const s = await getDoc(doc(env.authenticatedContext(UID).firestore() as unknown as Firestore, "businesses", BIZ, "inventoryCounts", `${SID}_${PID}`));
    expect((s.data() as { scanEventIds: string[] }).scanEventIds.sort()).toEqual(["e3a", "e3b"]);
  });

  it("a distinct applied key for the same scan event records the marker without incrementing again", async () => {
    const t = target();
    const first = incItem("same-event-key-1", "same-event", 1);
    const second = incItem("same-event-key-2", "same-event", 1);

    expect(await t.apply(first)).toMatchObject({ ok: true, alreadyApplied: false });
    expect(await t.apply(second)).toMatchObject({ ok: true, alreadyApplied: false });
    expect(await countQty()).toBe(1);

    const secondMarker = await getDoc(
      doc(
        env.authenticatedContext(UID).firestore() as unknown as Firestore,
        "businesses",
        BIZ,
        "_appliedKeys",
        "same-event-key-2",
      ),
    );
    expect(secondMarker.data()).toMatchObject({
      businessId: BIZ,
      entityType: "InventoryCount",
      entityId: `${SID}_${PID}`,
      sessionId: SID,
      targetId: `${SID}_${PID}`,
      operation: "INCREMENT_COUNT",
      scanEventId: "same-event",
      payloadHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const count = await getDoc(
      doc(
        env.authenticatedContext(UID).firestore() as unknown as Firestore,
        "businesses",
        BIZ,
        "inventoryCounts",
        `${SID}_${PID}`,
      ),
    );
    expect(count.data()).toMatchObject({
      countedQuantity: 1,
      scanEventIds: ["same-event"],
      appliedKeyId: "same-event-key-2",
      lastQuantityDelta: 0,
      lastScanEventId: "same-event",
    });
  });

  it("SAVE_SCAN_EVENT / SAVE_UNKNOWN_SCAN / RESOLVE_ALIAS persist and are idempotent", async () => {
    const t = target();
    const scannedAt = "2026-07-26T20:00:00.000Z";
    const ev: PendingSyncItem = { ...incItem("se1", "ev1", 0), operation: "SAVE_SCAN_EVENT", entityType: "ScanEvent", entityId: "ev1", payload: { id: "ev1", businessId: BIZ, sessionId: SID, cleanCode: "111", createdAt: scannedAt, decodeStatus: undefined } };
    expect((await t.apply(ev)).alreadyApplied).toBe(false);
    expect((await t.apply(ev)).alreadyApplied).toBe(true); // idempotent
    const got = await getDoc(doc(env.authenticatedContext(UID).firestore() as unknown as Firestore, "businesses", BIZ, "scanEvents", "ev1"));
    expect(got.exists()).toBe(true);
    expect((got.data() as { createdAt?: string }).createdAt).toBe(scannedAt);

    const rv: PendingSyncItem = { ...incItem("rv1", "r1", 0), operation: "SAVE_UNKNOWN_SCAN", entityType: "UnknownCodeReview", entityId: "r1", scanEventId: null, payload: { id: "r1", businessId: BIZ, sessionId: SID, cleanCode: "999" } };
    expect((await t.apply(rv)).ok).toBe(true);
    const al: PendingSyncItem = { ...incItem("al1", "a1", 0), operation: "RESOLVE_ALIAS", entityType: "Alias", entityId: "a1", scanEventId: null, payload: { id: "a1", businessId: BIZ, productId: PID, cleanCode: "111", approved: true } };
    expect((await t.apply(al)).ok).toBe(true);
    const alias = await getDoc(doc(env.authenticatedContext(UID).firestore() as unknown as Firestore, "businesses", BIZ, "aliases", "a1"));
    expect((alias.data() as { approved: boolean }).approved).toBe(true);
  });

  it("SAVE_PRODUCT persists the product and retry does not duplicate", async () => {
    const t = target();
    const pItem: PendingSyncItem = { ...incItem("sp1", "pp1", 0), operation: "SAVE_PRODUCT", entityType: "Product", entityId: "prod1", scanEventId: null, payload: { id: "prod1", businessId: BIZ, name: "Widget", primaryBarcode: "012345678905", verified: true, structuredBrand: undefined } };
    expect((await t.apply(pItem)).alreadyApplied).toBe(false);
    expect((await t.apply(pItem)).alreadyApplied).toBe(true); // idempotent retry -> no duplicate
    const got = await getDoc(doc(env.authenticatedContext(UID).firestore() as unknown as Firestore, "businesses", BIZ, "products", "prod1"));
    expect(got.exists()).toBe(true);
    expect((got.data() as { name: string }).name).toBe("Widget");
    const marker = await getDoc(
      doc(
        env.authenticatedContext(UID).firestore() as unknown as Firestore,
        "businesses",
        BIZ,
        "_appliedKeys",
        "sp1",
      ),
    );
    expect(marker.data()).toMatchObject({
      businessId: BIZ,
      entityType: "Product",
      entityId: "prod1",
      sessionId: SID,
      targetId: "prod1",
      operation: "SAVE_PRODUCT",
      scanEventId: null,
      payloadHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("SAVE_PRODUCT: two DISTINCT sequential edits (different idempotency keys) both persist (Task 1)", async () => {
    // Mirrors the retry test above, but proves the OTHER half of the idempotency contract: a second,
    // CONTENT-DIFFERENT edit to the same product must mint a distinct key (per buildIdempotencyKey's
    // call site in scanStore.ts correctProduct, which folds an edit fingerprint into the key) so
    // FirebaseSyncTarget's _appliedKeys dedupe does not swallow it as alreadyApplied the way a same-key
    // retry correctly does.
    const t = target();
    const first: PendingSyncItem = {
      ...incItem("sp3-edit1", "pp3a", 0),
      operation: "SAVE_PRODUCT",
      entityType: "Product",
      entityId: "prod3",
      scanEventId: null,
      payload: { id: "prod3", businessId: BIZ, name: "Edited Once", primaryBarcode: "012345678905", verified: true },
    };
    const second: PendingSyncItem = {
      ...incItem("sp3-edit2", "pp3b", 0), // DISTINCT idempotency key - simulates the fingerprinted key
      operation: "SAVE_PRODUCT",
      entityType: "Product",
      entityId: "prod3",
      scanEventId: null,
      payload: { id: "prod3", businessId: BIZ, name: "Edited Twice", primaryBarcode: "012345678905", verified: true },
    };
    expect((await t.apply(first)).alreadyApplied).toBe(false);
    expect((await t.apply(second)).alreadyApplied, "distinct edit is NOT swallowed as alreadyApplied").toBe(false);
    const got = await getDoc(doc(env.authenticatedContext(UID).firestore() as unknown as Firestore, "businesses", BIZ, "products", "prod3"));
    expect((got.data() as { name: string }).name, "the SECOND edit's content is what actually persisted").toBe("Edited Twice");
  });

  it("SAVE_PRODUCT fails cleanly with a missing businessId", async () => {
    const t = target();
    const bad: PendingSyncItem = { ...incItem("sp2", "pp2", 0), operation: "SAVE_PRODUCT", entityType: "Product", payload: { id: "prodX", name: "X" }, businessId: "" };
    expect((await t.apply(bad)).ok).toBe(false);
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

  it("getScanEventsBySession returns only this session's events, oldest first", async () => {
    const t = target();
    await t.apply({ ...incItem("gs1", "gev1", 0), operation: "SAVE_SCAN_EVENT", entityType: "ScanEvent", entityId: "gev1", payload: { id: "gev1", businessId: BIZ, sessionId: SID, cleanCode: "111", createdAt: "2026-07-19T16:00:00.000Z" } });
    await t.apply({ ...incItem("gs2", "gev2", 0), operation: "SAVE_SCAN_EVENT", entityType: "ScanEvent", entityId: "gev2", payload: { id: "gev2", businessId: BIZ, sessionId: SID, cleanCode: "222", createdAt: "2026-07-19T16:05:00.000Z" } });
    await t.apply({ ...incItem("gs3", "gev3", 0), sessionId: "other-session", operation: "SAVE_SCAN_EVENT", entityType: "ScanEvent", entityId: "gev3", payload: { id: "gev3", businessId: BIZ, sessionId: "other-session", cleanCode: "333", createdAt: "2026-07-19T16:01:00.000Z" } });
    const events = await t.getScanEventsBySession!(BIZ, SID);
    expect(events.map((e) => e.id)).toEqual(["gev1", "gev2"]);
  });

  it("getScanEventsBySession preserves physical scan chronology when sync order is reversed", async () => {
    const t = target();
    const late = await t.apply({ ...incItem("late-key", "late", 0), operation: "SAVE_SCAN_EVENT", entityType: "ScanEvent", entityId: "late", payload: { id: "late", businessId: BIZ, sessionId: SID, cleanCode: "222", createdAt: "2026-07-19T16:05:00.000Z" } });
    const early = await t.apply({ ...incItem("early-key", "early", 0), operation: "SAVE_SCAN_EVENT", entityType: "ScanEvent", entityId: "early", payload: { id: "early", businessId: BIZ, sessionId: SID, cleanCode: "111", createdAt: "2026-07-19T16:00:00.000Z" } });
    expect(late).toMatchObject({ ok: true, alreadyApplied: false });
    expect(early).toMatchObject({ ok: true, alreadyApplied: false });

    const events = await t.getScanEventsBySession!(BIZ, SID);

    expect(events.map((e) => e.id)).toEqual(["early", "late"]);
    expect(events.map((e) => e.createdAt)).toEqual(["2026-07-19T16:00:00.000Z", "2026-07-19T16:05:00.000Z"]);
  });
});
