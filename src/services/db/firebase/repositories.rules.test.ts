import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, setDoc, type Firestore } from "firebase/firestore";
import { readFileSync } from "node:fs";
import { productsRepository, aliasesRepository } from "@/services/db/firebase/repositories";

// Proves the typed repositories work end-to-end as an authenticated member against the emulator (under
// real rules). Runs only with the Firestore emulator (npm run test:firebase); plain vitest skips.

const HOSTPORT = process.env.FIRESTORE_EMULATOR_HOST || "";
const ready = HOSTPORT.includes(":");
const UID = "repoUser";
const BIZ = "repoBiz";

describe.skipIf(!ready)("Firebase repositories (authenticated, emulator)", () => {
  let env: RulesTestEnvironment;

  beforeAll(async () => {
    const [host, port] = HOSTPORT.split(":");
    // Unique projectId per test file -> isolated emulator namespace (no cross-file clearFirestore races).
    env = await initializeTestEnvironment({
      projectId: "demo-inv-repos",
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
      await setDoc(doc(db, "businesses", BIZ), { name: "Repo Co", createdBy: UID });
      await setDoc(doc(db, "businessMembers", `${BIZ}_${UID}`), { businessId: BIZ, userId: UID, role: "owner" });
    });
  });

  it("productsRepository + aliasesRepository CRUD under businessId", async () => {
    // rules-unit-testing's firestore() and the modular SDK type can skew across versions; cast to the
    // modular Firestore the repos expect (runtime is the same client).
    const db = env.authenticatedContext(UID).firestore() as unknown as Firestore;
    const products = productsRepository(db, BIZ);
    await products.create({ id: "p1", businessId: BIZ, name: "Repo Widget", primaryBarcode: "012345678905", verified: true });
    const list = await products.list();
    expect(list.map((p) => p.name)).toContain("Repo Widget");
    expect((await products.get("p1"))?.businessId).toBe(BIZ);

    const aliases = aliasesRepository(db, BIZ);
    await aliases.create({ id: "a1", businessId: BIZ, productId: "p1", cleanCode: "012345678905", approved: false });
    await aliases.update("a1", { approved: true });
    const al = await aliases.list();
    expect(al.find((a) => a.id === "a1")?.approved).toBe(true);
  });
});
