import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, setDoc, type Firestore } from "firebase/firestore";
import { readFileSync } from "node:fs";
import { FirebaseSyncTarget } from "@/services/db/firebase/firebaseSyncTarget";
import { loadBusinessData } from "@/services/db/firebase/businessDataLoader";
import { parseCsv, buildProductImport } from "@/import/csvImport";
import type { PendingSyncItem, Product, Alias } from "@/types";

// Loop 5 proof (emulator): a CSV import's products + approved aliases persist to Firestore through the
// durable queue (SAVE_PRODUCT + RESOLVE_ALIAS), are read back by loadBusinessData, and respect the
// business boundary (a non-member cannot read them). Emulator only.

const HOSTPORT = process.env.FIRESTORE_EMULATOR_HOST || "";
const ready = HOSTPORT.includes(":");
const UID = "importUser";
const BIZ = "bizImport";

let n = 0;
const idFactory = () => `imp${++n}`;
const now = () => "2026-06-15T10:00:00.000Z";

function saveProductItem(p: Product): PendingSyncItem {
  return { id: p.id, businessId: BIZ, sessionId: "s1", entityType: "Product", entityId: p.id, operation: "SAVE_PRODUCT", payload: p, status: "pending", retryCount: 0, lastError: null, createdAt: "t", updatedAt: "t", idempotencyKey: `prod:${p.id}`, scanEventId: null };
}
function resolveAliasItem(a: Alias): PendingSyncItem {
  return { id: a.id, businessId: BIZ, sessionId: "s1", entityType: "Alias", entityId: a.id, operation: "RESOLVE_ALIAS", payload: a, status: "pending", retryCount: 0, lastError: null, createdAt: "t", updatedAt: "t", idempotencyKey: a.idempotencyKey, scanEventId: null };
}

describe.skipIf(!ready)("Loop 5 CSV import durable path (emulator)", () => {
  let env: RulesTestEnvironment;
  const target = () => new FirebaseSyncTarget(env.authenticatedContext(UID).firestore() as unknown as Firestore, { emulator: true });

  beforeAll(async () => {
    const [host, port] = HOSTPORT.split(":");
    env = await initializeTestEnvironment({ projectId: "demo-inv-import", firestore: { rules: readFileSync("firestore.rules", "utf8"), host, port: Number(port) } });
  });
  afterAll(async () => { if (env) await env.cleanup(); });
  beforeEach(async () => {
    n = 0;
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "businesses", BIZ), { name: "Import Co", createdBy: UID });
      await setDoc(doc(db, "businessMembers", `${BIZ}_${UID}`), { businessId: BIZ, userId: UID, role: "owner" });
    });
  });

  it("imports products + approved aliases that persist and read back; non-member is denied", async () => {
    const { rows } = parseCsv("name,sku,barcode\nNokian Tire,T432119,6419440485331\nCoke,,049000050103");
    const plan = buildProductImport({ rows, existingProducts: [], existingAliases: [], businessId: BIZ, idFactory, now });
    expect(plan.products).toHaveLength(2);
    expect(plan.aliases).toHaveLength(3);

    const t = target();
    for (const p of plan.products) expect((await t.apply(saveProductItem(p))).ok).toBe(true);
    for (const a of plan.aliases) expect((await t.apply(resolveAliasItem(a))).ok).toBe(true);

    const db = env.authenticatedContext(UID).firestore() as unknown as Firestore;
    const loaded = await loadBusinessData(db, BIZ);
    expect(loaded.products.map((p) => p.name).sort()).toEqual(["Coke", "Nokian Tire"]);
    expect(loaded.aliases.map((a) => a.cleanCode).sort()).toEqual(["049000050103", "6419440485331", "T432119"]);
    expect(loaded.aliases.every((a) => a.approved)).toBe(true);

    const stranger = env.authenticatedContext("stranger").firestore() as unknown as Firestore;
    await expect(loadBusinessData(stranger, BIZ)).rejects.toBeTruthy();
  });
});
