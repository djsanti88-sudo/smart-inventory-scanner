import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, deleteDoc, setDoc, updateDoc, type Firestore } from "firebase/firestore";
import { readFileSync } from "node:fs";
import { auditRepository } from "@/sync-database/cloud/repositories";
import { toAuditEvent } from "@/users-businesses/account/audit";

// Loop 6 proof (emulator): the auditLog is append-only and business-scoped. A member can append +
// (owner/admin) read; updates/deletes are denied by rules; a stranger cannot read another business's
// audit; and a member of business A cannot write into business B's auditLog. Emulator only.

const HOSTPORT = process.env.FIRESTORE_EMULATOR_HOST || "";
const ready = HOSTPORT.includes(":");
const UID = "auditOwner";
const BIZ = "bizAudit";
const OTHER = "bizAuditOther";

describe.skipIf(!ready)("Loop 6 audit writes (emulator)", () => {
  let env: RulesTestEnvironment;

  beforeAll(async () => {
    const [host, port] = HOSTPORT.split(":");
    env = await initializeTestEnvironment({ projectId: "demo-inv-audit", firestore: { rules: readFileSync("firestore.rules", "utf8"), host, port: Number(port) } });
  });
  afterAll(async () => { if (env) await env.cleanup(); });
  beforeEach(async () => {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "businesses", BIZ), { name: "Audit Co", createdBy: UID });
      await setDoc(doc(db, "businessMembers", `${BIZ}_${UID}`), { businessId: BIZ, userId: UID, role: "owner" });
      await setDoc(doc(db, "businesses", OTHER), { name: "Other Co", createdBy: "otherOwner" });
      await setDoc(doc(db, "businessMembers", `${OTHER}_otherOwner`), { businessId: OTHER, userId: "otherOwner", role: "owner" });
    });
  });

  it("a member appends an audit event and an owner reads it back; it is business-scoped", async () => {
    const db = env.authenticatedContext(UID).firestore() as unknown as Firestore;
    const repo = auditRepository(db, BIZ);
    await repo.append(toAuditEvent({ businessId: BIZ, actorUserId: UID, entityType: "CountSession", entityId: "s1", action: "session_started" }, "evt-1"));
    const list = await repo.list();
    expect(list.some((e) => e.id === "evt-1" && e.action === "session_started")).toBe(true);
    expect(list.every((e) => e.businessId === BIZ)).toBe(true);
  });

  it("the auditLog is append-only: update and delete are denied", async () => {
    const db = env.authenticatedContext(UID).firestore() as unknown as Firestore;
    await auditRepository(db, BIZ).append(toAuditEvent({ businessId: BIZ, actorUserId: UID, entityType: "Alias", entityId: "a1", action: "alias_approved" }, "evt-2"));
    const ref = doc(db, "businesses", BIZ, "auditLog", "evt-2");
    await expect(updateDoc(ref, { action: "tampered" })).rejects.toBeTruthy();
    await expect(deleteDoc(ref)).rejects.toBeTruthy();
  });

  it("a non-member cannot read the business's auditLog (RLS)", async () => {
    await auditRepository(env.authenticatedContext(UID).firestore() as unknown as Firestore, BIZ)
      .append(toAuditEvent({ businessId: BIZ, actorUserId: UID, entityType: "CountSession", entityId: "s1", action: "session_started" }, "evt-3"));
    const stranger = env.authenticatedContext("stranger").firestore() as unknown as Firestore;
    await expect(auditRepository(stranger, BIZ).list()).rejects.toBeTruthy();
  });

  it("a member of business A cannot write into business B's auditLog", async () => {
    // UID is a member of BIZ only. Writing into OTHER's auditLog must be denied.
    const db = env.authenticatedContext(UID).firestore() as unknown as Firestore;
    await expect(
      auditRepository(db, OTHER).append(toAuditEvent({ businessId: OTHER, actorUserId: UID, entityType: "Alias", entityId: "x", action: "alias_approved" }, "evt-cross")),
    ).rejects.toBeTruthy();
  });
});
