import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  deleteDoc,
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
  type Firestore,
} from "firebase/firestore";
import { readFileSync } from "node:fs";
import { FirebaseSyncTarget } from "@/services/db/firebase/firebaseSyncTarget";
import type { PendingSyncItem } from "@/types";

const HOSTPORT = process.env.FIRESTORE_EMULATOR_HOST || "";
const ready = HOSTPORT.includes(":");

const OWNER = "roleOwner";
const ADMIN = "roleAdmin";
const COUNTER = "roleCounter";
const OTHER_COUNTER = "otherCounter";
const VIEWER = "roleViewer";
const STRANGER = "roleStranger";
const ORPHAN_OWNER = "orphanOwner";
const BIZ = "roleBiz";
const OTHER_BIZ = "otherRoleBiz";
const ORPHAN_BIZ = "orphanRoleBiz";

const businessDoc = (collectionName: string, id: string) =>
  ["businesses", BIZ, collectionName, id] as const;

const provisionalProduct = {
  businessId: BIZ,
  name: "Unidentified item",
  verified: false,
  provisional: true,
  status: "active",
};

const realProvisionalProduct = {
  id: "real-provisional",
  businessId: BIZ,
  name: "Unidentified item 012345678905",
  brand: "",
  category: "",
  specsShort: "",
  specsFull: "",
  primarySku: "",
  primaryBarcode: "012345678905",
  gtin: "",
  upc: "",
  ean: "",
  vendorCodes: [],
  aliases: [],
  imageUrl: "",
  productUrl: "",
  location: "",
  notes: "",
  status: "active",
  source: "ai_gemini",
  confidence: 0,
  verified: false,
  provisional: true,
  provenanceTier: "provisional",
  createdAt: "2026-07-26T12:00:00.000Z",
  createdBy: "ai",
  updatedAt: "2026-07-26T12:00:00.000Z",
  updatedBy: "ai",
};

const activeSession = (createdBy: string, id = "counter-active") => ({
  id,
  businessId: BIZ,
  name: "Counter session",
  location: "Main",
  status: "active",
  startedAt: "2026-07-26T12:00:00.000Z",
  completedAt: null,
  createdBy,
  notes: "",
  syncStatus: "synced",
  locked: false,
  lockedAt: null,
});

