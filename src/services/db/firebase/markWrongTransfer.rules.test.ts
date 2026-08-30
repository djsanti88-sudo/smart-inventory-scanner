import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, type Firestore } from "firebase/firestore";
import { readFileSync } from "node:fs";
import { FirebaseSyncTarget } from "@/services/db/firebase/firebaseSyncTarget";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";
import { buildIdempotencyKey } from "@/inventory/idempotency";
import type { PendingSyncItem } from "@/types";
import type { IncrementPayload } from "@/services/mockDb";

// F-03 (audit remediation 2026-07-29): markWrong repoints local state but historically REUSED the
// original scan event's idempotency keys when transferring quantity onto the fresh "Unidentified item"
// provisional. FirebaseSyncTarget stores an applied-key marker keyed by the idempotency key STRING; on
// replay with a DIFFERENT productId payload the stored marker's targetId ("sessionId_productId") no
// longer matches, so `markerMatches` fails and the transaction returns `idempotency_conflict`
// (retryable:false) - the corrected write is REJECTED, not applied. A local store test alone cannot
// prove this: it needs the REAL FirebaseSyncTarget against a REAL (emulated) Firestore.
//
// This test drives the REAL scanStore markWrong action to produce its ACTUAL pendingSyncQueue items (not
// hand-built approximations), seeds the emulator with the ORIGINAL scan's already-synced state (mirroring
// a session that synced to the cloud before the correction), then applies markWrong's transfer ops through
// FirebaseSyncTarget and reads back via a FRESH getDoc (second-device/reload simulation) to assert the
// corrected count lands on the SAFE placeholder identity with no idempotency_conflict rejection.

const HOSTPORT = process.env.FIRESTORE_EMULATOR_HOST || "";
const ready = HOSTPORT.includes(":");
const UID = "markWrongUser";
const BIZ = "bizMarkWrong";

