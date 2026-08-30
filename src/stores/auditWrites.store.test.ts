import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import type { SyncTarget } from "@/services/db/syncTarget";
import type { SyncResult } from "@/services/mockDb";
import type { InventoryCount, InventorySession } from "@/types";
import type { AuditEventInput } from "@/users-businesses/account/audit";

// Loop 6 proof (store logic): important actions emit a business-scoped, fire-and-forget audit event
// through the injectable sink, with a REAL business context (no fake businessId/actor). An audit
// failure must NEVER break the scanner or any action. Real Firestore append-only + RLS are proven
// separately by audit.rules.test.ts (emulator).

class FakeAsyncTarget implements SyncTarget {
  async apply(): Promise<SyncResult> {
    await Promise.resolve();
    return { ok: true, alreadyApplied: false };
  }
  setFailure() {}
  reset() {}
}

const flush = async () => { await new Promise((r) => setTimeout(r, 0)); };
const emptyLoader = async () => ({ products: [], aliases: [], sessions: [] as InventorySession[], counts: [] as InventoryCount[] });

function cloudStoreWithAudit(audit: (e: AuditEventInput) => void) {
  return createTestScanStore({ db: new FakeAsyncTarget(), cloudBackend: true, loadBusinessData: emptyLoader, audit });
}

describe("Loop 6 audit writes (store)", () => {
  it("emits session_started and session_completed, business-scoped with the real actor", async () => {
    const events: AuditEventInput[] = [];
    const store = cloudStoreWithAudit((e) => events.push(e));
    store.getState().setBusinessContext("biz-a", "user-a");
    await flush();

    store.getState().startSession("Count A", "Bay 1");
    store.getState().finishSession();

    const actions = events.map((e) => e.action);
    expect(actions).toContain("session_started");
    expect(actions).toContain("session_completed");
    for (const e of events) {
      expect(e.businessId).toBe("biz-a");
      expect(e.actorUserId).toBe("user-a"); // real actor, never a fake/default
    }
  });

  it("emits unknown_review_created, then alias_approved + product_created on resolve, and alias_rejected on ignore", async () => {
    const events: AuditEventInput[] = [];
    const store = cloudStoreWithAudit((e) => events.push(e));
    store.getState().setBusinessContext("biz-a", "user-a");
    await flush();

    store.getState().processScan("999999999999"); // unknown -> creates a review
    const review = store.getState().needsReviewQueue.find((r) => r.status === "open")!;
    expect(events.map((e) => e.action)).toContain("unknown_review_created");

    store.getState().resolveUnknown(review.id, "create_new", { newProduct: { name: "Mystery Widget" }, applyToCount: false });
    const actions = events.map((e) => e.action);
    expect(actions).toContain("product_created");
    expect(actions).toContain("alias_approved");

    // A second unknown -> ignore -> alias_rejected.
    store.getState().processScan("888888888888");
    const r2 = store.getState().needsReviewQueue.find((r) => r.cleanCode === "888888888888" && r.status === "open")!;
    store.getState().resolveUnknown(r2.id, "ignore", {});
    expect(events.map((e) => e.action)).toContain("alias_rejected");
  });

  it("emits NOTHING without a real business context (no fake-context audit)", () => {
    const events: AuditEventInput[] = [];
    // cloud backend, but setBusinessContext NOT called -> no userId yet.
    const store = createTestScanStore({ db: new FakeAsyncTarget(), cloudBackend: true, loadBusinessData: emptyLoader, audit: (e) => events.push(e) });
    store.getState().startSession("No Context", "Main");
    expect(events).toHaveLength(0);
  });

  it("a thrown audit error NEVER breaks the scanner or the action", async () => {
    const store = cloudStoreWithAudit(() => { throw new Error("audit backend down"); });
    store.getState().setBusinessContext("biz-a", "user-a");
    await flush();

    // startSession still works despite the audit sink throwing.
    expect(() => store.getState().startSession("Resilient", "Main")).not.toThrow();
    expect(store.getState().currentSession?.name).toBe("Resilient");

    // An unknown scan (which emits unknown_review_created) still creates the review and returns the event.
    const ev = store.getState().processScan("777777777777");
    expect(ev).not.toBeNull();
    expect(store.getState().needsReviewQueue.some((r) => r.cleanCode === "777777777777")).toBe(true);
  });

  it("the mock/default path does not audit (no sink wired)", () => {
    const store = createTestScanStore(); // mock, no audit dep
    expect(() => {
      store.getState().startSession("Local", "Main");
      store.getState().processScan("999999999999");
    }).not.toThrow();
  });
});