describe.skipIf(!ready)("Firestore rules - owner/admin/counter role permissions", () => {
  let env: RulesTestEnvironment;

  beforeAll(async () => {
    const [host, port] = HOSTPORT.split(":");
    env = await initializeTestEnvironment({
      projectId: "demo-inv-role-permissions",
      firestore: {
        rules: readFileSync("firestore.rules", "utf8"),
        host,
        port: Number(port),
      },
    });
  });

  afterAll(async () => {
    if (env) await env.cleanup();
  });

  beforeEach(async () => {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "businesses", BIZ), { name: "Role Co", createdBy: OWNER });
      await setDoc(doc(db, "businesses", OTHER_BIZ), { name: "Other Role Co", createdBy: STRANGER });
      for (const [userId, role] of [
        [OWNER, "owner"],
        [ADMIN, "admin"],
        [COUNTER, "counter"],
        [OTHER_COUNTER, "counter"],
        [VIEWER, "viewer"],
      ] as const) {
        await setDoc(doc(db, "businessMembers", `${BIZ}_${userId}`), {
          businessId: BIZ,
          userId,
          role,
        });
      }
      await setDoc(doc(db, "businessMembers", `${OTHER_BIZ}_${STRANGER}`), {
        businessId: OTHER_BIZ,
        userId: STRANGER,
        role: "owner",
      });
      await setDoc(doc(db, ...businessDoc("products", "trusted-product")), {
        businessId: BIZ,
        name: "Trusted product",
        verified: true,
        provisional: false,
        status: "active",
      });
      await setDoc(doc(db, ...businessDoc("products", "counter-provisional")), provisionalProduct);
      await setDoc(doc(db, ...businessDoc("aliases", "trusted-alias")), {
        businessId: BIZ,
        productId: "trusted-product",
        cleanCode: "012345678905",
        approved: true,
      });
      await setDoc(
        doc(db, ...businessDoc("countSessions", "counter-active")),
        activeSession(COUNTER),
      );
      await setDoc(
        doc(db, ...businessDoc("countSessions", "other-counter-active")),
        activeSession(OTHER_COUNTER, "other-counter-active"),
      );
      await setDoc(doc(db, ...businessDoc("countSessions", "counter-completed")), {
        ...activeSession(COUNTER, "counter-completed"),
        status: "completed",
        completedAt: "2026-07-26T13:00:00.000Z",
      });
      await setDoc(doc(db, ...businessDoc("countSessions", "counter-locked")), {
        ...activeSession(COUNTER, "counter-locked"),
        locked: true,
        lockedAt: "2026-07-26T12:30:00.000Z",
      });
    });
  });

  const dbFor = (uid: string) => env.authenticatedContext(uid).firestore();
  const syncItem = (
    values: Pick<
      PendingSyncItem,
      | "businessId"
      | "sessionId"
      | "entityType"
      | "entityId"
      | "operation"
      | "payload"
      | "idempotencyKey"
      | "scanEventId"
    >,
  ): PendingSyncItem => ({
    id: `queue-${values.idempotencyKey}`,
    ...values,
    status: "pending",
    retryCount: 0,
    lastError: null,
    createdAt: "2026-07-26T12:00:00.000Z",
    updatedAt: "2026-07-26T12:00:00.000Z",
  });

  it("owner and admin retain trusted-product, alias, and session administration", async () => {
    await assertSucceeds(
      setDoc(doc(dbFor(OWNER), ...businessDoc("products", "owner-trusted")), {
        businessId: BIZ,
        name: "Owner trusted",
        verified: true,
        provisional: false,
      }),
    );
    await assertSucceeds(
      setDoc(doc(dbFor(ADMIN), ...businessDoc("products", "admin-trusted")), {
        businessId: BIZ,
        name: "Admin trusted",
        verified: true,
        provisional: false,
      }),
    );
    await assertSucceeds(
      updateDoc(doc(dbFor(ADMIN), ...businessDoc("products", "trusted-product")), {
        name: "Admin corrected",
      }),
    );
    await assertSucceeds(
      setDoc(doc(dbFor(ADMIN), ...businessDoc("aliases", "admin-alias")), {
        businessId: BIZ,
        productId: "trusted-product",
        cleanCode: "012345678906",
        approved: true,
      }),
    );
    await assertSucceeds(
      updateDoc(doc(dbFor(ADMIN), ...businessDoc("countSessions", "counter-completed")), {
        notes: "Reviewed by admin",
      }),
    );
  });

  it("admin cannot become owner, alter member identity, or remove an owner", async () => {
    const adminDb = dbFor(ADMIN);
    await assertFails(
      updateDoc(doc(adminDb, "businessMembers", `${BIZ}_${ADMIN}`), {
        role: "owner",
      }),
    );
    await assertFails(
      updateDoc(doc(adminDb, "businessMembers", `${BIZ}_${COUNTER}`), {
        userId: ADMIN,
        role: "admin",
      }),
    );
    await assertFails(
      deleteDoc(doc(adminDb, "businessMembers", `${BIZ}_${OWNER}`)),
    );
    await assertFails(
      updateDoc(doc(adminDb, "businessMembers", `${BIZ}_${OWNER}`), {
        role: "admin",
      }),
    );
    await assertFails(
      updateDoc(doc(adminDb, "businesses", BIZ), {
        createdBy: ADMIN,
      }),
    );
  });

  it("owner can manage non-owner memberships but owner memberships stay server-managed", async () => {
    const ownerDb = dbFor(OWNER);
    await assertSucceeds(
      updateDoc(doc(ownerDb, "businessMembers", `${BIZ}_${COUNTER}`), {
        role: "admin",
      }),
    );
    await assertFails(
      updateDoc(doc(ownerDb, "businessMembers", `${BIZ}_${OWNER}`), {
        role: "admin",
      }),
    );
    await assertFails(
      deleteDoc(doc(ownerDb, "businessMembers", `${BIZ}_${OWNER}`)),
    );
  });

  it("orphan membership cannot read or write retained business subcollections", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "businesses", ORPHAN_BIZ), {
        name: "Deleted business",
        createdBy: ORPHAN_OWNER,
      });
      await setDoc(doc(db, "businessMembers", `${ORPHAN_BIZ}_${ORPHAN_OWNER}`), {
        businessId: ORPHAN_BIZ,
        userId: ORPHAN_OWNER,
        role: "owner",
      });
      await setDoc(doc(db, "businesses", ORPHAN_BIZ, "products", "orphan-product"), {
        id: "orphan-product",
        businessId: ORPHAN_BIZ,
        name: "Retained product",
      });
      await setDoc(doc(db, "businesses", ORPHAN_BIZ, "countSessions", "orphan-session"), {
        ...activeSession(ORPHAN_OWNER, "orphan-session"),
        businessId: ORPHAN_BIZ,
      });
      await setDoc(doc(db, "businesses", ORPHAN_BIZ, "scanEvents", "orphan-event"), {
        id: "orphan-event",
        businessId: ORPHAN_BIZ,
        sessionId: "orphan-session",
      });
      await setDoc(doc(db, "businesses", ORPHAN_BIZ, "inventoryCounts", "orphan-session_orphan-product"), {
        businessId: ORPHAN_BIZ,
        countSessionId: "orphan-session",
        productId: "orphan-product",
        countedQuantity: 1,
        scanEventIds: ["orphan-event"],
      });
      await deleteDoc(doc(db, "businesses", ORPHAN_BIZ));
    });

    const orphanDb = dbFor(ORPHAN_OWNER);
    for (const [collectionName, id] of [
      ["products", "orphan-product"],
      ["countSessions", "orphan-session"],
      ["scanEvents", "orphan-event"],
      ["inventoryCounts", "orphan-session_orphan-product"],
    ] as const) {
      await assertFails(
        getDoc(doc(orphanDb, "businesses", ORPHAN_BIZ, collectionName, id)),
      );
    }

    await assertFails(
      setDoc(doc(orphanDb, "businesses", ORPHAN_BIZ, "products", "new-product"), {
        id: "new-product",
        businessId: ORPHAN_BIZ,
        name: "Forbidden product",
      }),
    );
    await assertFails(
      setDoc(doc(orphanDb, "businesses", ORPHAN_BIZ, "countSessions", "new-session"), {
        ...activeSession(ORPHAN_OWNER, "new-session"),
        businessId: ORPHAN_BIZ,
      }),
    );
    await assertFails(
      setDoc(doc(orphanDb, "businesses", ORPHAN_BIZ, "scanEvents", "new-event"), {
        id: "new-event",
        businessId: ORPHAN_BIZ,
        sessionId: "orphan-session",
      }),
    );
    await assertFails(
      setDoc(doc(orphanDb, "businesses", ORPHAN_BIZ, "inventoryCounts", "orphan-session_orphan-product"), {
        businessId: ORPHAN_BIZ,
        countSessionId: "orphan-session",
        productId: "orphan-product",
        countedQuantity: 2,
        scanEventIds: ["orphan-event", "new-event"],
      }),
    );

    await assertSucceeds(
      getDoc(doc(dbFor(OWNER), ...businessDoc("products", "trusted-product"))),
    );
  });

  it("counter creates only an unverified provisional product in their business", async () => {
    const counterDb = dbFor(COUNTER);
    await assertSucceeds(
      setDoc(
        doc(counterDb, ...businessDoc("products", "new-provisional")),
        { ...provisionalProduct, id: "new-provisional" },
      ),
    );
    await assertFails(
      setDoc(doc(counterDb, ...businessDoc("products", "verified-product")), {
        ...provisionalProduct,
        id: "verified-product",
        verified: true,
      }),
    );
    await assertFails(
      setDoc(doc(counterDb, ...businessDoc("products", "non-provisional-product")), {
        ...provisionalProduct,
        id: "non-provisional-product",
        provisional: false,
      }),
    );
    await assertFails(
      setDoc(doc(counterDb, ...businessDoc("products", "missing-trust-flags")), {
        businessId: BIZ,
        name: "Missing flags",
      }),
    );
    await assertFails(
      setDoc(
        doc(counterDb, "businesses", OTHER_BIZ, "products", "foreign-provisional"),
        { ...provisionalProduct, id: "foreign-provisional", businessId: OTHER_BIZ },
      ),
    );
  });

  it("counter cannot mutate trusted or provisional products and cannot manage aliases", async () => {
    const counterDb = dbFor(COUNTER);
    await assertFails(
      updateDoc(doc(counterDb, ...businessDoc("products", "trusted-product")), {
        verified: false,
      }),
    );
    await assertFails(
      updateDoc(doc(counterDb, ...businessDoc("products", "counter-provisional")), {
        verified: true,
        provisional: false,
      }),
    );
    await assertFails(
      deleteDoc(doc(counterDb, ...businessDoc("products", "counter-provisional"))),
    );
    await assertFails(
      setDoc(doc(counterDb, ...businessDoc("aliases", "counter-alias")), {
        businessId: BIZ,
        productId: "counter-provisional",
        cleanCode: "012345678907",
        approved: false,
      }),
    );
    await assertFails(
      updateDoc(doc(counterDb, ...businessDoc("aliases", "trusted-alias")), {
        approved: false,
      }),
    );
    await assertFails(
      deleteDoc(doc(counterDb, ...businessDoc("aliases", "trusted-alias"))),
    );
  });

  it("counter real provisional payload remains allowed but privileged identity fields are denied", async () => {
    const counterDb = dbFor(COUNTER);
    await assertSucceeds(
      setDoc(
        doc(counterDb, ...businessDoc("products", "real-provisional")),
        realProvisionalProduct,
      ),
    );

    const privilegedVariants = [
      { unitCost: 125 },
      { aliases: ["012345678905"] },
      { provenanceTier: "human_verified" },
      { source: "human_review" },
      { createdBy: "human" },
      { updatedBy: "human" },
      { structuredBy: "human" },
      { status: "archived" },
    ];
    for (const [index, privileged] of privilegedVariants.entries()) {
      await assertFails(
        setDoc(
          doc(counterDb, ...businessDoc("products", `privileged-${index}`)),
          { ...realProvisionalProduct, id: `privileged-${index}`, ...privileged },
        ),
      );
    }
  });

  it("counter creates only their own active session", async () => {
    const counterDb = dbFor(COUNTER);
    await assertSucceeds(
      setDoc(
        doc(counterDb, ...businessDoc("countSessions", "new-counter-active")),
        activeSession(COUNTER, "new-counter-active"),
      ),
    );
    await assertFails(
      setDoc(doc(counterDb, ...businessDoc("countSessions", "created-for-other")), {
        ...activeSession(OTHER_COUNTER, "created-for-other"),
      }),
    );
    await assertFails(
      setDoc(doc(counterDb, ...businessDoc("countSessions", "created-completed")), {
        ...activeSession(COUNTER, "created-completed"),
        status: "completed",
        completedAt: "2026-07-26T13:00:00.000Z",
      }),
    );
    await assertFails(
      setDoc(doc(counterDb, ...businessDoc("countSessions", "active-with-completed-at")), {
        ...activeSession(COUNTER, "active-with-completed-at"),
        completedAt: "2026-07-26T13:00:00.000Z",
      }),
    );
    await assertFails(
      setDoc(doc(counterDb, ...businessDoc("countSessions", "created-locked")), {
        ...activeSession(COUNTER, "created-locked"),
        locked: true,
        lockedAt: "2026-07-26T12:30:00.000Z",
      }),
    );
  });

  it("counter may update and complete only their own currently active session", async () => {
    const counterDb = dbFor(COUNTER);
    await assertSucceeds(
      updateDoc(doc(counterDb, ...businessDoc("countSessions", "counter-active")), {
        notes: "Aisle 2 complete",
      }),
    );
    await assertSucceeds(
      setDoc(doc(counterDb, ...businessDoc("countSessions", "counter-active")), {
        ...activeSession(COUNTER),
        status: "completed",
        completedAt: "2026-07-26T13:00:00.000Z",
        updatedAt: serverTimestamp(),
      }, { merge: true }),
    );
    await assertFails(
      updateDoc(doc(counterDb, ...businessDoc("countSessions", "other-counter-active")), {
        notes: "Unauthorized edit",
      }),
    );
    await assertFails(
      updateDoc(doc(counterDb, ...businessDoc("countSessions", "counter-completed")), {
        notes: "Cannot administer completed sessions",
      }),
    );
  });

  it("counter cannot transfer ownership, use owner lock controls, or reopen a completed session", async () => {
    const counterDb = dbFor(COUNTER);
    await assertFails(
      updateDoc(doc(counterDb, ...businessDoc("countSessions", "counter-active")), {
        createdBy: OTHER_COUNTER,
      }),
    );
    await assertFails(
      updateDoc(doc(counterDb, ...businessDoc("countSessions", "counter-active")), {
        locked: true,
        lockedAt: "2026-07-26T12:30:00.000Z",
      }),
    );
    await assertFails(
      updateDoc(doc(counterDb, ...businessDoc("countSessions", "counter-completed")), {
        status: "active",
        completedAt: null,
      }),
    );
    await assertFails(
      updateDoc(doc(counterDb, ...businessDoc("countSessions", "counter-locked")), {
        notes: "Locked sessions are immutable to counters",
      }),
    );
  });

  it("counter creates scan events only for their own active unlocked session", async () => {
    const counterDb = dbFor(COUNTER);
    const event = {
      id: "counter-event",
      businessId: BIZ,
      sessionId: "counter-active",
      rawCode: "012345678905",
      cleanCode: "012345678905",
      matchedProductId: "counter-provisional",
      quantityDelta: 1,
    };
    await assertSucceeds(
      setDoc(doc(counterDb, ...businessDoc("scanEvents", "counter-event")), event),
    );
    await assertFails(
      setDoc(doc(counterDb, ...businessDoc("scanEvents", "other-event")), {
        ...event,
        id: "other-event",
        sessionId: "other-counter-active",
      }),
    );
    await assertFails(
      setDoc(doc(counterDb, ...businessDoc("scanEvents", "completed-event")), {
        ...event,
        id: "completed-event",
        sessionId: "counter-completed",
      }),
    );
    await assertFails(
      setDoc(doc(counterDb, ...businessDoc("scanEvents", "locked-event")), {
        ...event,
        id: "locked-event",
        sessionId: "counter-locked",
      }),
    );
  });

  it("counter cannot create or update counts without a paired applied marker", async () => {
    const counterDb = dbFor(COUNTER);
    const count = {
      businessId: BIZ,
      countSessionId: "counter-active",
      productId: "counter-provisional",
      countedQuantity: 1,
      scanEventIds: ["counter-event"],
      appliedKeyId: "missing-create-marker",
      lastQuantityDelta: 1,
      lastScanEventId: "counter-event",
      updatedAt: serverTimestamp(),
    };
    await assertFails(
      setDoc(
        doc(counterDb, ...businessDoc("inventoryCounts", "counter-active_counter-provisional")),
        count,
      ),
    );
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), ...businessDoc("inventoryCounts", "counter-active_counter-provisional")),
        count,
      );
    });
    await assertFails(
      updateDoc(
        doc(counterDb, ...businessDoc("inventoryCounts", "counter-active_counter-provisional")),
        {
          countedQuantity: 2,
          scanEventIds: ["counter-event", "counter-event-2"],
          appliedKeyId: "missing-update-marker",
          lastQuantityDelta: 1,
          lastScanEventId: "counter-event-2",
          updatedAt: serverTimestamp(),
        },
      ),
    );
    await assertFails(
      setDoc(
        doc(
          counterDb,
          ...businessDoc("inventoryCounts", "other-counter-active_counter-provisional"),
        ),
        { ...count, countSessionId: "other-counter-active" },
      ),
    );
    await assertFails(
      setDoc(
        doc(counterDb, ...businessDoc("inventoryCounts", "counter-completed_counter-provisional")),
        { ...count, countSessionId: "counter-completed" },
      ),
    );
    await assertFails(
      setDoc(
        doc(counterDb, ...businessDoc("inventoryCounts", "counter-locked_counter-provisional")),
        { ...count, countSessionId: "counter-locked" },
      ),
    );
    await assertFails(
      updateDoc(
        doc(counterDb, ...businessDoc("inventoryCounts", "counter-active_counter-provisional")),
        { countSessionId: "other-counter-active" },
      ),
    );
  });

  it("counter cannot pre-seed an applied marker without its corresponding entity write", async () => {
    const counterDb = dbFor(COUNTER);
    await assertFails(
      setDoc(doc(counterDb, ...businessDoc("_appliedKeys", "forged-marker")), {
        businessId: BIZ,
        operation: "SAVE_SCAN_EVENT",
        entityType: "ScanEvent",
        entityId: "forged-event",
        sessionId: "counter-active",
        targetId: "forged-event",
        scanEventId: "forged-event",
        payloadHash: "forged-payload-hash",
        at: serverTimestamp(),
      }),
    );
    await assertFails(
      setDoc(doc(counterDb, ...businessDoc("_appliedKeys", "forged-existing-session")), {
        businessId: BIZ,
        operation: "SAVE_SESSION",
        entityType: "CountSession",
        entityId: "counter-active",
        sessionId: "counter-active",
        targetId: "counter-active",
        scanEventId: null,
        payloadHash: "forged-payload-hash",
        at: serverTimestamp(),
      }),
    );
  });

  it("counter count ledger rejects forged paired quantity, list, and marker-identity rewrites", async () => {
    const counterDb = dbFor(COUNTER);
    const target = new FirebaseSyncTarget(counterDb as unknown as Firestore, { emulator: true });
    const countId = "counter-active_counter-provisional";
    const countRef = doc(counterDb, ...businessDoc("inventoryCounts", countId));
    await assertSucceeds(
      setDoc(doc(counterDb, ...businessDoc("scanEvents", "ledger-event-1")), {
        id: "ledger-event-1",
        businessId: BIZ,
        sessionId: "counter-active",
        matchedProductId: "counter-provisional",
        quantityDelta: 1,
      }),
    );
    const initial = syncItem({
      businessId: BIZ,
      sessionId: "counter-active",
      entityType: "InventoryCount",
      entityId: countId,
      operation: "INCREMENT_COUNT",
      payload: {
        businessId: BIZ,
        sessionId: "counter-active",
        productId: "counter-provisional",
        scanEventId: "ledger-event-1",
        quantityDelta: 1,
        idempotencyKey: "ledger-initial",
      },
      idempotencyKey: "ledger-initial",
      scanEventId: "ledger-event-1",
    });
    await expect(target.apply(initial)).resolves.toMatchObject({ ok: true, alreadyApplied: false });
    await assertSucceeds(
      setDoc(doc(counterDb, ...businessDoc("scanEvents", "ledger-event-2")), {
        id: "ledger-event-2",
        businessId: BIZ,
        sessionId: "counter-active",
        matchedProductId: "counter-provisional",
        quantityDelta: 1,
      }),
    );

    const pairedAttack = (
      key: string,
      markerScanEventId: string,
      countScanEventId: string,
      countedQuantity: number,
      lastQuantityDelta: number,
      scanEventIds: string[],
    ) => {
      const batch = writeBatch(counterDb);
      batch.set(doc(counterDb, ...businessDoc("_appliedKeys", key)), {
        businessId: BIZ,
        entityType: "InventoryCount",
        entityId: countId,
        sessionId: "counter-active",
        targetId: countId,
        operation: "INCREMENT_COUNT",
        scanEventId: markerScanEventId,
        payloadHash: `hash-${key}`,
        at: serverTimestamp(),
      });
      batch.update(countRef, {
        countedQuantity,
        scanEventIds,
        appliedKeyId: key,
        lastQuantityDelta,
        lastScanEventId: countScanEventId,
        updatedAt: serverTimestamp(),
      });
      return batch.commit();
    };

    await assertFails(
      pairedAttack(
        "forged-quantity",
        "ledger-event-2",
        "ledger-event-2",
        99,
        1,
        ["ledger-event-1", "ledger-event-2"],
      ),
    );
    await assertFails(
      pairedAttack(
        "forged-list",
        "ledger-event-2",
        "ledger-event-2",
        2,
        1,
        ["ledger-event-2"],
      ),
    );
    await assertFails(
      pairedAttack(
        "forged-identity",
        "different-event",
        "ledger-event-2",
        2,
        1,
        ["ledger-event-1", "ledger-event-2"],
      ),
    );
  });

  it("counter count ledger rejects missing scans, mismatched products, and non-unit deltas", async () => {
    const counterDb = dbFor(COUNTER);
    await assertSucceeds(
      setDoc(doc(counterDb, ...businessDoc("scanEvents", "wrong-product-event")), {
        id: "wrong-product-event",
        businessId: BIZ,
        sessionId: "counter-active",
        matchedProductId: "trusted-product",
        quantityDelta: 1,
      }),
    );
    await assertSucceeds(
      setDoc(doc(counterDb, ...businessDoc("scanEvents", "unit-event")), {
        id: "unit-event",
        businessId: BIZ,
        sessionId: "counter-active",
        matchedProductId: "counter-provisional",
        quantityDelta: 1,
      }),
    );

    const forgedCreate = (key: string, scanEventId: string, quantityDelta: number) => {
      const countId = "counter-active_counter-provisional";
      const batch = writeBatch(counterDb);
      batch.set(doc(counterDb, ...businessDoc("_appliedKeys", key)), {
        businessId: BIZ,
        entityType: "InventoryCount",
        entityId: countId,
        sessionId: "counter-active",
        targetId: countId,
        operation: "INCREMENT_COUNT",
        scanEventId,
        payloadHash: `hash-${key}`,
        at: serverTimestamp(),
      });
      batch.set(doc(counterDb, ...businessDoc("inventoryCounts", countId)), {
        businessId: BIZ,
        countSessionId: "counter-active",
        productId: "counter-provisional",
        countedQuantity: quantityDelta,
        scanEventIds: [scanEventId],
        appliedKeyId: key,
        lastQuantityDelta: quantityDelta,
        lastScanEventId: scanEventId,
        updatedAt: serverTimestamp(),
      });
      return batch.commit();
    };

    await assertFails(forgedCreate("missing-scan", "missing-event", 1));
    await assertFails(forgedCreate("wrong-product", "wrong-product-event", 1));
    await assertFails(forgedCreate("oversized-delta", "unit-event", 1_000_000));
    await assertFails(forgedCreate("negative-delta", "unit-event", -1));
  });

  it("counter count ledger permits exact increments and duplicate-event zero-delta metadata writes", async () => {
    const counterDb = dbFor(COUNTER);
    const target = new FirebaseSyncTarget(counterDb as unknown as Firestore, { emulator: true });
    const countId = "counter-active_counter-provisional";
    const increment = (key: string, scanEventId: string) =>
      syncItem({
        businessId: BIZ,
        sessionId: "counter-active",
        entityType: "InventoryCount",
        entityId: countId,
        operation: "INCREMENT_COUNT",
        payload: {
          businessId: BIZ,
          sessionId: "counter-active",
          productId: "counter-provisional",
          scanEventId,
          quantityDelta: 1,
          idempotencyKey: key,
        },
        idempotencyKey: key,
        scanEventId,
      });

    await assertSucceeds(
      setDoc(doc(counterDb, ...businessDoc("scanEvents", "ledger-valid-event")), {
        id: "ledger-valid-event",
        businessId: BIZ,
        sessionId: "counter-active",
        matchedProductId: "counter-provisional",
        quantityDelta: 1,
      }),
    );
    await expect(target.apply(increment("ledger-valid-1", "ledger-valid-event"))).resolves.toMatchObject({
      ok: true,
      alreadyApplied: false,
    });
    await expect(target.apply(increment("ledger-valid-2", "ledger-valid-event"))).resolves.toMatchObject({
      ok: true,
      alreadyApplied: false,
    });

    const count = await getDoc(
      doc(counterDb, ...businessDoc("inventoryCounts", countId)),
    );
    expect(count.data()).toMatchObject({
      countedQuantity: 1,
      scanEventIds: ["ledger-valid-event"],
      appliedKeyId: "ledger-valid-2",
      lastQuantityDelta: 0,
      lastScanEventId: "ledger-valid-event",
    });
  });

  it("counter Firebase transaction atomically binds every allowed marker to its target write", async () => {
    const target = new FirebaseSyncTarget(
      dbFor(COUNTER) as unknown as Firestore,
      { emulator: true },
    );
    const sessionId = "counter-sync-session";
    const session = activeSession(COUNTER, sessionId);
    await expect(
      target.apply(
        syncItem({
          businessId: BIZ,
          sessionId,
          entityType: "CountSession",
          entityId: sessionId,
          operation: "SAVE_SESSION",
          payload: session,
          idempotencyKey: "counter-sync-session-save",
          scanEventId: null,
        }),
      ),
    ).resolves.toMatchObject({ ok: true, alreadyApplied: false });

    const productId = "counter-sync-product";
    const product = { ...realProvisionalProduct, id: productId };
    await expect(
      target.apply(
        syncItem({
          businessId: BIZ,
          sessionId,
          entityType: "Product",
          entityId: productId,
          operation: "SAVE_PRODUCT",
          payload: product,
          idempotencyKey: "counter-sync-product-save",
          scanEventId: null,
        }),
      ),
    ).resolves.toMatchObject({ ok: true, alreadyApplied: false });

    const scanEventId = "counter-sync-event";
    const event = {
      id: scanEventId,
      businessId: BIZ,
      sessionId,
      rawCode: "012345678905",
      cleanCode: "012345678905",
      matchedProductId: productId,
      quantityDelta: 1,
      createdAt: "2026-07-26T20:00:00.000Z",
    };
    await expect(
      target.apply(
        syncItem({
          businessId: BIZ,
          sessionId,
          entityType: "ScanEvent",
          entityId: scanEventId,
          operation: "SAVE_SCAN_EVENT",
          payload: event,
          idempotencyKey: "counter-sync-event-save",
          scanEventId,
        }),
      ),
    ).resolves.toMatchObject({ ok: true, alreadyApplied: false });

    const reviewId = "counter-sync-review";
    await expect(
      target.apply(
        syncItem({
          businessId: BIZ,
          sessionId,
          entityType: "UnknownCodeReview",
          entityId: reviewId,
          operation: "SAVE_UNKNOWN_SCAN",
          payload: {
            id: reviewId,
            businessId: BIZ,
            sessionId,
            cleanCode: "012345678905",
          },
          idempotencyKey: "counter-sync-review-save",
          scanEventId,
        }),
      ),
    ).resolves.toMatchObject({ ok: true, alreadyApplied: false });

    await expect(
      target.apply(
        syncItem({
          businessId: BIZ,
          sessionId,
          entityType: "InventoryCount",
          entityId: `${sessionId}_${productId}`,
          operation: "INCREMENT_COUNT",
          payload: {
            businessId: BIZ,
            sessionId,
            productId,
            scanEventId,
            quantityDelta: 1,
            idempotencyKey: "counter-sync-count",
          },
          idempotencyKey: "counter-sync-count",
          scanEventId,
        }),
      ),
    ).resolves.toMatchObject({ ok: true, alreadyApplied: false });
  });

  it("viewer receives none of the counter write permissions", async () => {
    const viewerDb = dbFor(VIEWER);
    await assertFails(
      setDoc(
        doc(viewerDb, ...businessDoc("products", "viewer-provisional")),
        { ...provisionalProduct, id: "viewer-provisional" },
      ),
    );
    await assertFails(
      setDoc(
        doc(viewerDb, ...businessDoc("countSessions", "viewer-session")),
        activeSession(VIEWER),
      ),
    );
  });
});
