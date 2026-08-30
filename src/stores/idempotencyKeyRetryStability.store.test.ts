import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import type { SyncTarget } from "@/sync-database/syncTarget";
import type { SyncResult } from "@/sync-database/mock/mockDb";
import type { Alias, InventoryCount, InventorySession, PendingSyncItem, Product } from "@/types";

// Regression backstop for the audit finding in
// docs/superpowers/reports/2026-08-12-invariant-audit-counting.md (claim #3): CLAUDE.md and
// GUARDRAILS.md require every ScanEvent's `id` + `idempotencyKey` to be assigned ONCE at scan time
// and reused byte-identical on every retry - never regenerated inside a retry/catch branch. Today
// nothing in the retry code path (drainCloudOnce's erroredItems.set, retrySync) touches those
// fields, so the invariant holds "by omission" with no structural guard or test that would fail if
// a future edit started regenerating the key on retry. A regenerated key defeats server-side
// dedup (`_appliedKeys/{idempotencyKey}`) and can DOUBLE-COUNT a customer's inventory on retry -
// the worst possible failure class for this product. This test proves the SAME PendingSyncItem
// (byte-identical `id`, `entityId`, and `idempotencyKey`) is replayed on every retry attempt,
// across both an automatic drain retry (status "error") and the explicit user-facing Retry action
// (status "quarantined" -> retrySync()).

class FlakyThenOkTarget implements SyncTarget {
  /** How many times apply() has been called per pendingSyncQueue item id. */
  callsByItemId = new Map<string, PendingSyncItem[]>();
  /** Fail this many times (retryable) before finally succeeding, per item id. */
  failuresRemaining: Map<string, number>;
  applied: PendingSyncItem[] = [];

  constructor(failuresPerItem: number) {
    this.failuresRemaining = new Map();
    this.defaultFailures = failuresPerItem;
  }
  private defaultFailures: number;

  async apply(item: PendingSyncItem): Promise<SyncResult> {
    const existing = this.callsByItemId.get(item.id) ?? [];
    existing.push({ ...item });
    this.callsByItemId.set(item.id, existing);

    const remaining = this.failuresRemaining.has(item.id)
      ? this.failuresRemaining.get(item.id)!
      : this.defaultFailures;

    if (remaining > 0) {
      this.failuresRemaining.set(item.id, remaining - 1);
      return {
        ok: false,
        alreadyApplied: false,
        errorCode: "unavailable",
        error: "simulated transient failure",
        retryable: true,
      };
    }
    this.applied.push(item);
    return { ok: true, alreadyApplied: false };
  }
  setFailure() {}
  reset() {}
}

const CODE = "444555666777";
const product = {
  id: "p-idem", businessId: "biz-idem", name: "Idempotency Widget", brand: "", category: "", specsShort: "",
  specsFull: "", primarySku: "", primaryBarcode: CODE, gtin: "", upc: "", ean: "", vendorCodes: [],
  aliases: [CODE], imageUrl: "", productUrl: "", location: "", notes: "", status: "active", source: "manual",
  confidence: 1, verified: true, createdAt: "t", updatedAt: "t", createdBy: "human", updatedBy: "human",
} as Product;
const alias = {
  id: "a-idem", businessId: "biz-idem", productId: "p-idem", rawCodeExample: CODE, cleanCode: CODE,
  normalizedCode: CODE, aliasType: "barcode", source: "manual", confidence: 1, approved: true, createdAt: "t",
  updatedAt: "t", createdBy: "human", lastSeenAt: "t", syncStatus: "synced", idempotencyKey: "k",
} as Alias;

const loader = async () => ({ products: [product], aliases: [alias], sessions: [] as InventorySession[], counts: [] as InventoryCount[] });

/** Every recorded attempt for one queue item must carry the SAME id/entityId/idempotencyKey. */
function assertStableAcrossAttempts(attempts: PendingSyncItem[]) {
  expect(attempts.length).toBeGreaterThan(1); // otherwise this proves nothing about retry stability
  const first = attempts[0];
  for (const attempt of attempts) {
    expect(attempt.id).toBe(first.id);
    expect(attempt.entityId).toBe(first.entityId);
    expect(attempt.idempotencyKey).toBe(first.idempotencyKey);
  }
}

