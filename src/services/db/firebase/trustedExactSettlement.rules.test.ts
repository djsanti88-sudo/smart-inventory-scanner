import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { initializeTestEnvironment, assertFails, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, type Firestore } from "firebase/firestore";
import { readFileSync } from "node:fs";
import { FirebaseSyncTarget } from "@/services/db/firebase/firebaseSyncTarget";
import { loadBusinessData } from "@/services/db/firebase/businessDataLoader";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";
import type { InventorySession } from "@/types";

// Task 5: end-to-end durable settlement proof. The store creates the terminal trusted-exact queue
// entries; this test applies those exact entries through the real FirebaseSyncTarget, then reloads
// through the actual business loader as a separate device. It intentionally does not hand-build the
// terminal payloads, because a shape-only test would miss a future queue or idempotency regression.

const HOSTPORT = process.env.FIRESTORE_EMULATOR_HOST || "";
const ready = HOSTPORT.includes(":");
const UID = "trustedExactOwner";
const OTHER_UID = "trustedExactOtherBusiness";
const BIZ = "bizTrustedExact";
const OTHER_BIZ = "bizOtherTrustedExact";
const CANONICAL_ID = "trusted-exact:00012345678905";
const UPC_A = "012345678905";
const EAN_13 = "0012345678905";
const GTIN_14 = "00012345678905";

describe.skipIf(!ready)("trusted-exact durable settlement and second-device reload (emulator)", () => {
  let env: RulesTestEnvironment;
  const ownerDb = () => env.authenticatedContext(UID).firestore() as unknown as Firestore;
  const target = () => new FirebaseSyncTarget(ownerDb(), { emulator: true });

  beforeAll(async () => {
    const [host, port] = HOSTPORT.split(":");
    env = await initializeTestEnvironment({
      projectId: "demo-smart-inventory",
      firestore: { rules: readFileSync("firestore.rules", "utf8"), host, port: Number(port) },
    });
  });
  afterAll(async () => { if (env) await env.cleanup(); });
  beforeEach(async () => {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "businesses", BIZ), { name: "Trusted Exact Co", createdBy: UID });
      await setDoc(doc(db, "businessMembers", `${BIZ}_${UID}`), { businessId: BIZ, userId: UID, role: "owner" });
      await setDoc(doc(db, "businesses", OTHER_BIZ), { name: "Other Co", createdBy: OTHER_UID });
      await setDoc(doc(db, "businessMembers", `${OTHER_BIZ}_${OTHER_UID}`), { businessId: OTHER_BIZ, userId: OTHER_UID, role: "owner" });
    });
  });

  it("settles all physical spellings once, archives the transferred provisional, and blocks another tenant", async () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.setState({ businessId: BIZ });
    store.getState().setOnline(false);
    const sessionId = store.getState().sessionId;
    const session: InventorySession = store.getState().currentSession!;

    // The established trusted canonical product simulates a prior spelling on another device. New
    // spellings are initially provisional and must transfer their exact physical quantity to it.
    const canonicalProduct = {
      ...store.getState().products[0]!,
      id: "canonical-trusted-product",
      businessId: BIZ,
      name: `Known tire - ${UPC_A}`,
      category: "Tire",
      verified: true,
      provisional: false,
      status: "active" as const,
      trustedExactCanonicalId: CANONICAL_ID,
      createdBy: "system:trusted_exact",
      updatedBy: "system:trusted_exact",
    };
    store.setState((state) => ({ products: [...state.products, canonicalProduct] }));

    const events = [UPC_A, EAN_13, GTIN_14].map((code) => store.getState().processScan(code)!);
    const review = store.getState().needsReviewQueue[0]!;
    const provisionalId = review.provisionalProductId!;
    expect(provisionalId).not.toBe(canonicalProduct.id);

    // Persist the pre-settlement physical facts first, exactly as a scanner that went offline then
    // reconnects would. The session is seeded because the test store's local startup session predates
    // its sync queue; all product/event/count/review writes are real pending queue entries.
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "businesses", BIZ, "countSessions", sessionId), session);
    });
    const t = target();
    for (const item of store.getState().pendingSyncQueue) {
      expect((await t.apply(item)).ok, `${item.operation} pre-settlement write`).toBe(true);
    }
    store.setState({ pendingSyncQueue: [] });

    store.getState().settleTrustedExactIdentity(
      review.id,
      CANONICAL_ID,
      { name: `Known tire - ${UPC_A}`, category: "Tire" },
      "Trusted exact index match.",
    );
    const terminalOps = store.getState().pendingSyncQueue;
    expect(terminalOps).toHaveLength(1);
    expect(terminalOps[0]).toMatchObject({ operation: "SETTLE_TRUSTED_EXACT", entityId: review.id });
    expect(terminalOps[0]!.payload).toMatchObject({
      product: { id: canonicalProduct.id, verified: true },
      archivedProduct: { id: provisionalId, status: "archived" },
      review: { resolutionAction: "trusted_exact" },
      countTransfers: [{ sessionId, fromProductId: provisionalId, toProductId: canonicalProduct.id, quantity: events.length }],
    });
    expect((terminalOps[0]!.payload as { terminalEvents: unknown[] }).terminalEvents).toHaveLength(events.length);

    for (const item of terminalOps) {
      const result = await t.apply(item);
      expect(result.ok, `${item.operation} terminal write`).toBe(true);
      expect(result.errorCode).not.toBe("idempotency_conflict");
    }
    // Replaying the same terminal queue is retry-safe, including transfer pairs and every event save.
    for (const item of terminalOps) {
      expect(await t.apply(item)).toMatchObject({ ok: true, alreadyApplied: true });
    }

    const secondDevice = await loadBusinessData(ownerDb(), BIZ);
    const positiveCounts = secondDevice.counts.filter((count) => count.quantity > 0);
    expect(positiveCounts).toEqual([expect.objectContaining({ productId: canonicalProduct.id, quantity: events.length })]);
    expect(secondDevice.counts.find((count) => count.productId === provisionalId)?.quantity ?? 0).toBe(0);
    expect(secondDevice.products.find((product) => product.id === canonicalProduct.id)).toMatchObject({
      verified: true,
      trustedExactCanonicalId: CANONICAL_ID,
      status: "active",
    });
    expect(secondDevice.products.find((product) => product.id === provisionalId)?.status).toBe("archived");
    expect(secondDevice.scanEvents
      .map((event) => ({ id: event.id, rawCode: event.rawCode, createdAt: event.createdAt, matchedProductId: event.matchedProductId, status: event.status, decodeStatus: event.decodeStatus }))
      .sort((left, right) => left.id.localeCompare(right.id)))
      .toEqual(events
        .map((event) => ({ id: event.id, rawCode: event.rawCode, createdAt: event.createdAt, matchedProductId: canonicalProduct.id, status: "known", decodeStatus: "verified" }))
        .sort((left, right) => left.id.localeCompare(right.id)));

    const storedReview = await getDoc(doc(ownerDb(), "businesses", BIZ, "unknownCodeReviews", review.id));
    expect(storedReview.data()).toMatchObject({ status: "resolved", resolutionAction: "trusted_exact", resolvedBy: "system:trusted_exact" });

    const otherDb = env.authenticatedContext(OTHER_UID).firestore() as unknown as Firestore;
    await assertFails(getDoc(doc(otherDb, "businesses", BIZ, "products", canonicalProduct.id)));
    await assertFails(setDoc(doc(otherDb, "businesses", BIZ, "products", "forged"), { businessId: BIZ, name: "forged" }));
  });
});
