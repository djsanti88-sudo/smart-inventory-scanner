import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase/firestore";
import type { PendingSyncItem } from "@/types";

const firestoreMocks = vi.hoisted(() => ({
  runTransaction: vi.fn(),
}));

vi.mock("firebase/firestore", () => ({
  collection: vi.fn((...parts: unknown[]) => ({ parts })),
  doc: vi.fn((...parts: unknown[]) => ({ parts })),
  getDocs: vi.fn(),
  orderBy: vi.fn(),
  query: vi.fn(),
  runTransaction: firestoreMocks.runTransaction,
  serverTimestamp: vi.fn(() => "server-time"),
  where: vi.fn(),
}));

vi.mock("@/sync-database/cloud/firebaseSyncSafety", () => ({
  appliedKeyDocumentId: vi.fn(async (key: string) => key),
  canonicalPayloadHash: vi.fn(async () => "payload-hash"),
  validatePendingSyncItem: vi.fn(() => null),
}));

import { FirebaseSyncTarget } from "@/sync-database/cloud/firebaseSyncTarget";

function productItem(): PendingSyncItem {
  return {
    id: "queue-timeout",
    businessId: "business-timeout",
    sessionId: "session-timeout",
    entityType: "Product",
    entityId: "product-timeout",
    operation: "SAVE_PRODUCT",
    payload: { id: "product-timeout", businessId: "business-timeout", name: "Held transaction" },
    status: "pending",
    retryCount: 0,
    lastError: null,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    idempotencyKey: "business-timeout:session-timeout:product-timeout:SAVE_PRODUCT",
    scanEventId: null,
  };
}

describe("FirebaseSyncTarget physical transaction ownership", () => {
  beforeEach(() => {
    firestoreMocks.runTransaction.mockReset();
  });

  it("returns a physical-settlement handle when the logical timeout fires before runTransaction settles", async () => {
    vi.useFakeTimers();
    try {
      let settleTransaction!: (result: { ok: boolean; alreadyApplied: boolean }) => void;
      const transaction = new Promise<{ ok: boolean; alreadyApplied: boolean }>((resolve) => {
        settleTransaction = resolve;
      });
      firestoreMocks.runTransaction.mockReturnValue(transaction);
      const target = new FirebaseSyncTarget({} as Firestore, { emulator: true });

      const resultPromise = target.apply(productItem());
      for (let i = 0; i < 20 && firestoreMocks.runTransaction.mock.calls.length === 0; i += 1) {
        await Promise.resolve();
      }
      expect(firestoreMocks.runTransaction).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(55_001);

      const result = await resultPromise;
      expect(result).toMatchObject({ ok: false, retryable: true });
      const physicalSettlement = (result as typeof result & { physicalSettlement?: Promise<void> }).physicalSettlement;
      expect(physicalSettlement).toBeInstanceOf(Promise);

      let physicallySettled = false;
      void physicalSettlement!.then(() => { physicallySettled = true; });
      await Promise.resolve();
      expect(physicallySettled).toBe(false);

      settleTransaction({ ok: true, alreadyApplied: false });
      await physicalSettlement;
      expect(physicallySettled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
