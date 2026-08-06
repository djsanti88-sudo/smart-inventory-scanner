import { describe, expect, it } from "vitest";
import type { SyncResult } from "@/services/mockDb";
import type { SyncTarget } from "@/services/db/syncTarget";
import { createTestScanStore } from "@/stores/scanStore";
import type { PendingSyncItem } from "@/types";

class RecordingAsyncTarget implements SyncTarget {
  applied: PendingSyncItem[] = [];

  async apply(item: PendingSyncItem): Promise<SyncResult> {
    this.applied.push(item);
    return { ok: true, alreadyApplied: false };
  }

  setFailure() {}
  reset() {}
}

class ControlledAsyncTarget implements SyncTarget {
  applied: PendingSyncItem[] = [];
  private firstStartedResolve!: () => void;
  private firstReleaseResolve!: () => void;
  readonly firstStarted = new Promise<void>((resolve) => {
    this.firstStartedResolve = resolve;
  });
  private readonly firstRelease = new Promise<void>((resolve) => {
    this.firstReleaseResolve = resolve;
  });

  async apply(item: PendingSyncItem): Promise<SyncResult> {
    this.applied.push(item);
    if (this.applied.length === 1) {
      this.firstStartedResolve();
      await this.firstRelease;
    }
    return { ok: true, alreadyApplied: false };
  }

  releaseFirst() {
    this.firstReleaseResolve();
  }

  setFailure() {}
  reset() {}
}

class TerminalFailureTarget implements SyncTarget {
  attempts = 0;

  async apply(): Promise<SyncResult> {
    this.attempts++;
    return {
      ok: false,
      alreadyApplied: false,
      error: "invalid_entity_id: entityId is malformed",
      errorCode: "invalid_entity_id",
      retryable: false,
    };
  }

  setFailure() {}
  reset() {}
}

function pendingItem(id: string, businessId: string): PendingSyncItem {
  return {
    id,
    businessId,
    sessionId: "session-1",
    entityType: "Product",
    entityId: `product-${id}`,
    operation: "SAVE_PRODUCT",
    payload: {
      id: `product-${id}`,
      businessId,
      name: `Product ${id}`,
      verified: false,
    },
    status: "pending",
    retryCount: 0,
    lastError: null,
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:00.000Z",
    idempotencyKey: `${businessId}:session-1:product-${id}:SAVE_PRODUCT`,
    scanEventId: null,
  };
}