describe("idempotencyKey/id stability across retries (regression backstop)", () => {
  it("replays byte-identical id + idempotencyKey across an automatic retryable-error retry", async () => {
    const target = new FlakyThenOkTarget(2); // fail twice (retryable), then succeed
    const store = createTestScanStore({ db: target, cloudBackend: true, loadBusinessData: loader });
    store.getState().setBusinessContext("biz-idem", "user-idem");
    await new Promise((r) => setTimeout(r, 20));

    store.getState().processScan(CODE);
    await new Promise((r) => setTimeout(r, 50));

    // Still counted locally regardless of sync outcome (TOP-LEVEL LAW: the scan already counted).
    expect(store.getState().finalCounts.find((c) => c.productId === "p-idem")?.quantity).toBe(1);

    // Automatic drains (an online toggle here) retry "error" items without any explicit user action.
    // Drive enough toggles to exhaust the configured failures and land the item (bounded loop so a
    // regression that never converges fails the test instead of hanging).
    for (let i = 0; i < 6 && store.getState().pendingSyncQueue.length > 0; i++) {
      store.getState().setOnline(false);
      store.getState().setOnline(true);
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(store.getState().pendingSyncQueue).toHaveLength(0);
    expect(store.getState().finalCounts.find((c) => c.productId === "p-idem")?.quantity).toBe(1);
    expect(target.applied.length).toBeGreaterThan(0);

    // The core assertion: every item that was retried must have been called with a byte-identical
    // id/entityId/idempotencyKey on every attempt, not a freshly minted one.
    let checkedAtLeastOneMultiAttemptItem = false;
    for (const attempts of target.callsByItemId.values()) {
      if (attempts.length > 1) {
        checkedAtLeastOneMultiAttemptItem = true;
        assertStableAcrossAttempts(attempts);
      }
    }
    expect(checkedAtLeastOneMultiAttemptItem).toBe(true);
  });

  it("replays byte-identical id + idempotencyKey through the explicit quarantined retrySync() path", async () => {
    const target = new FlakyThenOkTarget(0);
    // First call for every item is a terminal (non-retryable) failure -> quarantined; after that,
    // FlakyThenOkTarget's normal flaky behavior no longer applies since we override apply() below.
    let denyOnce = true;
    const originalApply = target.apply.bind(target);
    target.apply = async (item: PendingSyncItem): Promise<SyncResult> => {
      const existing = target.callsByItemId.get(item.id) ?? [];
      existing.push({ ...item });
      target.callsByItemId.set(item.id, existing);
      if (denyOnce) {
        return {
          ok: false,
          alreadyApplied: false,
          errorCode: "permission_denied",
          error: "PERMISSION_DENIED",
          retryable: false,
        };
      }
      target.applied.push(item);
      return { ok: true, alreadyApplied: false };
    };
    void originalApply;

    const store = createTestScanStore({ db: target, cloudBackend: true, loadBusinessData: loader });
    store.getState().setBusinessContext("biz-idem2", "user-idem2");
    await new Promise((r) => setTimeout(r, 20));

    store.getState().processScan(CODE);
    await new Promise((r) => setTimeout(r, 50));

    expect(store.getState().pendingSyncQueue.length).toBeGreaterThan(0);
    expect(store.getState().pendingSyncQueue.every((it) => it.status === "quarantined")).toBe(true);

    // Now the underlying cause is "fixed" server-side, and the user hits the explicit Retry button.
    denyOnce = false;
    store.getState().retrySync();
    await new Promise((r) => setTimeout(r, 50));

    expect(store.getState().pendingSyncQueue).toHaveLength(0);
    expect(target.applied.length).toBeGreaterThan(0);

    let checkedAtLeastOneMultiAttemptItem = false;
    for (const attempts of target.callsByItemId.values()) {
      if (attempts.length > 1) {
        checkedAtLeastOneMultiAttemptItem = true;
        assertStableAcrossAttempts(attempts);
      }
    }
    expect(checkedAtLeastOneMultiAttemptItem).toBe(true);
  });
});