describe.skipIf(!ready)("markWrong durable transfer survives a cloud reload (emulator)", () => {
  let env: RulesTestEnvironment;
  const target = () => new FirebaseSyncTarget(env.authenticatedContext(UID).firestore() as unknown as Firestore, { emulator: true });
  const countQty = async (sessionId: string, productId: string) => {
    const s = await getDoc(
      doc(env.authenticatedContext(UID).firestore() as unknown as Firestore, "businesses", BIZ, "inventoryCounts", `${sessionId}_${productId}`),
    );
    return s.exists() ? Number((s.data() as { countedQuantity?: number }).countedQuantity ?? 0) : 0;
  };

  beforeAll(async () => {
    const [host, port] = HOSTPORT.split(":");
    env = await initializeTestEnvironment({
      projectId: "demo-inv-markwrong",
      firestore: { rules: readFileSync("firestore.rules", "utf8"), host, port: Number(port) },
    });
  });
  afterAll(async () => {
    if (env) await env.cleanup();
  });
  beforeEach(async () => {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "businesses", BIZ), { name: "MarkWrong Co", createdBy: UID });
      await setDoc(doc(db, "businessMembers", `${BIZ}_${UID}`), { businessId: BIZ, userId: UID, role: "owner" });
    });
  });

  it("a synced markWrong correction drains to the emulator and survives a fresh reload on the corrected identity", async () => {
    // 1. Drive the REAL store (local mock backend) to produce the actual scan event + the actual
    //    markWrong transfer ops - not hand-built approximations of the payload shape.
    const store = createTestScanStore({ db: new MockDb() });
    // The local store's default test business is not the business seeded in this emulator fixture.
    // Keep every generated queue item inside the authenticated tenant under test.
    store.setState({ businessId: BIZ });
    store.getState().updateSettings({ aiLookupEnabled: false });
    const code = "049000006277";
    const productId = "seed-wrong-emu-1";
    const s0 = store.getState();
    store.setState((prev) => ({
      products: [
        ...prev.products,
        {
          id: productId, businessId: s0.businessId, name: "Wrongly Mapped Tire", brand: "Cooper", category: "tire",
          specsShort: "", specsFull: "", primarySku: "", primaryBarcode: code, gtin: "", upc: "", ean: "",
          vendorCodes: [], aliases: [], imageUrl: "", productUrl: "", location: "", notes: "", status: "active",
          source: "seed", confidence: 1, verified: true, createdAt: s0.sessionId, updatedAt: s0.sessionId, createdBy: "seed", updatedBy: "seed",
        },
      ],
      aliases: [
        ...prev.aliases,
        {
          id: "alias-wrong-emu-1", businessId: s0.businessId, productId, rawCodeExample: code, cleanCode: code,
          normalizedCode: code, aliasType: "barcode", source: "seed", confidence: 1, approved: true,
          createdAt: s0.sessionId, updatedAt: s0.sessionId, createdBy: "seed", lastSeenAt: s0.sessionId,
          syncStatus: "synced", idempotencyKey: "seed-alias-wrong-emu-1",
        },
      ],
    }));

    const ev = store.getState().processScan(code);
    expect(ev).toBeTruthy();
    const businessId = store.getState().businessId;
    const sessionId = store.getState().sessionId;

    // 2. Seed the EMULATOR with the ORIGINAL scan's already-synced state - the real-world precondition:
    //    this session synced to the cloud BEFORE the owner corrected the identity.
    const t = target();
    const originalIncKey = buildIdempotencyKey(businessId, sessionId, ev!.id, "INCREMENT_COUNT");
    const originalIncPayload: IncrementPayload = {
      businessId, sessionId, productId, scanEventId: ev!.id, quantityDelta: 1, idempotencyKey: originalIncKey,
    };
    const originalIncItem: PendingSyncItem = {
      id: "orig-inc", businessId, sessionId, entityType: "InventoryCount", entityId: `${sessionId}_${productId}`,
      operation: "INCREMENT_COUNT", payload: originalIncPayload, status: "pending", retryCount: 0, lastError: null,
      createdAt: "t", updatedAt: "t", idempotencyKey: originalIncKey, scanEventId: ev!.id,
    };
    const originalSaveKey = buildIdempotencyKey(businessId, sessionId, ev!.id, "SAVE_SCAN_EVENT");
    const originalSaveItem: PendingSyncItem = {
      id: "orig-save", businessId, sessionId, entityType: "ScanEvent", entityId: ev!.id,
      operation: "SAVE_SCAN_EVENT", payload: ev, status: "pending", retryCount: 0, lastError: null,
      createdAt: "t", updatedAt: "t", idempotencyKey: originalSaveKey, scanEventId: ev!.id,
    };
    const originalSaveResult = await t.apply(originalSaveItem);
    expect(originalSaveResult.ok).toBe(true);
    expect((await t.apply(originalIncItem)).ok).toBe(true);
    expect(await countQty(sessionId, productId), "the wrong product is synced with quantity 1 BEFORE the correction").toBe(1);

    // 3. Freeze local sync so markWrong's REAL transfer ops are captured (not auto-drained by MockDb),
    //    then run the actual correction.
    store.getState().setSimulateSyncFailure(true);
    await store.getState().markWrong(productId, { reason: "test" });

    const unidentified = store.getState().products.find((p) => p.provisional === true && p.primaryBarcode === code)!;
    expect(unidentified, "a safe placeholder now carries the transferred quantity").toBeDefined();

    const transferOps = store.getState().pendingSyncQueue;
    expect(transferOps.length, "markWrong queued its transfer ops").toBeGreaterThan(0);

    // 4. Drain markWrong's REAL full queued correction through the SAME FirebaseSyncTarget against the
    // emulator that
    //    already holds the original (pre-correction) synced state - this is the finding's real gate.
    for (const item of transferOps) {
      const result = await t.apply(item);
      expect(result.ok, `transfer op ${item.operation} ${item.idempotencyKey} must be ACCEPTED, not rejected`).toBe(true);
      expect(result.errorCode, "no idempotency_conflict on the corrected write").not.toBe("idempotency_conflict");
    }

    // 5. FRESH READ (second-device / reload simulation): the corrected identity carries the quantity;
    //    the wrong identity is zeroed out. No idempotency_conflict anywhere in the drain.
    expect(await countQty(sessionId, productId), "the wrong product's cloud count is zeroed out").toBe(0);
    expect(await countQty(sessionId, unidentified.id), "the safe placeholder's cloud count carries the transferred quantity").toBe(
      store.getState().finalCounts.find((c) => c.productId === unidentified.id)?.quantity ?? -1,
    );
    expect(await countQty(sessionId, unidentified.id)).toBeGreaterThan(0);
  });
});