const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("cloud pending queue tenant isolation", () => {
  it("preserves persisted foreign-business work when the same tenant context resolves again", async () => {
    const target = new RecordingAsyncTarget();
    const store = createTestScanStore({ db: target, cloudBackend: true });
    store.getState().setBusinessContext("business-1", "user-1");
    await flush();

    store.setState({ pendingSyncQueue: [pendingItem("foreign", "business-2")] });
    store.getState().setBusinessContext("business-1", "user-1");
    await flush();

    expect(target.applied).toEqual([]);
    expect(store.getState().pendingSyncQueue.map((item) => item.id)).toEqual(["foreign"]);
  });

  it("checks tenant ownership at the cloud drain boundary without deleting the foreign partition", async () => {
    const target = new RecordingAsyncTarget();
    const store = createTestScanStore({ db: target, cloudBackend: true });
    store.getState().setBusinessContext("business-1", "user-1");
    await flush();

    store.setState({ pendingSyncQueue: [pendingItem("late-foreign", "business-2")] });
    store.getState().syncPending(true);
    await flush();

    expect(target.applied).toEqual([]);
    expect(store.getState().pendingSyncQueue.map((item) => item.id)).toEqual(["late-foreign"]);
  });

  it("drains same-tenant work while preserving foreign work from a mixed queue", async () => {
    const target = new RecordingAsyncTarget();
    const store = createTestScanStore({ db: target, cloudBackend: true });
    store.getState().setBusinessContext("business-1", "user-1");
    await flush();

    store.setState({
      pendingSyncQueue: [
        pendingItem("mine", "business-1"),
        pendingItem("foreign", "business-2"),
      ],
    });
    store.getState().syncPending(true);
    await flush();

    expect(target.applied.map((item) => item.id)).toEqual(["mine"]);
    expect(store.getState().pendingSyncQueue.map((item) => item.id)).toEqual(["foreign"]);
  });

  it("sign-out accounting drains the active partition but still counts foreign-business work", async () => {
    const target = new RecordingAsyncTarget();
    const store = createTestScanStore({ db: target, cloudBackend: true });
    store.getState().setBusinessContext("business-1", "user-1");
    await flush();

    store.setState({
      pendingSyncQueue: [
        pendingItem("mine-before-signout", "business-1"),
        pendingItem("foreign-before-signout", "business-2"),
      ],
    });

    await expect(store.getState().prepareSignOut()).resolves.toBe(1);
    expect(target.applied.map((item) => item.id)).toEqual(["mine-before-signout"]);
    expect(store.getState().pendingSyncQueue.map((item) => item.id)).toEqual([
      "foreign-before-signout",
    ]);
  });

  it("an in-flight tenant-A drain preserves tenant-B work and stops before applying more A work", async () => {
    const target = new ControlledAsyncTarget();
    const store = createTestScanStore({ db: target, cloudBackend: true });
    store.getState().setBusinessContext("business-a", "user-1");
    await flush();

    store.setState({
      pendingSyncQueue: [
        pendingItem("a-first", "business-a"),
        pendingItem("a-second", "business-a"),
      ],
    });
    store.getState().syncPending(true);
    await target.firstStarted;

    store.getState().setBusinessContext("business-b", "user-1");
    store.setState((state) => ({
      pendingSyncQueue: [...state.pendingSyncQueue, pendingItem("b-new", "business-b")],
    }));
    store.getState().syncPending(true);
    target.releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(target.applied.map((item) => item.id)).toEqual(["a-first", "b-new"]);
    expect(store.getState().pendingSyncQueue.map((item) => item.id)).toEqual(["a-second"]);

    store.getState().setBusinessContext("business-a", "user-1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(target.applied.map((item) => item.id)).toEqual(["a-first", "b-new", "a-second"]);
    expect(store.getState().pendingSyncQueue).toEqual([]);
  });

  it("quarantines non-retryable validation failures; automatic drains skip them forever, but an explicit retrySync re-attempts and re-quarantines", async () => {
    const target = new TerminalFailureTarget();
    const store = createTestScanStore({ db: target, cloudBackend: true });
    store.getState().setBusinessContext("business-1", "user-1");
    await flush();

    store.setState({ pendingSyncQueue: [pendingItem("invalid", "business-1")] });
    store.getState().syncPending(true);
    await flush();

    // Automatic drain: one attempt, item lands in quarantined.
    expect(target.attempts).toBe(1);
    expect(store.getState().pendingSyncQueue).toHaveLength(1);
    expect(store.getState().pendingSyncQueue[0]).toMatchObject({
      id: "invalid",
      status: "quarantined",
      retryCount: 1,
      lastError: "invalid_entity_id: entityId is malformed",
    });

    // Explicit user-facing retry: re-arms the quarantined item and re-attempts it. The target still
    // fails the same terminal way, so it re-quarantines with the same lastError, one more attempt/retry.
    store.getState().retrySync();
    await flush();

    expect(target.attempts).toBe(2);
    expect(store.getState().pendingSyncQueue).toHaveLength(1);
    expect(store.getState().pendingSyncQueue[0]).toMatchObject({
      id: "invalid",
      status: "quarantined",
      retryCount: 2,
      lastError: "invalid_entity_id: entityId is malformed",
    });

    // Flip-flop guard: after re-quarantining, an AUTOMATIC drain must still skip it (no infinite
    // auto-retry of a terminal failure) - attempts stays at 2.
    store.getState().syncPending(true);
    await flush();

    expect(target.attempts).toBe(2);
    expect(store.getState().pendingSyncQueue).toHaveLength(1);
    expect(store.getState().pendingSyncQueue[0]).toMatchObject({
      id: "invalid",
      status: "quarantined",
      retryCount: 2,
      lastError: "invalid_entity_id: entityId is malformed",
    });
  });
});
