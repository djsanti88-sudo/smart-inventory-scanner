import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, setDoc, type Firestore } from "firebase/firestore";
import { readFileSync } from "node:fs";
import { loadBusinessData } from "@/sync-database/cloud/businessDataLoader";

// Loop 4b proof: loadBusinessData reads a business's products + aliases from Firestore (as an authed
// member) and maps them to the local store shapes. Emulator only.

const HOSTPORT = process.env.FIRESTORE_EMULATOR_HOST || "";
const ready = HOSTPORT.includes(":");
const UID = "loaderUser";
const BIZ = "bizLoader";
const OTHER = "bizOther";

describe.skipIf(!ready)("loadBusinessData (emulator)", () => {
  let env: RulesTestEnvironment;

  beforeAll(async () => {
    const [host, port] = HOSTPORT.split(":");
    env = await initializeTestEnvironment({ projectId: "demo-inv-loader", firestore: { rules: readFileSync("firestore.rules", "utf8"), host, port: Number(port) } });
  });
  afterAll(async () => { if (env) await env.cleanup(); });
  beforeEach(async () => {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "businesses", BIZ), { name: "Loader Co", createdBy: UID });
      await setDoc(doc(db, "businessMembers", `${BIZ}_${UID}`), { businessId: BIZ, userId: UID, role: "owner" });
      await setDoc(doc(db, "businesses", BIZ, "products", "p1"), { businessId: BIZ, name: "Loaded Widget", primaryBarcode: "012345678905", verified: true });
      await setDoc(doc(db, "businesses", BIZ, "aliases", "a1"), { businessId: BIZ, productId: "p1", cleanCode: "012345678905", approved: true });
      // a DIFFERENT business's data that must NOT be loaded
      await setDoc(doc(db, "businesses", OTHER, "products", "pX"), { businessId: OTHER, name: "Other Widget" });
    });
  });

  it("loads + maps the business's products and aliases to store shapes", async () => {
    const db = env.authenticatedContext(UID).firestore() as unknown as Firestore;
    const data = await loadBusinessData(db, BIZ);
    expect(data.products.map((p) => p.name)).toEqual(["Loaded Widget"]);
    expect(data.products[0].verified).toBe(true);
    expect(data.products[0].businessId).toBe(BIZ);
    expect(data.aliases).toHaveLength(1);
    expect(data.aliases[0].approved).toBe(true);
    expect(data.aliases[0].cleanCode).toBe("012345678905");
    expect(data.aliases[0].syncStatus).toBe("synced");
  });

  it("a non-member cannot load the business's data (RLS)", async () => {
    const stranger = env.authenticatedContext("stranger").firestore() as unknown as Firestore;
    await expect(loadBusinessData(stranger, BIZ)).rejects.toBeTruthy();
  });
});
